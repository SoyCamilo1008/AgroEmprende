-- description: Crea core.audit_log, el registro de quién hizo qué, y la función privada que lo escribe.
-- depends_on: 20260928093000_create_core_access_control.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Auditoría
--
-- docs/architecture/rls.md: `core.audit_log` es "el soporte para explicar un
-- número cuando el usuario lo cuestiona". Por eso es de solo append: no tiene
-- UPDATE ni DELETE en ninguna capa, y el cliente no puede escribirlo
-- directamente. Solo lo hacen las funciones SECURITY DEFINER.
--
-- Sin fechas de negocio aquí: `created_at` es un INSTANTE (cuándo ocurrió el
-- hecho), no el día del negocio. Ver ADR-0012.
-- ─────────────────────────────────────────────────────────────────────────────

create table core.audit_log (
  id uuid primary key default gen_random_uuid(),
  -- NULL cuando el hecho ocurre antes de que exista la organización (el alta
  -- misma se audita contra la organización que acaba de crearse).
  organization_id uuid references core.organizations (id) on delete cascade,
  -- NULL cuando el actor fue borrado de auth.users: el hecho sigue auditado.
  actor_id uuid references auth.users (id) on delete set null,
  action text not null check (char_length(btrim(action)) between 3 and 80),
  entity_type text not null check (char_length(btrim(entity_type)) between 2 and 80),
  entity_id uuid,
  old_values jsonb,
  new_values jsonb,
  -- Agrupa los pasos de una misma operación para poder reconstruirla entera.
  request_id text,
  created_at timestamptz not null default now()
);

create index audit_log_organization_created
  on core.audit_log (organization_id, created_at desc);

create index audit_log_entity
  on core.audit_log (entity_type, entity_id);

comment on table core.audit_log is
  'Registro de auditoría, de solo append. No se actualiza ni se borra: es la explicación de un número.';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
--
-- Lectura solo con `audit.read`, que en la matriz de roles solo tienen `owner` y
-- `admin`. No hay política de INSERT: la aplica private.write_audit_log() como
-- SECURITY DEFINER, que es lo que permite auditar el alta sin que el cliente
-- tenga permiso de escritura.
-- ─────────────────────────────────────────────────────────────────────────────

alter table core.audit_log enable row level security;

create policy audit_log_select on core.audit_log
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('audit.read'))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Escritura desde funciones SECURITY DEFINER
--
-- `p_old_values` y `p_new_values` por nombre, no posicional: una auditoría cuyo
-- orden de argumentos no se puede leer es una auditoría que se llena en el
-- orden equivocado sin que nadie lo note.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.write_audit_log(
  p_action text,
  p_entity_type text,
  p_entity_id uuid default null,
  p_old_values jsonb default null,
  p_new_values jsonb default null,
  p_request_id text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_actor_id uuid := (select auth.uid());
  v_id uuid;
begin
  -- Sin sesión no hay organización a la que colgar la entrada, y una entrada
  -- suelta no se puede consultar después. Se descarta en silencio: auditar no
  -- puede ser la razón por la que falla la operación del usuario.
  if v_actor_id is null then
    return null;
  end if;

  -- La organización es la del CONTEXTO, no la primera a la que se unió el
  -- usuario: un usuario en dos organizaciones tiene contexto NULL (falla
  -- cerrado) y su auditoría debe quedar sin colgar, no adjudicada a la
  -- organización más antigua a la que entró.
  v_organization_id := (select private.current_organization_id());

  insert into core.audit_log (
    organization_id,
    actor_id,
    action,
    entity_type,
    entity_id,
    old_values,
    new_values,
    request_id
  )
  values (
    v_organization_id,
    v_actor_id,
    p_action,
    p_entity_type,
    p_entity_id,
    p_old_values,
    p_new_values,
    p_request_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function private.write_audit_log(text, text, uuid, jsonb, jsonb, text) is
  'Escribe una entrada de auditoría. Solo desde funciones SECURITY DEFINER: el cliente no tiene permiso.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos SQL
-- ─────────────────────────────────────────────────────────────────────────────

-- Solo la tabla de ESTA migración (ver el motivo en la migración de
-- business_units): un revoke global destruiría los permisos previos.
revoke all on core.audit_log from anon, authenticated;

grant usage on schema core to authenticated;

-- El cliente LEE la auditoría (con audit.read) pero nunca la escribe.
grant select on core.audit_log to authenticated;

-- INSERT/UPDATE/DELETE explícitamente denegados aunque más adelante se
-- conceda el permiso de tabla: la app no tiene por qué poder reescribir la
-- historia.
revoke insert, update, delete on core.audit_log from anon, authenticated;

grant execute on function private.write_audit_log(text, text, uuid, jsonb, jsonb, text) to authenticated;
