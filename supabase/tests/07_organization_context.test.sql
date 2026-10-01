-- Contexto de organizacion por peticion para usuarios con varias organizaciones.
--
-- Estas pruebas NO se ejecutan sin Docker: las corre el job de migraciones del CI.
--
-- Que se prueba
-- -------------
-- La migracion `20260928166000_fix_multi_organization_context.sql` anade una
-- segunda via de contexto (cabecera `x-organization-id`) y la funcion
-- `private.my_organizations()`, porque con solo la via GUC un usuario en varias
-- organizaciones no podia ver nada ni listar sus propias organizaciones.
--
-- Lo que importa aqui NO es que la cabecera funcione, sino que siga sin ser una
-- puerta trasera: una organizacion ajena, un valor malformado o una cabecera
-- ausente tienen que terminar en NULL, y NULL en una politica es denegar. Un
-- arreglo que abriera el RLS habria sido peor que el problema.

begin;

select plan(21);

create schema if not exists tests;

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
  perform set_config('search_path', v_pgtap_schema || ', public', true);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Utilidades (mismo arnés que 01_multitenant_rls.test.sql)
-- ─────────────────────────────────────────────────────────────────────────────

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

create function tests.clear_session()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

grant execute on function tests.clear_session() to anon, authenticated;

-- Fija la cabecera de la peticion, como haria PostgREST con las cabeceras HTTP.
-- `is_local = true` para que muera con la transaccion de prueba.
create function tests.set_org_header(p_organization_id text)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.headers',
    json_build_object('x-organization-id', p_organization_id)::text,
    true
  );
end;
$$;

grant execute on function tests.set_org_header(text) to anon, authenticated;

create function tests.clear_org_header()
returns void
language plpgsql
as $$
begin
  perform set_config('request.headers', '{}'::jsonb::text, true);
end;
$$;

grant execute on function tests.clear_org_header() to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Escenario
--
--   org_a, org_b: cada una con su dueño y un cliente propio.
--   multi:      miembro ACTIVO de las dos (el caso que estaba roto).
--   outsider:   miembro de org_c, que `multi` no conoce.
-- ─────────────────────────────────────────────────────────────────────────────

create function tests.build_scenario()
returns void
language plpgsql
as $$
declare
  v_owner_a uuid := tests.make_user();
  v_multi uuid := tests.make_user();
  v_outsider uuid := tests.make_user();
  v_org_a uuid;
  v_org_b uuid;
  v_org_c uuid;
begin
  perform tests.act_as(v_owner_a);
  select (r ->> 'organization_id')::uuid
  into v_org_a
  from public.create_organization_with_business_unit(
    'Granja contexto A', 'PONEDORAS', 'Ponederas contexto A', 'poultry_layers'
  ) as r;

  perform tests.act_as(tests.make_user());
  select (r ->> 'organization_id')::uuid
  into v_org_b
  from public.create_organization_with_business_unit(
    'Granja contexto B', 'CERDOS', 'Cerdos contexto B', 'swine'
  ) as r;

  perform tests.act_as(v_outsider);
  select (r ->> 'organization_id')::uuid
  into v_org_c
  from public.create_organization_with_business_unit(
    'Granja contexto C', 'PONEDORAS', 'Ponederas contexto C', 'poultry_layers'
  ) as r;

  -- El usuario multiservidor en las dos organizaciones del caso.
  insert into core.organization_members (organization_id, user_id, role_code)
  values (v_org_a, v_multi, 'admin'), (v_org_b, v_multi, 'operator');

  insert into core.customers (organization_id, name) values (v_org_a, 'Cliente de A');
  insert into core.customers (organization_id, name) values (v_org_b, 'Cliente de B');
  insert into core.customers (organization_id, name) values (v_org_c, 'Cliente de C');

  insert into tests.scenario (key, value) values
    ('owner_a', v_owner_a),
    ('multi', v_multi),
    ('outsider', v_outsider),
    ('org_a', v_org_a),
    ('org_b', v_org_b),
    ('org_c', v_org_c);
end;
$$;

select tests.build_scenario();

set local role authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- La cabecera fija el contexto de un usuario en varias organizaciones
-- ─────────────────────────────────────────────────────────────────────────────

select tests.act_as(tests.id('multi'));
select tests.set_org_header(tests.id('org_a')::text);

select is(
  (select private.current_organization_id()),
  tests.id('org_a'),
  '1: la cabecera x-organization-id fija el contexto'
);

select is(
  (select count(*) from core.customers where name = 'Cliente de A'),
  1::bigint,
  '2: con contexto en A ve el cliente de A'
);

