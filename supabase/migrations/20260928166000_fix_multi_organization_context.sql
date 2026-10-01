-- description: Contexto de organizacion por peticion para usuarios con varias organizaciones, y listado de las organizaciones propias.
-- depends_on: 20260928163000_create_finance_payments.sql

-- Contexto multi-organizacion por cabecera.
--
-- El problema que arregla esta migracion
-- -------------------------------------
-- `private.set_current_organization()` fija `app.current_organization_id` con
-- `set_config(..., true)`, es decir SOLO durante la transaccion en curso. Con
-- PostgREST cada peticion es una transaccion, asi que esa marca muere al
-- terminar la llamada RPC: la siguiente peticion del cliente llega sin contexto.
--
-- Eso deja sin salida a quien pertenece a mas de una organizacion:
--
--   1. `current_organization_id()` devuelve NULL (su unico caso de exito es
--      "tengo exactamente una organizacion activa"), asi que TODAS las politicas
--      niegan y la aplicacion se ve vacia.
--   2. Peor: `organization_members_select` exige
--      `organization_id = current_organization_id()`, de modo que tampoco puede
--      LEER sus propias membresias. No hay forma de construir el selector de
--      organizacion, porque el dato que lo alimenta esta filtrado por el dato
--      que falta. No es un caso raro: la invitacion multi-organizacion es una
--      funcion publicada del producto.
--
-- Que se hace aqui
-- ----------------
-- Una segunda via de contexto, leida de la CABECERA `x-organization-id`:
--
--   - PostgREST expone las cabeceras de la peticion en
--     `current_setting('request.headers')` como un json. Es por peticion, no
--     por conexion: sobrevive al pool de conexiones, que es justamente donde un
--     `set_config(..., false)` seria un agujero de fuga entre usuarios.
--   - supabase-js la envia en cada llamada (`client.headers({...})`).
--
-- Y una funcion de solo lectura para listar las organizaciones propias.
--
-- Lo que NO se hace aqui, a proposito
-- -----------------------------------
-- - No se acepta `organizationId` en el cuerpo de una consulta: las funciones de
--   negocio siguen validando contra `current_organization_id()`, no contra un
--   dato del cliente.
-- - No se relaja ninguna politica. La cabecera no concede acceso por si sola:
--   pasa por `is_organization_member`, igual que la via que ya existia. Un
--   `x-organization-id` de otra organizacion produce NULL, y NULL en una
--   politica es denegar: sigue siendo fail-closed.
-- - No se toca `set_current_organization()`: sigue siendo la via para un
--   `set` y una escritura en la misma transaccion, que es lo que hacen las
--   pruebas.
--
-- Orden de resolucion (el primero que valida como miembro activo gana):
--   1. `app.current_organization_id` (GUC, misma transaccion).
--   2. Cabecera `x-organization-id`.
--   3. La unica organizacion activa del usuario, si tiene exactamente una.
--   4. NULL.

-- ─────────────────────────────────────────────────────────────────────────────
-- La cabecera de la peticion
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.request_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.try_uuid(
    (
      select value
      from jsonb_each_text(
        coalesce(
          nullif(current_setting('request.headers', true), '')::jsonb,
          '{}'::jsonb
        )
      ) as h(key, value)
      where lower(h.key) = 'x-organization-id'
      limit 1
    )
  )
$$;

comment on function private.request_organization_id() is
  'Organizacion de la cabecera `x-organization-id` de la peticion, o NULL. Solo se usa si valida como membresia activa; la cabecera por si sola no concede nada.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Contexto efectivo: la misma funcion, con la cabecera como segunda via
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
    (
      -- Segunda via: la cabecera de la peticion. Se revalida contra la
      -- membresia igual que la anterior; no se confiar en el valor.
      select m.organization_id
      from core.organization_members m
      where m.organization_id = private.request_organization_id()
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
  'Organizacion activa de la peticion, o NULL. Nunca inventa una: sin contexto valido (GUC, cabecera x-organization-id o organizacion unica), no hay acceso.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Las organizaciones propias
--
-- Rompe el deadlock descrito arriba: es la unica lectura que necesita el
-- cliente ANTES de tener contexto, porque responde "en quais organizaciones
-- puedo entrar".
--
-- No recibe ningun parametro. El filtro es `auth.uid()`, o sea lo decide la
-- sesion y no el llamador: no hay forma de pedir las de otro usuario. Y como no
-- filtra por organizacion activa, RLS no aplica (la funcion corre como el dueno)
-- y por eso no se puede usar para leer datos de negocio: solo nombres de
-- organizacion y el rol que uno ya tiene en ella.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.my_organizations()
returns table (organization_id uuid, name text, role_code text, timezone text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name, m.role_code, o.timezone
  from core.organization_members m
  join core.organizations o on o.id = m.organization_id
  where m.user_id = (select auth.uid())
    and m.is_active
    and o.is_active
  order by o.name
$$;

comment on function private.my_organizations() is
  'Organizaciones activas del usuario actual, con su rol. No recibe parametros: el filtro es auth.uid(), asi que no permite enumerar las de otra persona. Es la lectura previa a tener contexto de organizacion.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos
-- ─────────────────────────────────────────────────────────────────────────────

grant execute on function private.request_organization_id() to anon, authenticated;
grant execute on function private.my_organizations() to authenticated;

revoke all on function private.request_organization_id() from public;
revoke all on function private.my_organizations() from public;