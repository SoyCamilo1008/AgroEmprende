-- Pruebas de la frontera multitenant y de las políticas de RLS.
--
-- Estas pruebas NO se ejecutan sin Docker: `pnpm db:test` levanta Supabase local.
-- En una máquina sin él, quién las ejecuta es el job `migrations` del CI, que sí
-- tiene Docker. Por eso el orden importa: si estas pruebas no han corrido nunca
-- contra la migración que escriben, no están verificadas.
--
-- El punto que se prueba aquí no es que la consulta devuelva filas, sino que
-- devuelva las filas correctas para CADA usuario. Un RLS que deja pasar de más
-- también "funciona": solo se nota cuando alguien de otra organización lee una
-- venta que no es suya.

begin;

select plan(16);

create schema if not exists tests;

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos de las propias herramientas de prueba
--
-- Las aserciones de pgTAP se ejecutan con el rol `authenticated` puesto, porque
-- la consulta que se evalúa DENTRO de `is(...)` tiene que correr con los grants
-- y las políticas reales: si el papel se quedara en superusuario, el RLS se
-- saltaría y la prueba mediría lo contrario de lo que dice medir.
--
-- PostgreSQL ya concede EXECUTE a PUBLIC sobre las funciones, así que lo que
-- falta es `usage` en el esquema donde vive pgtap, y ese esquema depende de
-- dónde lo instaló la CLI. Por eso se localiza en vez de suponerlo.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_pgtap_schema text;
begin
  select n.nspname into v_pgtap_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgtap';

  if v_pgtap_schema is null then
    raise exception 'pgtap no está instalado: estas pruebas no pueden ejecutarse';
  end if;

  execute format('grant usage on schema %I to anon, authenticated', v_pgtap_schema);
  execute format('grant execute on all functions in schema %I to anon, authenticated', v_pgtap_schema);

  -- Y se lo pone en el `search_path`: donde lo instala la CLI de Supabase no es
  -- `public`, y sin esto las aserciones no se resuelven y la prueba muere con
  -- "function is(...) does not exist", que dice bastante menos que la verdad.
  perform set_config('search_path', v_pgtap_schema || ', public', true);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Utilidades de las pruebas
-- ─────────────────────────────────────────────────────────────────────────────

-- Los ids del escenario se guardan en una tabla, no en variables de la consulta.
-- La alternativa (buscar el usuario con un `select` sobre una tabla protegida)
-- es circular: esa búsqueda ya está filtrada por RLS, así que para encontrar al
-- propietario de la organización A habría que poder leer la organización A.
create table tests.scenario (
  key text primary key,
  value uuid not null
);

grant usage on schema tests to anon, authenticated;
grant select on tests.scenario to anon, authenticated;

create function tests.id(p_key text)
returns uuid
language sql
stable
as $$
  select value from tests.scenario where key = p_key
$$;

grant execute on function tests.id(text) to anon, authenticated;

-- Crea un usuario en auth.users. Los helper de Supabase (`tests.create_supabase_user`)
-- son la vía recomendada, pero esta función deja el test legible y no depende de
-- la firma exacta de un helper que cambia entre versiones de la CLI.
create function tests.make_user()
returns uuid
language sql
as $$
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  values (
    gen_random_uuid(),
    gen_random_uuid()::text || '@test.local',
    '{}'::jsonb,
    'authenticated',
    'authenticated'
  )
  returning id
$$;

grant execute on function tests.make_user() to anon, authenticated;

-- Actúa como un usuario: fija el JWT de la petición. `auth.uid()` lee
-- `request.jwt.claims` ->> 'sub', que es exactamente lo que lee en producción.
--
-- `is_local = true` porque el cambio debe morir con la transacción de prueba: si
-- se filtrara a la siguiente, un `act_as` sería motivo de que otra prueba pasara
-- sin sesión.
create function tests.act_as(p_user_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
    true
  );
end;
$$;

grant execute on function tests.act_as(uuid) to anon, authenticated;

-- Deja la petición sin sesión. `auth.uid()` pasa a ser NULL, que es el estado
-- real de una llamada sin JWT, no un estado que solo existe en las pruebas.
create function tests.clear_session()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

grant execute on function tests.clear_session() to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Escenario
--
-- Dos organizaciones con un dueño cada una, más un observador en la primera.
-- Todo se crea con la función de onboarding, no con INSERT directos: así se
-- prueba también el camino real y no un atajo que solo existe en el test.
-- ─────────────────────────────────────────────────────────────────────────────

create function tests.build_scenario()
returns void
language plpgsql
as $$
declare
  v_owner_a uuid := tests.make_user();
  v_owner_b uuid := tests.make_user();
  v_viewer_a uuid := tests.make_user();
  v_org_a uuid;
  v_org_b uuid;
  v_bu_a uuid;
  v_bu_b uuid;
  v_customer_a uuid;
