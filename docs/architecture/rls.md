# Row Level Security

## El principio

**La base de datos es la autoridad.** La UI oculta botones, pero un usuario puede llamar
la API directamente, y un atacante no usa la UI. Si una regla de negocio solo existe en un
componente de React, no existe.

Por eso:

1. Toda tabla de negocio tiene `ENABLE ROW LEVEL SECURITY` desde la migración que la crea.
2. La anon key es pública por diseño (`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_*`).
   Publicarla no es un error **porque** RLS decide qué puede leer y escribir. Sin RLS sería
   una fuga de datos completa; con RLS es solo el punto de entrada.
3. La service role key (`SUPABASE_SERVICE_ROLE_KEY`) bypasea RLS. Solo vive en Edge
   Functions y scripts de servidor, nunca en el cliente, y nunca en `.env` de la app.
   Está en `.gitignore` y en la lista de secretos de GitHub.

## Cómo se resuelve el contexto

RLS necesita saber quién es el usuario y a qué organización pertenece. Eso se resuelve con
variables de sesión de PostgreSQL, que Supabase puebla por conexión:

- `auth.uid()` → id del usuario autenticado.
- El contexto de organización viaja en un claim o en una tabla de membresía que las
  políticas consultan. `private.current_organization_id()` encapsula esa lógica para que
  las políticas no repitan el `join`.

Una política de lectura de `finance.sales` tiene la forma:

```sql
create policy sales_select on finance.sales
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.sales.read'))
  );
```

los paréntesis alrededor de `select` no son decorativos. PostgreSQL envuelve una llamada a
función de una política en un `InitPlan` que se evalúa **una vez** por consulta; sin el
`select`, la función se reevalúa por cada fila, y en una tabla con muchas filas eso es la
diferencia entre un índice usado y un escaneo completo.

### Falla cerrada cuando hay varias organizaciones

`private.current_organization_id()` se resuelve en este orden:

1. El contexto explícito de la petición, si lo hay (`app.current_organization_id`).
2. La única organización activa del usuario, **si tiene exactamente una**.
3. `NULL` en cualquier otro caso, incluidas las cuentas en varias organizaciones.

El paso 3 es el importante: cuando hay ambigüedad se devuelve `NULL`, y una política
`organization_id = (select private.current_organization_id())` no coincide con nada
porque `organization_id` no es `NULL`. Ante la duda, el usuario no ve datos en vez de ver
los de todos.

Un usuario en varias organizaciones elige explícitamente con
`private.set_current_organization(id)`, que devuelve `false` si la organización no es de su
propiedad. El contexto se fija por transacción, así que un `set` de una petición no se
arrastra a la siguiente.

### Qué hay en `private`

| Función                          | Para qué                                              |
| -------------------------------- | ----------------------------------------------------- |
| `current_organization_id()`      | Resuelve el contexto de organización                  |
| `is_organization_member(uuid)`   | ¿Es este usuario miembro de esta organización?        |
| `has_permission(text)`           | ¿Tiene este permiso en el contexto actual?            |
| `assert_permission(text)`        | Lo mismo, pero lanza `42501` si no                    |
| `set_current_organization(uuid)` | Fija el contexto; `false` si la organización es ajena |
| `write_audit_log(...)`           | Escribe auditoría, solo desde funciones definer       |
| `touch_updated_at()`             | Trigger de `updated_at`                               |

`is_organization_member` y `current_organization_id` son `SECURITY DEFINER` a propósito:
consultan `core.organization_members`, que tiene RLS, y una política que consultara su
propia tabla de soporte se dispararía sola hasta desbordar la pila. El esquema `private`
no está en `[api].schemas`, así que el cliente no puede llamarlas por `rpc()`.

## Escrituras: funciones, no `insert()` directo

Algunas de las escrituras no pueden ser un `insert()` desde el cliente porque tocan varias
tablas o requieren cálculo: registrar una venta debe crear el documento, la cuenta por
cobrar y los asientos del libro mayor **en la misma transacción**, o nada de eso ocurre.

Esas escrituras se hacen con funciones SQL `SECURITY DEFINER` que:

1. Validan el permiso con `private.assert_permission(...)`.
2. Validan los datos con los mismos reglas que Zod (`private.assert_*`).
3. Verifican la `idempotency_key` para que un reintento no duplique la venta.
4. Escriben el documento, la cuenta por cobrar y el libro mayor juntos.
5. Dejan registro en `core.audit_log`.

