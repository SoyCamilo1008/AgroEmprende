# Migraciones

Las migraciones son el registro de la estructura de la base de datos. Se versionan en
`supabase/migrations/*.sql` y son la única fuente de verdad del esquema: el código de la
aplicación nunca se usa para decidir qué tablas existen.

## Reglas

1. **Nombre**: `<timestamp>_<nombre_en_snake_case>.sql`, con timestamp de 14 dígitos
   (`20260927120000_init_core_schema.sql`). El script `pnpm migrations:new` ya lo genera
   con el formato correcto.
2. **Cabecera obligatoria** al inicio del archivo:

   ```sql
   -- description: qué hace esta migración, en una frase
   -- depends_on: 20260927120000_init_core_schema.sql   (si aplica)
   ```

   `depends_on` documenta el orden real de aplicación cuando una migración depende de
   otra. `pnpm tooling:check-migrations` avisa si falta.

3. **Inmutabilidad**: una migración ya aplicada no se edita. Si algo está mal, se escribe
   una migración nueva que corrija. Editar una migración aplicada hace que el entorno
   local y el remoto diverjan sin que nadie lo note.
4. **Prohibido en una migración de esquema**:
   - `DROP TABLE` — se usa `ON DELETE` y borrado lógico.
   - `DROP COLUMN` — primero se despliega el código que deja de usarla.
   - `TRUNCATE`.
   - `DELETE FROM` masivo: no se borra información histórica.

   Estas reglas las verifica `tools/check-migrations.mjs` y corren en local y en CI.

5. **Esquemas por dominio**: `core` (organizaciones, unidades, permisos, auditoría),
   `catalog` (catálogos compartidos sin datos de cliente), `finance` (libro mayor, ventas,
   cartera y pagos), `poultry`, `swine`, `inventory`, `ai`. Además hay un esquema
   `private` que **nunca** se expone a la API:
   aloja las funciones que RLS necesita para decidir (`current_organization_id`,
   `has_permission`, `assert_permission`, `can_write_business_unit`) y que el cliente no
   debe poder llamar directamente. Todo lo demás queda detrás de RLS.
6. **`private` no se expone**: `supabase/config.toml` lista `core` y `catalog` en
   `[api].schemas`, y `private` está deliberadamente fuera. Un `SECURITY DEFINER` con
   `search_path = ''` y todas las referencias calificadas es lo que evita que un atacante
   controle el `search_path`; publicarlo por descuido lo deshace.
7. **Dinero**: `NUMERIC(18,2)` con `CHECK` de no negatividad donde corresponda. Los ids
   son `uuid`. Las fechas de negocio son `date`; los campos de auditoría son
   `timestamptz`. Ver [ADR-0012](../decisions/ADR-0012-fechas-de-negocio.md).
8. **RLS desde el día uno**: toda tabla de negocio lleva `ENABLE ROW LEVEL SECURITY` y sus
   políticas en la misma migración que la crea. Una tabla sin RLS no se despliega.
   `pnpm tooling:check-schema` falla si encuentra una tabla sin política. Ver
   [RLS](../architecture/rls.md).
9. **Las referencias entre granjas se declaran con la organización dentro de la FK**: una
   columna que apunta a otra tabla lleva `(organization_id, id)` como destino, no solo
   `id`. RLS decide qué filas puede ver un rol, no qué filas pueden _existir_: una fila
   colgada de otra granja es ilegible, pero sigue siendo válida, y el error aparece meses
   después en un reporte. Ejemplos en `member_business_units`, `accounts.parent_id` y
   `reference_parameters.business_unit_id`.
