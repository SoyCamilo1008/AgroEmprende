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
   `finance` (ventas, pagos, cuentas por cobrar, gastos, libros), `poultry`, `swine`,
   `inventory`, `ai`. La vista `public` expone lo que la app necesita; el resto queda
   detrás de RLS.
6. **Dinero**: `NUMERIC(18,2)` con `CHECK` de no negatividad donde corresponda. Los ids
   son `uuid`. Las fechas de negocio son `date`; los campos de auditoría son
   `timestamptz`. Ver [ADR-0012](../decisions/ADR-0012-fechas-de-negocio.md).
7. **RLS desde el día uno**: toda tabla de negocio lleva `ENABLE ROW LEVEL SECURITY` y sus
   políticas en la misma migración que la crea. Una tabla sin RLS no se despliega. Ver
   [RLS](../architecture/rls.md).

## Flujo de trabajo

```bash
pnpm migrations:new add_feed_consumption      # crea el archivo con cabecera
# edita el SQL a mano
pnpm db:reset                                # aplica todo desde cero + seed
pnpm db:lint                                 # analiza el esquema
pnpm db:diff                                 # compara el estado real con las migraciones
pnpm tooling:check-migrations                 # reglas del proyecto
```

En local, `supabase db reset` reconstruye la base completa desde cero. Eso es lo que
detecta una migración que depende de otra en el orden equivocado.

## Seed

`supabase/seed/seed.sql` carga datos de plantilla: roles del sistema, catálogo de
permisos, cuentas contables base, unidades de ejemplo y parámetros de referencia
etiquetados con su `data_kind`. Nunca contiene datos reales. Ver
`supabase/seed/README.md` y [ADR-0011](../decisions/ADR-0011-datos-reales.md).

## Notas

- `supabase/config.toml` define el entorno local reproducible (Postgres 17, puertos,
  Auth, Storage). Está versionado a propósito.
- El proyecto remoto (project ref, región) se configura por variables de entorno o por
  `supabase link`; no va en el repositorio.
- La Fase 1 no tiene migraciones todavía: el esquema empieza en la Fase 2. Por eso
  `pnpm tooling:check-migrations` informa "no hay migraciones todavía" y sale con
  código 0, que es lo esperado.
