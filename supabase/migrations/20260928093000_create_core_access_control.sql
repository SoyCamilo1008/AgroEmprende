-- description: Crea el control de acceso multitenant: roles, permisos, organizaciones, membresías y el contexto de RLS.
-- depends_on: 20260928090000_create_schemas_and_helpers.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Roles y permisos
--
-- Los códigos son los de `ROLES` y `PERMISSIONS` en `@agroemprende/types`
-- (packages/types/src/auth.ts). La lista vive en TypeScript y aquí se replica:
-- un PR que agregue un permiso actualiza ambos, y `pnpm tooling:check-schema`
-- falla si se desincronizan.
--
-- Las FILAS las carga `supabase/seed/seed.sql`, no esta migración: son datos de
-- plantilla (ADR-0011), no estructura.
-- ─────────────────────────────────────────────────────────────────────────────

create table core.roles (
  code text primary key
    check (code ~ '^[a-z][a-z_]{1,31}$'),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  description text not null default '',
  -- Orden de autoridad: 100 owner > 80 admin > 60 manager > 40 operator > 20 viewer.
  rank integer not null check (rank between 0 and 100),
  is_system boolean not null default true
);

comment on table core.roles is
  'Roles del sistema. Los códigos replican `ROLES` de @agroemprende/types.';

create table core.permissions (
  code text primary key check (code ~ '^[a-z][a-z_.]{2,63}$'),
  description text not null default '',
  category text not null check (category in ('org', 'catalog', 'finance', 'inventory', 'poultry', 'swine', 'ai'))
);

comment on table core.permissions is
  'Catálogo de permisos. Los códigos replican `PERMISSIONS` de @agroemprende/types.';

create table core.role_permissions (
  role_code text not null references core.roles (code) on delete cascade,
  permission_code text not null references core.permissions (code) on delete cascade,
  primary key (role_code, permission_code)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Organizaciones
--
-- Un usuario puede pertenecer a varias organizaciones (docs/architecture/auth.md).
-- Los datos de una nunca son visibles para otra: eso lo garantizan las
-- políticas de RLS de más abajo, no la aplicación.
-- ─────────────────────────────────────────────────────────────────────────────

create table core.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  -- NIT colombiano. Opcional a propósito: no se inventa un NIT que el usuario
  -- no ha dado. NULL significa "todavía no lo sabemos" (ADR-0011).
  tax_id text check (tax_id is null or tax_id ~ '^[0-9]{6,15}$'),
  timezone text not null default 'America/Bogota',
  -- v1 solo maneja COP (docs/README.md, referencia rápida).
  default_currency text not null default 'COP' check (default_currency = 'COP'),
  is_active boolean not null default true,
  created_by uuid not null references auth.users (id) on delete restrict,
  -- Clave de idempotencia del onboarding: dos toques en "Crear organización"
  -- no crean dos organizaciones. Ver la RPC en la migración de onboarding.
  idempotency_key uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index organizations_created_by_idempotency_key
  on core.organizations (created_by, idempotency_key)
  where idempotency_key is not null;

create index organizations_created_by on core.organizations (created_by);

comment on table core.organizations is
  'La frontera del multitenant. Toda tabla de negocio cuelga de organization_id.';

create table core.organization_members (
  organization_id uuid not null references core.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role_code text not null references core.roles (code) on delete restrict,
  is_active boolean not null default true,
  joined_at timestamptz not null default now(),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index organization_members_user on core.organization_members (user_id)
  where is_active;

-- Una organización tiene UN dueño activo. Sin esto, dos personas podrían
-- creerse propietarias y ambas "administrar" la organización sin conflicto.
-- La transferencia de propiedad es un proceso explícito, no un UPDATE suelto.
create unique index organization_members_one_active_owner
  on core.organization_members (organization_id)
  where role_code = 'owner' and is_active;

comment on table core.organization_members is
  'Membresía: un usuario, una organización, un rol. El rol es org-scoped.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Contexto de RLS
--
-- `current_organization_id()` es la pieza que todas las políticas consultan.
-- Es SECURITY DEFINER a propósito: una política sobre `organization_members`
-- que consultara esa tabla bajo las reglas del llamador se llamaría a sí misma
-- hasta el desbordamiento de la pila. Como SECURITY DEFINER la ejecuta el
-- dueño (postgres, que no está sujeto a RLS) y la recursión desaparece.
--
-- Se resuelve en dos pasos, y en el último caso NO adivina:
--   1. Contexto explícito de la petición, siempre validado contra la membresía.
--   2. Si el usuario tiene exactamente una organización activa, esa es.
--   3. Si tiene más de una, devuelve NULL y las políticas niegan. Se prefiere
--      una pantalla vacía a mostrarle la organización equivocada.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select m.organization_id
      from core.organization_members m
      where m.organization_id = private.try_uuid(
              current_setting('app.current_organization_id', true)
            )
        and m.user_id = (select auth.uid())
        and m.is_active
      limit 1
    ),
    case
      when (
        select count(*)
        from core.organization_members m2
        where m2.user_id = (select auth.uid())
          and m2.is_active
      ) = 1
      then (
        select m3.organization_id
        from core.organization_members m3
        where m3.user_id = (select auth.uid())
          and m3.is_active
        limit 1
      )
      else null
    end
  )
