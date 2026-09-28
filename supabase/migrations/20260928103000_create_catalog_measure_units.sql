-- description: Crea catalog.measure_units, donde viven las conversiones de unidades.
-- depends_on: 20260928090000_create_schemas_and_helpers.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Unidades de medida
--
-- `packages/types/src/units.ts` dice que las conversiones "viven en la base de
-- datos y NO como constantes en el código, para poder corregir un factor
-- histórico sin desplegar". Esta tabla es ese lugar.
--
-- El código replica los CÓDIGOS (`MEASURE_UNITS`) para poder tipar; los
-- FACTORES viven aquí. Un factor corregido es una fila actualizada, no un
-- despliegue.
--
-- `base_code` se referencia a sí misma: `g` y `kg` son base `kg`, y `kg` es
-- base de sí mismo con factor 1. Así una conversión es siempre un salto a la
-- unidad base, y `factor_to_base` compone correctamente en cadena.
--
-- Las FILAS las carga el seed (ADR-0011: son datos de plantilla, no
-- estructura). Este archivo solo crea la tabla y su RLS.
-- ─────────────────────────────────────────────────────────────────────────────

create table catalog.measure_units (
  code text primary key check (code ~ '^[a-z0-9]{1,16}$'),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  base_code text not null references catalog.measure_units (code) on delete restrict,
  -- Cuántas unidades de `code` equivalen a 1 unidad de `base_code`.
  -- numeric y no float: un factor de 0.453592 no cabe exacto en un binario.
  factor_to_base numeric(20, 6) not null check (factor_to_base > 0),
  -- true si el producto se compra o se vende en paquetes de esta unidad.
  is_pack boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index measure_units_base on catalog.measure_units (base_code);

comment on table catalog.measure_units is
  'Catálogo de unidades de medida y su factor a la unidad base. Los códigos replican `MEASURE_UNITS` de @agroemprende/types.';

create or replace function catalog.assert_measure_unit_base_is_root()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- La base de una base es ella misma, con factor 1.
  if new.base_code = new.code and new.factor_to_base <> 1 then
    raise exception 'La unidad base % debe tener factor_to_base = 1', new.code
      using errcode = '23514';
  end if;

  -- Una unidad que no es base no puede tener factor distinto de 1 hacia sí
  -- misma: eso rompería la composición de conversiones.
  if new.base_code <> new.code and new.factor_to_base = 1 and new.base_code is not null then
    raise exception 'La unidad % no puede tener factor 1 hacia %', new.code, new.base_code
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger measure_units_base_is_root
  before insert or update on catalog.measure_units
  for each row execute function catalog.assert_measure_unit_base_is_root();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
--
-- Es un catálogo global, sin datos de organización: se lee sin sesión. Escribir
-- un factor es un cambio de configuración del sistema, así que exige
-- `settings.manage` dentro del contexto de una organización.
-- ─────────────────────────────────────────────────────────────────────────────

alter table catalog.measure_units enable row level security;

create policy measure_units_select on catalog.measure_units
  for select
  using (true);

create policy measure_units_insert on catalog.measure_units
  for insert
  with check ((select private.has_permission('settings.manage')));

create policy measure_units_update on catalog.measure_units
  for update
  using ((select private.has_permission('settings.manage')))
  with check ((select private.has_permission('settings.manage')));

create trigger measure_units_touch_updated_at
  before update on catalog.measure_units
  for each row execute function private.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos SQL
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on catalog.measure_units from anon, authenticated;

alter default privileges in schema catalog revoke all on tables from anon, authenticated;
alter default privileges in schema catalog revoke all on sequences from anon, authenticated;

grant usage on schema catalog to anon, authenticated;
grant select on catalog.measure_units to anon, authenticated;
grant insert, update on catalog.measure_units to authenticated;

grant execute on function catalog.assert_measure_unit_base_is_root() to authenticated;