Por eso el cliente no llama `insert()` para ventas, pagos, gastos ni movimientos de
inventario: llama `rpc('create_sale', ...)` o equivalente. El cliente de Supabase del
paquete documenta esta diferencia.

## Idempotencia

Toda escritura iniciada por el usuario lleva una `idempotency_key` generada en el
cliente. Si la misma llave llega dos veces, la función devuelve el resultado original en
lugar de crear un segundo registro. Sin esto, un doble toque en un celular con mala señal
produce dos ventas.

## Lo que cada capa no debe hacer

- **La UI** no debe filtrar datos "por permiso" creyendo que eso es seguridad.
- **La API** no debe confiar en un `organizationId` que venga en el cuerpo de la petición:
  se toma de la sesión.
- **Las migraciones** no deben crear una tabla de negocio sin su política en el mismo
  archivo. Se revisa en el PR.

## Auditoría

`core.audit_log` registra quién hizo qué y cuándo: acción, entidad, id, valores
anteriores y nuevos, usuario y organización. Es de solo lectura para la aplicación (salvo
`audit.read`, que solo `owner` y `admin` tienen), y no se borra: es el soporte para
explicar un número cuando el usuario lo cuestiona.

La escritura no se le concede a nadie del lado del cliente: `insert`, `update` y `delete`
están revocados y no existe política de escritura. Solo `private.write_audit_log()`, que es
`SECURITY DEFINER` y está en `private`, la invoca desde dentro de una función de negocio.
Una auditoría que el cliente puede escribir no es una auditoría.

## RLS no es integridad referencial

Las políticas deciden qué filas **puede ver** un rol. No deciden qué filas **pueden existir**,
y esa diferencia es la que importa cuando algo sale mal.

Una fila colgada de otra granja es ilegible para quien la escribió —RLS la filtra— pero
sigue siendo válida, y el día que alguien corra un `service_role`, un job de reporting o un
`pg_dump` aparece el dato de otro cliente. El síntoma llega tarde y sin rastro de quién lo
introdujo.

Por eso las referencias entre granjas se declaran con la organización **dentro** de la
clave foránea:

```sql
-- No: permite colgar una fila de otra granja, y RLS no lo nota.
business_unit_id uuid references core.business_units (id)

-- Sí: la fila solo existe si la unidad pertenece a la MISMA organización.
foreign key (organization_id, business_unit_id)
  references core.business_units (organization_id, id) on delete cascade
```

Las dos capas se defienden solas y, además, la segunda limpia lo que la primera deja pasar:
si un miembro se da de baja, sus alcances de unidad desaparecen con él, porque el alcance
cuelga de la membresía y no de un `user_id` suelto.

Aplicado hoy en `member_business_units` (unidad **y** usuario), en `accounts.parent_id` y en
`reference_parameters.business_unit_id`. Cuando una restricción Self-FK no puede aceptar
`on delete set null` —porque la parte anulable del destino está en la misma tupla— se usa
`on delete no action`: es la única forma de decir "no borres el padre mientras tenga
hijos" sin intentar anular una columna `NOT NULL`.

`supabase/tests/04_tenant_integrity.test.sql` prueba esto **sin** cambiar de rol, con RLS
inaplicable, precisamente para que la prueba no pueda pasar gracias a una política.

## Plantilla de revisión

Antes de aprobar un PR que toque la base de datos, verificar:

- [ ] La tabla tiene RLS habilitado y al menos una política en la **misma** migración.
- [ ] Las políticas filtran por organización **y** por permiso.
- [ ] Las llamadas a función dentro de una política van como `(select fn(...))`.
- [ ] Toda columna que apunte a otra tabla de organización incluye `organization_id` en la
      FK, o hay una razón explícita para no hacerlo.
- [ ] Las escrituras multi-tabla van en una función transaccional, no en varias llamadas.
- [ ] Hay `idempotency_key` en las escrituras iniciadas por el usuario.
- [ ] La función es `SECURITY DEFINER` con `set search_path = ''` y referencias calificadas.
- [ ] `private` sigue fuera de `[api].schemas`.
- [ ] No se usa `service_role` desde el cliente.
- [ ] Ninguna migración repite `revoke all on all tables in schema core` (solo la primera
      que crea tablas en `core` puede hacerlo).
- [ ] `pnpm tooling:check-schema` pasa (toda tabla con RLS, permisos del seed alineados
      con TypeScript).
- [ ] `pnpm db:reset && pnpm db:lint && pnpm db:test` levantan el entorno desde cero sin
      errores.
