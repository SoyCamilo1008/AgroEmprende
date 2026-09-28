-- description: Crea el plan de cuentas y los parámetros de referencia con su clasificación data_kind.
-- depends_on: 20260928103000_create_catalog_measure_units.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Plan de cuentas
--
-- Es la estructura que la Fase 3 llena con el libro mayor. Existe desde ahora
-- porque el seed carga las cuentas base (ADR-0003: venta, pago y libro mayor
-- son la misma historia, no tres tablas sueltas) y porque una cuenta contable
-- es un dato maestro de la organización, no de una unidad de negocio.
--
-- NO tiene columna de saldo: el saldo es la suma de asientos, y un saldo
-- guardado es un saldo que algún día no cuadra. Ver ADR-0003.
-- ─────────────────────────────────────────────────────────────────────────────

create table core.accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  -- NIF de la cuenta. Es la clave contable y lo escribe el contador, no la app.
  code text not null check (code ~ '^[0-9]{4,8}$'),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  type text not null check (
    type in ('asset', 'liability', 'equity', 'income', 'expense')
  ),
  parent_id uuid,
  -- true si la cuenta la define el sistema y no debería editarse.
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  -- Destino de la FK compuesta del padre. La PK `id` por sí sola permitía colgar
  -- una cuenta de otra organización: la política de RLS filtra las filas
  -- visibles, no comprueba que el padre pertenezca a la misma.
  unique (organization_id, id),
  foreign key (organization_id, parent_id)
    references core.accounts (organization_id, id) on delete no action
);

create index accounts_organization on core.accounts (organization_id);

comment on table core.accounts is
  'Plan de cuentas de la organización. Los asientos de Fase 3 cuelgan de aquí; el saldo nunca se guarda.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Plantilla de cuentas
--
-- `core.accounts` es POR organización, así que el seed no puede llenarla: no
-- existe la organización todavía. Lo que sí es plantilla es el MODELO de
-- cuentas base, y por eso tiene su tabla global, sin `organization_id` y sin
-- RLS de organización: es la definición del sistema.
--
-- El alta de la organización copia estas filas a `core.accounts`. A partir de
-- ahí la organización es dueña de su plan de cuentas y puede ajustarlo con su
-- contador, sin que volver a copiar le pise lo que ya cambió.
-- ─────────────────────────────────────────────────────────────────────────────

create table core.account_templates (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[0-9]{4,8}$'),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  type text not null check (
    type in ('asset', 'liability', 'equity', 'income', 'expense')
  ),
  -- NIF del padre dentro de la plantilla, para reconstruir la jerarquía al
  -- copiar. El alta lo resuelve en dos pasadas (primero las sin padre, después
  -- las que sí lo tienen); la FK se referencia a sí misma, así que el orden de
  -- inserción del seed también importa.
  parent_template_code text references core.account_templates (code) on delete restrict,
  description text,
  unique (code)
);

comment on table core.account_templates is
  'Modelo de cuentas base del sistema. El seed lo carga; el alta de la organización lo copia a core.accounts.';

alter table core.accounts enable row level security;

create policy accounts_select on core.accounts
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.read'))
  );

create policy accounts_insert on core.accounts
  for insert
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.ledger.manage'))
  );

create policy accounts_update on core.accounts
  for update
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.ledger.manage'))
  )
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.ledger.manage'))
  );

-- Sin DELETE: una cuenta con movimientos no se borra, se inactiva.

-- La plantilla es de lectura global: no tiene datos de organización y todos
-- necesitan verla para entender el plan de cuentas.
alter table core.account_templates enable row level security;

create policy account_templates_select on core.account_templates
  for select
  using (true);

create policy account_templates_insert on core.account_templates
  for insert
  with check ((select private.has_permission('settings.manage')));

create policy account_templates_update on core.account_templates
  for update
  using ((select private.has_permission('settings.manage')))
  with check ((select private.has_permission('settings.manage')));

create trigger accounts_touch_updated_at
  before update on core.accounts
  for each row execute function private.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Parámetros de referencia