10. **Cada migración revoca solo lo suyo**: `revoke all on all tables in schema core`
    pertenece únicamente a la primera migración que crea tablas en `core`. Repetirlo
    borra los permisos que las migraciones anteriores concedieron, y el síntoma es un
    `permission denied` en runtime que ningún linter detecta. `pnpm tooling:check-schema`
    simula el orden y falla si aparece. Ver
    [testing](../testing.md#por-qué-el-simulador-de-permisos-existe).

## Migraciones de la Fase 2

Nueve migraciones, en este orden. Cada una depende de la anterior mediante
`-- depends_on:`, y `pnpm tooling:check-migrations` verifica que esa dependencia exista y
que no apunte a una migración futura.

| Migración                                     | Qué crea                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `..._create_schemas_and_helpers.sql`          | `core`, `catalog`, `private`; `pgcrypto`; `touch_updated_at`                  |
| `..._create_core_access_control.sql`          | Roles, permisos, organizaciones, membresías, contexto y permisos              |
| `..._create_core_business_units.sql`          | Unidades de negocio y alcance por miembro, con FKs compuestas de organización |
| `..._create_catalog_measure_units.sql`        | Catálogo de unidades y factores de conversión                                 |
| `..._create_core_accounts_and_parameters.sql` | Cuentas, plantilla del plan de cuentas y parámetros de referencia             |
| `..._create_core_audit_log.sql`               | Registro de auditoría, append-only                                            |
| `..._create_core_partners.sql`                | Clientes, contactos y proveedores                                             |
| `..._create_onboarding_and_invitations.sql`   | Funciones de alta de organización e invitaciones                              |
| `..._enforce_organization_ownership.sql`      | Invariante de un único propietario y su transferencia                         |

`finance`, `poultry`, `swine`, `inventory` y `ai` **no** se crean todavía: la Fase 2 es
la base multiusuario, no el módulo financiero. Los permisos de esos dominios sí existen
desde el seed, para que la matriz de roles refleje la visión completa y cada fase traiga
solo las tablas que le tocan.

## Migraciones de la Fase 3

Cuatro migraciones que escriben el esquema `finance`. Dependen de la Fase 2 y se aplican
después de ella (el `-- depends_on:` apunta a `..._enforce_organization_ownership.sql`).

| Migración                         | Qué crea                                                                 |
| --------------------------------- | ------------------------------------------------------------------------ |
| `..._create_finance_ledger.sql`   | Libro mayor: `ledger_entries`, `ledger_lines`, cuenta 2210 y su backfill |
| `..._create_finance_sales.sql`    | Ventas, líneas y cartera; `create_sale` y `void_sale`                    |
| `..._create_finance_expenses.sql` | Pagables, gastos, inversiones y reinversiones con sus funciones          |
| `..._create_finance_payments.sql` | Pagos, asignaciones (`FIFO` o explícitas) y `register_payment`           |

El diseño se apoya en dos invariantes que la base garantiza, no el cliente:

- **Doble partida**: todo asiento queda en balance (`sum(débitos) = sum(créditos)`). La
  función `private.post_ledger_entry` valida antes de escribir y un trigger de restricción
  **diferido** (`ledger_lines_balance_invariant`) lo garantiza incluso si alguien escribe
  líneas por otra vía. Las líneas nunca se actualizan ni se borran: un error se corrige
  con un contra-asiento (`reversal`).
- **Escritura por funciones nada más**: las tablas del esquema `finance` son de solo
  lectura por RLS; toda escritura pasa por `create_sale`, `void_sale`, `create_expense`,
  `create_investment`, `create_reinvestment` y `register_payment`, todas `SECURITY
DEFINER` con `search_path = ''`, permiso (`finance.*`) y alcance de unidad
  (`can_write_business_unit`) verificados.

`finance` se agregó a `[api].schemas` en `supabase/config.toml`; `private` sigue fuera,
que es condición del diseño. Ver [ADR-0003](../decisions/ADR-0003-doble-partida.md) y
[ADR-0004](../decisions/ADR-0004-unidades-de-negocio.md).

## Flujo de trabajo

```bash
pnpm migrations:new add_feed_consumption      # crea el archivo con cabecera
# edita el SQL a mano
pnpm db:reset                                # aplica todo desde cero + seed
pnpm db:lint                                 # analiza el esquema
pnpm db:test                                 # pruebas pgTAP del aislamiento
pnpm db:diff                                 # compara el estado real con las migraciones
pnpm tooling:check-migrations                 # reglas del proyecto
```

En local, `supabase db reset` reconstruye la base completa desde cero. Eso es lo que
detecta una migración que depende de otra en el orden equivocado.

## Seed

`supabase/seed/seed.sql` carga datos de plantilla: roles del sistema, catálogo de
permisos, la matriz rol→permiso, el catálogo de unidades de medida y el plan de cuentas
base. Nunca contiene datos reales, y **no** se siembran unidades de negocio,
organizaciones, clientes ni parámetros de referencia: los parámetros dependen de cada
granja. Ver `supabase/seed/README.md` y
[ADR-0011](../decisions/ADR-0011-datos-reales.md).

`pnpm tooling:check-schema` compara el seed contra `packages/types/src/auth.ts` y
`packages/types/src/units.ts`. Si alguien agrega un permiso en TypeScript y olvida el
seed, el RLS lo va a consultar por nombre y no va a encontrar la fila: el permiso se
deniega en silencio. El verificador falla antes de que eso llegue a `main`.

## Notas

- `supabase/config.toml` define el entorno local reproducible (Postgres 17, puertos,
  Auth, Storage). Está versionado a propósito.
- El proyecto remoto (project ref, región) se configura por variables de entorno o por
  `supabase link`; no va en el repositorio.
- Las migraciones de las fases 2 y 3 están escritas pero **no han sido aplicadas**: aplicar
  y probar el esquema exige Docker, que no está disponible en la máquina de desarrollo.
  Hasta que el job `migrations` del CI pase en verde, el esquema no está verificado contra
  PostgreSQL. Ver [testing](../testing.md).
