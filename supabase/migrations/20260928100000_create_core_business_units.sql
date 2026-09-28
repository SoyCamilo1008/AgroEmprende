-- description: Crea core.business_units y el alcance por unidad de negocio que exige ADR-0004.
-- depends_on: 20260928093000_create_core_access_control.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Unidades de negocio
--
-- La unidad es la FRONTERA CONTABLE (ADR-0004): cada libro y cada movimiento
-- pertenece a exactamente una. El tipo replica `BUSINESS_UNIT_TYPES` de
-- @agroemprende/types y las columnas, la interfaz `BusinessUnit`.
--
-- `code` es la clave de negocio legible (PONEDORAS, CERDOS) y es única por
-- organización: dos granjas no pueden llamarse igual.
--
-- Borrado lógico, no físico: `deleted_at` marca una unidad que ya no opera
-- pero cuyos lotes y movimientos deben seguir en el histórico.
-- ─────────────────────────────────────────────────────────────────────────────

create table core.business_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_]{2,32}$'),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  type text not null check (
    type in ('poultry_layers', 'broilers', 'swine', 'cattle', 'fish', 'crops', 'other')
  ),
  -- Unidad superior para agrupar fincas o actividades. `on delete set null`:
  -- al borrar el padre, el hijo sobrevive como raíz en vez de desaparecer.
  parent_id uuid references core.business_units (id) on delete set null,
  currency text not null default 'COP' check (currency = 'COP'),
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_units_not_own_parent check (parent_id is null or parent_id <> id),
  unique (organization_id, code),
  -- Objetivo de las claves foráneas COMPUESTAS de `member_business_units` y
  -- `reference_parameters`: declaran (organization_id, business_unit_id) contra
  -- (organization_id, id). Redundante como unicidad —`id` ya es la clave
  -- primaria— y necesario como destino de la FK, que es lo que hace imposible
  -- colgar una unidad de una organización desde una fila de otra.
  unique (organization_id, id)
);

create index business_units_organization on core.business_units (organization_id);

comment on table core.business_units is
  'Unidad de negocio: la frontera contable. Replica la interfaz `BusinessUnit` de @agroemprende/types.';

-- El padre tiene que ser de la MISMA organización. Sin esto, un id de unidad
-- de otra organización colado en `parent_id` expondría su nombre.
create or replace function private.assert_business_unit_belongs_to_organization()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.parent_id is not null and not exists (
    select 1
    from core.business_units parent
    where parent.id = new.parent_id
      and parent.organization_id = new.organization_id
  ) then
    raise exception 'La unidad padre debe pertenecer a la misma organización'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger business_units_parent_same_organization
  after insert or update of parent_id, organization_id on core.business_units
  deferrable initially deferred
  for each row execute function private.assert_business_unit_belongs_to_organization();

-- ─────────────────────────────────────────────────────────────────────────────
-- Alcance por unidad (ADR-0004)
--
-- "Un operador de una granja no puede escribir en otra aunque tenga el
-- permiso global." Eso necesita saber a qué unidades aplica el permiso de cada
-- miembro. Una fila por (miembro, unidad) acota la escritura.
--
-- AUSENCIA de fila significa "accede a todas": en la Fase 2 no hay pantalla
-- para asignar alcances, así que ningún miembro está acotado. Cuando exista,
-- se insertan filas y el alcance empieza a aplicar. Es el default explícito,
-- no un olvido.
--
-- La lectura NO se acota: ver una lista de granjas no es un problema, escribir
-- en la equivocada sí.
-- ─────────────────────────────────────────────────────────────────────────────

create table core.member_business_units (
  organization_id uuid not null references core.organizations (id) on delete cascade,
  user_id uuid not null,
  business_unit_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id, business_unit_id),
  -- Las dos relaciones que antes colgaban de un id suelto y se convertían en
  -- referencias cruzadas: `business_unit_id` de otra granja y `user_id` de
  -- alguien que no es miembro. RLS filtraba la lectura, no la escritura, y una
  -- fila corrupta sigue corrupta aunque después nadie la pueda ver.
  --
  -- El par (organization_id, user_id) es la clave primaria de
  -- `core.organization_members`: además de ajustar el modelo ("el alcance se
  -- define sobre un miembro"), hace que un alcance no sobreviva a la baja del
  -- miembro.
  foreign key (organization_id, business_unit_id)
    references core.business_units (organization_id, id) on delete cascade,
  foreign key (organization_id, user_id)
    references core.organization_members (organization_id, user_id) on delete cascade
);

comment on table core.member_business_units is
  'Alcance de escritura por unidad. Sin filas, el miembro escribe en todas las unidades de su organización.';

-- true si el usuario puede ESCRIBIR en la unidad. Sin filas de alcance, todas.
create or replace function private.can_write_business_unit(p_business_unit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from core.organization_members m
    where m.user_id = (select auth.uid())
      and m.is_active
      and m.organization_id = (select private.current_organization_id())
      and (
        not exists (
          select 1
          from core.member_business_units mbu
          where mbu.organization_id = m.organization_id
            and mbu.user_id = m.user_id
        )
        or exists (
          select 1
          from core.member_business_units mbu
          where mbu.organization_id = m.organization_id
            and mbu.user_id = m.user_id
            and mbu.business_unit_id = p_business_unit_id
        )
      )
  )
$$;

comment on function private.can_write_business_unit(uuid) is
  'true si el usuario puede escribir en la unidad. El alcance explícito acota; sin filas, no acota.';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────

alter table core.business_units enable row level security;
alter table core.member_business_units enable row level security;

create policy business_units_select on core.business_units
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('org.read'))
    and (deleted_at is null or (select private.has_permission('org.members.manage')))
  );

create policy business_units_insert on core.business_units
  for insert
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('business_units.manage'))
  );

create policy business_units_update on core.business_units
  for update
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('business_units.manage'))
    and (select private.can_write_business_unit(id))
  )
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('business_units.manage'))
    and (select private.can_write_business_unit(id))
  );

-- No hay política de DELETE: una unidad se archiva con `deleted_at`.
create policy member_business_units_select on core.member_business_units
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('org.read'))
  );

create policy member_business_units_insert on core.member_business_units
  for insert
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('org.members.manage'))
  );

create policy member_business_units_delete on core.member_business_units
  for delete
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('org.members.manage'))
  );

create trigger business_units_touch_updated_at
  before update on core.business_units
  for each row execute function private.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos SQL
-- ─────────────────────────────────────────────────────────────────────────────

-- Solo las tablas de ESTA migración. Un `revoke all on all tables in schema core`
-- aquí borraría los permisos que las migraciones anteriores ya otorgaron, y en
-- una migración posterior no hay forma de saber cuáles eran: el resultado
-- sería una base sin acceso para `authenticated` y policies que nunca aplican.
revoke all on core.business_units, core.member_business_units
  from anon, authenticated;

grant usage on schema core to authenticated;

grant select, insert, update on core.business_units to authenticated;
grant select, insert, delete on core.member_business_units to authenticated;

grant execute on function private.assert_business_unit_belongs_to_organization() to authenticated;
grant execute on function private.can_write_business_unit(uuid) to anon, authenticated;