--
-- ADR-0011 lo declara parte del contrato de datos de v1: cada dato de
-- referencia lleva su `data_kind` para que ninguna pantalla lo presente como
-- un hecho medido. "18.000 COP la cubeta" es un precio de referencia ACTUAL, no
-- el precio histórico de todas las ventas, y por eso vive aquí con vigencia,
-- mientras la venta real guarda su propio precio unitario.
--
-- Replica la interfaz `ReferenceParameter` de @agroemprende/types.
--
-- `notes` es obligatorio en la práctica: sin saber por qué existe un valor, un
-- parámetro se degrada en «lo puso alguien» y se hereda por años. Aquí se
-- permite nulo para no bloquear el alta, pero la aplicación lo pide siempre.
-- ─────────────────────────────────────────────────────────────────────────────

create table core.reference_parameters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  -- NULL = parámetro de toda la organización, no de una unidad concreta.
  -- La FK es compuesta para que la unidad sea de ESTA organización: con una FK
  -- por `id` sola, un parámetro de la granja A podía apuntarle a una unidad de
  -- la granja B, y la fila era ilegible pero no inválida.
  business_unit_id uuid,
  key text not null check (key ~ '^[a-z0-9][a-z0-9_.]{2,63}$'),
  label text not null check (char_length(btrim(label)) between 2 and 160),
  category text not null check (
    category in ('price_reference', 'technical', 'planning', 'logistics', 'capacity')
  ),
  data_kind text not null check (
    data_kind in ('measured', 'historical', 'reference', 'planned', 'configured')
  ),
  numeric_value numeric(20, 6) check (numeric_value is null or numeric_value >= 0),
  text_value text,
  currency text check (currency is null or currency = 'COP'),
  unit_of_measure text references catalog.measure_units (code) on delete restrict,
  -- Vigencia. Fechas de negocio (`date`), no instantes: ADR-0012.
  effective_from date,
  effective_to date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- `business_unit_id` NULL significa "de toda la organización", y una FK
  -- compuesta con alguna columna NULL no se comprueba: la invariancia se
  -- relaja sola cuando la fila no habla de ninguna unidad, que es exactamente
  -- lo que dice el comentario de la columna.
  foreign key (organization_id, business_unit_id)
    references core.business_units (organization_id, id) on delete cascade,
  -- Un parámetro sin valor no dice nada: se pide, no se rellena.
  constraint reference_parameters_has_value check (
    numeric_value is not null or (text_value is not null and btrim(text_value) <> '')
  ),
  constraint reference_parameters_valid_window check (
    effective_to is null or effective_from is null or effective_to >= effective_from
  )
);

create index reference_parameters_lookup
  on core.reference_parameters (organization_id, key, effective_from desc);

comment on table core.reference_parameters is
  'Parámetros de referencia con su clasificación `data_kind`. Nunca es un hecho medido si dice `reference` o `planned`.';

alter table core.reference_parameters enable row level security;

create policy reference_parameters_select on core.reference_parameters
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('org.read'))
  );

create policy reference_parameters_insert on core.reference_parameters
  for insert
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('settings.manage'))
  );

create policy reference_parameters_update on core.reference_parameters
  for update
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('settings.manage'))
  )
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('settings.manage'))
  );

-- Sin DELETE: un parámetro usado por un cálculo histórico se retira con
-- `effective_to`, no se borra.

create trigger reference_parameters_touch_updated_at
  before update on core.reference_parameters
  for each row execute function private.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos SQL
-- ─────────────────────────────────────────────────────────────────────────────

-- Solo las tablas de ESTA migración (ver el motivo en la migración de
-- business_units): un revoke global destruiría los permisos previos.
revoke all on core.accounts, core.account_templates, core.reference_parameters
  from anon, authenticated;

grant usage on schema core to authenticated;

grant select, insert, update on core.accounts to authenticated;
grant select, insert, update on core.reference_parameters to authenticated;
grant select on core.account_templates to anon, authenticated;