select is(
  (select count(*) from core.customers where name = 'Cliente de B'),
  0::bigint,
  '3: con contexto en A NO ve el cliente de B'
);

select is(
  (select count(*) from core.customers where name = 'Cliente de C'),
  0::bigint,
  '4: con contexto en A NO ve el cliente de una tercera organización'
);

-- El mismo usuario cambia de organización en la siguiente petición: cambia el
-- rol con el que se le evalúan los permisos (admin en A, operator en B).
select is(
  (
    select role_code
    from core.organization_members
    where organization_id = tests.id('org_a') and user_id = tests.id('multi')
  ),
  'admin'::text,
  '5: en A sus membresías son las de A'
);

select tests.set_org_header(tests.id('org_b')::text);

select is(
  (select private.current_organization_id()),
  tests.id('org_b'),
  '6: la cabecera cambia el contexto a B en la siguiente petición'
);

select is(
  (select count(*) from core.customers where name = 'Cliente de B'),
  1::bigint,
  '7: con contexto en B ve el cliente de B'
);

select is(
  (select count(*) from core.customers where name = 'Cliente de A'),
  0::bigint,
  '8: con contexto en B ya NO ve el cliente de A'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- La cabecera NO es una puerta trasera: sigue siendo fail-closed
-- ─────────────────────────────────────────────────────────────────────────────

select tests.set_org_header(tests.id('org_c')::text);

select is(
  (select private.current_organization_id()),
  null::uuid,
  '9: una cabecera de una organización ajena produce NULL, no acceso'
);

select is(
  (select count(*) from core.customers),
  0::bigint,
  '10: sin contexto válido no se ve ningún cliente'
);

select tests.set_org_header('no-es-un-uuid');

select is(
  (select private.current_organization_id()),
  null::uuid,
  '11: una cabecera malformada produce NULL en vez de un error'
);

select tests.clear_org_header();

select is(
  (select private.current_organization_id()),
  null::uuid,
  '12: sin cabecera y con varias organizaciones, NULL (fail-closed se mantiene)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sin regresión: organization unica y via GUC
-- ─────────────────────────────────────────────────────────────────────────────

select tests.clear_org_header();
select tests.act_as(tests.id('owner_a'));

select is(
  (select private.current_organization_id()),
  tests.id('org_a'),
  '13: un usuario de una sola organización resuelve sin cabecera (sin regresión)'
);

-- El GUC de la misma transacción tiene prioridad sobre la cabecera: es el caso
-- de un `set` seguido de una escritura en la misma petición.
select set_config('app.current_organization_id', tests.id('org_b')::text, true);

select is(
  (select private.current_organization_id()),
  tests.id('org_b'),
  '14: el GUC de la misma transacción tiene prioridad sobre la cabecera'
);

select set_config('app.current_organization_id', '', true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Las organizaciones propias: la lectura que rompe el deadlock
--
-- Es la única consulta que el cliente puede hacer ANTES de tener contexto, así
-- que se prueba también que no sirve para mirar dentro de otra organización.
-- ─────────────────────────────────────────────────────────────────────────────

reset role;

select tests.clear_org_header();
select tests.act_as(tests.id('multi'));

select is(
  (select count(*) from private.my_organizations()),
  2::bigint,
  '15: el usuario multi ve sus dos organizaciones'
);

select is(
  (
    select count(*)
    from private.my_organizations()
    where organization_id = tests.id('org_a')
  ),
  1::bigint,
  '16: su lista incluye la organización A'
);

select is(
  (
    select count(*)
    from private.my_organizations()
    where organization_id = tests.id('org_c')
  ),
  0::bigint,
  '17: su lista NO incluye una organización de la que no es miembro'
);

select is(
  (
    select role_code
    from private.my_organizations()
    where organization_id = tests.id('org_b')
  ),
  'operator'::text,
  '18: la lista trae el rol que tiene en cada una'
);

select tests.act_as(tests.id('outsider'));

select is(
  (select count(*) from private.my_organizations()),
  1::bigint,
  '19: no se pueden enumerar las organizaciones de otro usuario'
);

select tests.clear_session();

select is(
  (select count(*) from private.my_organizations()),
  0::bigint,
  '20: sin sesión la lista está vacía, no es un error'
);

-- Sin sesión ni rol `authenticated` la lista se vacía en vez de fallar, como el
-- resto de lecturas del catálogo.
set local role anon;
select tests.clear_session();

select is(
  (select count(*) from private.my_organizations()),
  0::bigint,
  '21: un anónimo sin sesión obtiene una lista vacía, no un error 500'
);

reset role;

select * from finish();
rollback;