$$;

comment on function private.current_organization_id() is
  'Organización activa de la petición, o NULL. Nunca inventa una: sin contexto válido, no hay acceso.';

create or replace function private.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from core.organization_members m
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.is_active
  )
$$;

-- El permiso se evalúa SIEMPRE contra la organización activa, nunca contra una
-- que venga en el cuerpo de la petición. Un `organizationId` del cliente es un
-- dato no confiable hasta que una política lo confirma.
create or replace function private.has_permission(p_permission_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from core.organization_members m
    join core.role_permissions rp on rp.role_code = m.role_code
    where m.user_id = (select auth.uid())
      and m.is_active
      and m.organization_id = (select private.current_organization_id())
      and rp.permission_code = p_permission_code
  )
$$;

comment on function private.has_permission(text) is
  'true si el usuario tiene el permiso en la organización activa. La evalúa RLS, no el cliente.';

-- Para funciones SQL que escriben: o el permiso está, o la operación se negate.
create or replace function private.assert_permission(p_permission_code text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select private.has_permission(p_permission_code)) is not true then
    raise exception 'Permiso requerido: %', p_permission_code
      using errcode = '42501';
  end if;
end;
$$;

-- Marca la organización activa de la petición.
--
-- `set_config(..., true)` la deja activa solo durante la transacción en curso.
-- Con PostgREST cada petición ES una transacción, así que el cliente la fija al
-- empezar y todas las consultas de esa petición la ven. Un `insert()` suelto
-- desde el cliente NO la conserva entre peticiones: por eso, mientras un
-- usuario tenga una sola organización, `private.current_organization_id()` la
-- resuelve sola. Ver docs/architecture/auth.md.
create or replace function private.set_current_organization(p_organization_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not (select private.is_organization_member(p_organization_id)) then
    return false;
  end if;

  perform set_config('app.current_organization_id', p_organization_id::text, true);
  return true;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
--
-- Sin políticas INSERT ni DELETE: esas filas las crea el onboarding y las
-- invitaciones, por funciones SECURITY DEFINER. Que no exista política ES la
-- protección: RLS con tabla habilitada y sin política de escritura la niega.
-- ─────────────────────────────────────────────────────────────────────────────

alter table core.organizations enable row level security;
alter table core.organization_members enable row level security;

create policy organizations_select on core.organizations
  for select
  using (
    id = (select private.current_organization_id())
    and (select private.has_permission('org.read'))
  );

create policy organizations_update on core.organizations
  for update
  using (
    id = (select private.current_organization_id())
    and (select private.has_permission('org.update'))
  )
  with check (
    id = (select private.current_organization_id())
    and (select private.has_permission('org.update'))
  );

create policy organization_members_select on core.organization_members
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('org.read'))
  );

create policy organization_members_update on core.organization_members
  for update
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('org.members.manage'))
  )
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('org.members.manage'))
  );

-- Los catálogos de rol y permiso no tienen datos de organización: son
-- globales. Se pueden leer sin sesión (son la definición del sistema, no
-- información de un cliente) y no se pueden escribir desde la aplicación.
alter table core.roles enable row level security;
alter table core.permissions enable row level security;
alter table core.role_permissions enable row level security;

create policy roles_select on core.roles for select using (true);
create policy permissions_select on core.permissions for select using (true);
create policy role_permissions_select on core.role_permissions for select using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Timestamps automáticos
-- ─────────────────────────────────────────────────────────────────────────────

create trigger organizations_touch_updated_at
  before update on core.organizations
  for each row execute function private.touch_updated_at();

create trigger organization_members_touch_updated_at
  before update on core.organization_members
  for each row execute function private.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos SQL
--
-- Se revoca PUBLIC antes de conceder: el default de Postgres es permitir todo a
-- PUBLIC, y las políticas de RLS son la capa de arriba, no la sustituta.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on all tables in schema core from anon, authenticated;
revoke all on all sequences in schema core from anon, authenticated;

alter default privileges in schema core revoke all on tables from anon, authenticated;
alter default privileges in schema core revoke all on sequences from anon, authenticated;

grant usage on schema core to anon, authenticated;

-- Lectura de los catálogos globales sin sesión.
grant select on core.roles, core.permissions, core.role_permissions to anon, authenticated;

-- Datos de la organización: solo lectura y actualización. Ni INSERT ni DELETE
-- directos: los concede el onboarding mediante funciones.
grant select, update on core.organizations to authenticated;
grant select, update on core.organization_members to authenticated;

-- Las políticas invocan estas funciones con los permisos del llamador, así que
-- sin EXECUTE la consulta fallaría con "permission denied" en vez de devolver
-- cero filas. Se concede a `anon` también para que unvisitante obtenga una
-- lista vacía, no un error 500.
grant usage on schema private to anon, authenticated;
grant execute on function private.touch_updated_at() to anon, authenticated;
grant execute on function private.try_uuid(text) to anon, authenticated;
grant execute on function private.current_organization_id() to anon, authenticated;
grant execute on function private.is_organization_member(uuid) to anon, authenticated;
grant execute on function private.has_permission(text) to anon, authenticated;
grant execute on function private.assert_permission(text) to anon, authenticated;
grant execute on function private.set_current_organization(uuid) to anon, authenticated;