begin
  perform tests.act_as(v_owner_a);
  select (r ->> 'organization_id')::uuid, (r ->> 'business_unit_id')::uuid
  into v_org_a, v_bu_a
  from public.create_organization_with_business_unit(
    'Granja de prueba A', 'PONEDORAS', 'Ponedoras de prueba', 'poultry_layers'
  ) as r;

  perform tests.act_as(v_owner_b);
  select (r ->> 'organization_id')::uuid, (r ->> 'business_unit_id')::uuid
  into v_org_b, v_bu_b
  from public.create_organization_with_business_unit(
    'Granja de prueba B', 'CERDOS', 'Cerdos de prueba', 'swine'
  ) as r;

  perform tests.act_as(v_owner_a);
  insert into core.organization_members (organization_id, user_id, role_code)
  values (v_org_a, v_viewer_a, 'viewer');

  perform tests.act_as(v_owner_a);
  insert into core.customers (organization_id, name)
  values (v_org_a, 'Cliente de la organización A')
  returning id into v_customer_a;

  perform tests.act_as(v_owner_b);
  insert into core.customers (organization_id, name)
  values (v_org_b, 'Cliente de la organización B');

  insert into tests.scenario (key, value) values
    ('user_owner_a', v_owner_a),
    ('user_owner_b', v_owner_b),
    ('user_viewer_a', v_viewer_a),
    ('org_a', v_org_a),
    ('org_b', v_org_b),
    ('bu_a', v_bu_a),
    ('bu_b', v_bu_b),
    ('customer_a', v_customer_a)
  on conflict (key) do update set value = excluded.value;
end;
$$;

grant execute on function tests.build_scenario() to anon, authenticated;

select tests.build_scenario();

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-4. Aislamiento entre organizaciones
-- ─────────────────────────────────────────────────────────────────────────────

set local role authenticated;
select tests.clear_session();

select is(
  (select count(*) from core.customers),
  0::bigint,
  'sin sesión no se ve ningún cliente'
);

select tests.act_as(tests.id('user_owner_a'));

select is(
  (select count(*) from core.customers),
  1::bigint,
  'el dueño de A solo ve el cliente de su propia organización'
);

select is(
  (select name from core.customers where organization_id <> tests.id('org_a')),
  null::text,
  'el dueño de A no alcanza a leer el cliente de B'
);

select tests.act_as(tests.id('user_owner_b'));

select is(
  (select count(*) from core.customers),
  1::bigint,
  'el dueño de B ve su cliente y no el de A'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5-6. Escrituras por fuera del camino permitido
-- ─────────────────────────────────────────────────────────────────────────────

select tests.act_as(tests.id('user_owner_a'));

select throws_ok(
  $$ insert into core.organizations (name, created_by)
     values ('Organización infiltrada', auth.uid()) $$,
  '42501',
  null,
  'no se puede crear una organización con insert directo: solo por la función de onboarding'
);

select throws_ok(
  $$ update core.roles set name = 'Dueño' where code = 'viewer' $$,
  '42501',
  null,
  'no se puede modificar un rol del sistema'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7-10. Permisos por rol
-- ─────────────────────────────────────────────────────────────────────────────

select tests.act_as(tests.id('user_viewer_a'));

select throws_ok(
  $$ insert into core.customers (organization_id, name)
     values ((select private.current_organization_id()), 'Cliente creado por el observador') $$,
  '42501',
  null,
  'un observador no puede escribir clientes'
);

select is(
  (select private.has_permission('customers.read')),
  true,
  'un observador sí puede leer clientes'
);

select is(
  (select private.has_permission('finance.profit.read')),
  false,
  'un observador no puede ver la utilidad consolidada'
);

select is(
  (select count(*) from core.audit_log),
  0::bigint,
  'un observador no lee la auditoría, ni la de su propia organización'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 11-13. El contexto se toma de la sesión, no del cuerpo de la petición
-- ─────────────────────────────────────────────────────────────────────────────

select tests.act_as(tests.id('user_owner_a'));

select is(
  (select private.current_organization_id()),
  tests.id('org_a'),
  'el contexto se resuelve solo cuando el usuario tiene una organización'
);

-- Contexto explícito de una organización a la que NO pertenece: se rechaza.
select is(
  (select private.set_current_organization(tests.id('org_b'))),
  false::boolean,
  'no se puede fijar como contexto una organización ajena'
);

select is(
  (select private.current_organization_id()),
  tests.id('org_a'),
  'el intento de contexto ajeno no reemplaza el contexto propio'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. Onboarding idempotente
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select (r ->> 'created')::boolean
   from public.create_organization_with_business_unit(
     'Granja de prueba A', 'PONEDORAS', 'Ponedoras de prueba', 'poultry_layers'
   ) as r),
  false,
  'volver a crear la organización devuelve la existente en vez de duplicarla'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 15-16. Cuentas base y auditoría
--
-- El plan de cuentas se compara con la plantilla GLOBAL, y la auditoría con la
-- de la organización del dueño: `audit_log_select` filtra por
-- `current_organization_id()`, así que el dueño de A ve su alta y no la de B.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from core.accounts where is_system),
  (select count(*) from core.account_templates),
  'el onboarding copió todas las cuentas de la plantilla'
);

select is(
  (select count(*) from core.audit_log where action = 'organization.created'),
  1::bigint,
  'se auditó la creación de la organización del dueño, y solo la suya'
);

select * from finish();
rollback;
