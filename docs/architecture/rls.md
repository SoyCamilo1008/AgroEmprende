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
    organization_id = private.current_organization_id()
    and private.has_permission('finance.sales.read')
  );
```

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

## Plantilla de revisión

Antes de aprobar un PR que toque la base de datos, verificar:

- [ ] La tabla tiene RLS habilitado.
- [ ] Las políticas filtran por organización **y** por permiso.
- [ ] Las escrituras multi-tabla van en una función transaccional, no en varias llamadas.
- [ ] Hay `idempotency_key` en las escrituras iniciadas por el usuario.
- [ ] No se usa `service_role` desde el cliente.
- [ ] `pnpm db:reset` levanta el entorno desde cero sin errores.
