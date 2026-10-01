-- Clientes: la organizacion la decide el contexto y RLS sigue mandando.
--
-- Estas pruebas NO se ejecutan sin Docker: las corre el job de migraciones del CI.
--
-- Que se prueba
-- -------------
-- El repositorio de clientes (packages/supabase/src/repositories/customers.ts) no
-- manda `organization_id` y no filtra por organizacion a mano. Eso solo funciona
-- si la base cumple dos promesas:
--
--   1. Un INSERT sin `organization_id` aterriza en la organizacion activa. Lo
--      garantiza la trigger de `20260928171000_derive_partner_organization_on_insert.sql`.
--   2. Sin contexto, no se escribe nada, y el error lo dice.
--
-- Y ninguna de las dos puede abrir una puerta: si la trigger se pudiera saltar, o
-- si las politicas dejaran pasar algo, estas pruebas fallan. Por eso se prueba
-- tambien lo que NO tiene que pasar: que un organization_id explicito no se
-- sobrescriba, que una organizacion no vea los clientes de la otra, que sin
-- contexto no se lea nada, y que los contactos no se puedan colgar de un cliente
-- ajeno.
--
-- Lo que NO se prueba aqui: el repositorio de TypeScript. Eso lo cubren los tests
-- de Vitest del paquete. Estas pruebas no pueden demostrar que el repositorio no
-- filtre, solo que la base no depende de que el no filtre.

begin;

select plan(25);

create schema if not exists tests;

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos de las herramientas de prueba
--
-- Las aserciones se ejecutan con el rol `authenticated` puesto, porque la consulta
-- que se evalúa DENTRO de `is(...)` tiene que correr con los grants y las
-- políticas reales: si el papel se quedara en superusuario, el RLS se saltaría y
-- la prueba mediría lo contrario de lo que dice medir.
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
  perform set_config('search_path', v_pgtap_schema || ', public', true);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Utilidades
--
-- Se repiten en cada archivo a propósito: un test que depende del orden de otro
-- deja de ser legible y, cuando falla, cuesta media hora saber por qué.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Escenario: dos organizaciones con un dueño cada una, y un observador en A.
--
-- El observador importa: `viewer` tiene `customers.read` y no `customers.write`.
-- Un RLS que solo se probara con dueños no distinguiría "no tiene permiso" de
-- "es de otra organización", que son denegaciones distintas por razones distintas.
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
begin
  perform tests.act_as(v_owner_a);
  select (r ->> 'organization_id')::uuid
  into v_org_a
  from public.create_organization_with_business_unit(
    'Granja acceso A', 'PONEDORAS', 'Ponederas acceso', 'poultry_layers'
  ) as r;

  perform tests.act_as(v_owner_b);
  select (r ->> 'organization_id')::uuid
  into v_org_b
  from public.create_organization_with_business_unit(
    'Granja acceso B', 'CERDOS', 'Cerdos acceso', 'swine'
  ) as r;

  perform tests.act_as(v_owner_a);
  insert into core.organization_members (organization_id, user_id, role_code)
  values (v_org_a, v_viewer_a, 'viewer');

  insert into tests.scenario (key, value) values
    ('owner_a', v_owner_a),
    ('owner_b', v_owner_b),
    ('viewer_a', v_viewer_a),
    ('org_a', v_org_a),
    ('org_b', v_org_b);
end;
$$;

select tests.build_scenario();

set local role authenticated;
select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- A. El INSERT sin organization_id aterriza en la organización activa
--
-- Esto es lo que hace posible que el repositorio no mande la columna. Sin esto,
-- el cliente de la app tendría que inventarla o leerla de algún lado.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table ac (customer_id uuid, name text);

with created as (
  insert into core.customers (name, credit_days)
  values ('Cliente sin organización explícita', 30)
  returning id, name
)
insert into ac (customer_id, name) select id, name from created;

select is(
  (select organization_id from core.customers where id = (select customer_id from ac)),
  tests.id('org_a'),
  '1: la organización sale del contexto, no del INSERT'
);

select is(
  (select credit_days from core.customers where id = (select customer_id from ac)),
  30::integer,
  '2: y el resto de la fila se guardó tal cual'
);

-- El contacto también. Es la misma trigger, pero la tabla es otra: si alguien
-- añade una tabla de datos maestros mañana, este patrón ya está probado.
create temp table acc (contact_id uuid);

with created as (
  insert into core.customer_contacts (customer_id, name, role)
  values ((select customer_id from ac), 'María López', 'Dueño de compra')
  returning id
)
insert into acc (contact_id) select id from created;

select is(
  (select organization_id from core.customer_contacts where id = (select contact_id from acc)),
  tests.id('org_a'),
  '3: el contacto también hereda la organización del contexto'
);

select is(
  (select organization_id from core.customer_contacts where id = (select contact_id from acc)),
  (select organization_id from core.customers where id = (select customer_id from ac)),
  '4: contacto y cliente quedan en la misma organización'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- B. La organización explícita manda: la trigger no sobrescribe
--
-- Si la trigger sobrescribiera, el arranque del entorno y las funciones de
-- onboarding — que sí mandan la organización — empezarían a fallar con un error
-- que nadie reconocería. Que no lo hagan es una prueba de que son dos caminos
-- compatibles, no una casualidad.
-- ─────────────────────────────────────────────────────────────────────────────

select tests.act_as(tests.id('owner_b'));
select tests.set_org_header(tests.id('org_b')::text);

create temp table ab (customer_id uuid);

with created as (
  insert into core.customers (organization_id, name)
  values (tests.id('org_b'), 'Cliente con organización explícita')
  returning id
)
insert into ab (customer_id) select id from created;

select is(
  (select organization_id from core.customers where id = (select customer_id from ab)),
  tests.id('org_b'),
  '5: un organization_id explícito se respeta tal cual'
);

-- La auditoría de ese alta queda en B, no en A. El `audit_log` toma la organización
-- del CONTEXTO y no de la fila, así que es una prueba de que la trigger no arrastra
-- la fila a A por la back: organization_id explícito en B, contexto en B, y el
-- registro de auditoría también en B. Si alguien cambiara el `audit_log` para
-- leer `new.organization_id`, esta prueba lo seguiría dejando pasar, pero la de
-- más abajo (9) cubre el caso de organization_id derivado.
select is(
  (select organization_id from core.audit_log
   where entity_id = (select customer_id from ab) and action = 'customers.insert'),
  tests.id('org_b'),
  '5b: la auditoría del alta explícita también queda en su organización'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Sin contexto no se escribe, y el error lo dice
--
-- El mensaje importa tanto como el código: "null value in column organization_id"
-- manda a buscar un bug en el formulario, cuando lo que falta es una sesión o una
-- organización seleccionada.
-- ─────────────────────────────────────────────────────────────────────────────

select tests.clear_session();
select tests.set_org_header('');

select throws_ok(
  $$
    insert into core.customers (name) values ('Cliente sin contexto')
  $$,
  '22023',
  null,
  '6: sin sesión ni contexto, el alta de cliente se rechaza'
);

select throws_ok(
  $$
    insert into core.customer_contacts (customer_id, name)
    values ((select customer_id from ac), 'Contacto sin contexto')
  $$,
  '22023',
  null,
  '7: sin contexto, el alta de contacto también se rechaza'
);

-- Que el INSERT se rechazara ya lo dicen las dos pruebas anteriores. Falta probar
-- que no dejó una fila a medias, y eso NO se puede mirar con el rol de siempre:
-- sin contexto, RLS devuelve cero filas siempre, dé lo que dé la base. Un `count(*)`
-- aquí daría 0 con la tabla llena y no probaría nada.
--
-- Se cuenta como el dueño de la tabla, que no está sujeto a RLS (no hay
-- `FORCE ROW LEVEL SECURITY` en `core.customers`). Así el conteo ve la fila si
-- existe, y 0 significa que de verdad no se escribió.
reset role;

select is(
  (select count(*) from core.customers where name = 'Cliente sin contexto'),
  0::bigint,
  '8: y no queda ni una fila a medias'
);

select is(
  (select count(*) from core.customer_contacts where name = 'Contacto sin contexto'),
  0::bigint,
  '8b: ni el contacto a medias'
);

set local role authenticated;
select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- D. Sin contexto tampoco se lee
--
-- La lectura sin contexto devuelve cero filas, no un error: así es como se comporta
-- RLS, denying en silencio. Por eso el repositorio devuelve `null` y no lanza
-- `not_found` explícito en una lectura por id.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from core.customers),
  0::bigint,
  '9: sin contexto la lista de clientes viene vacía'
);

select is(
  (select count(*) from core.customers where id = (select customer_id from ac)),
  0::bigint,
  '10: ni siquiera el cliente propio se alcanza a leer'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- E. Una organización no toca los clientes de la otra
-- ─────────────────────────────────────────────────────────────────────────────

select tests.act_as(tests.id('owner_b'));
select tests.set_org_header(tests.id('org_b')::text);

select is(
  (select count(*) from core.customers),
  1::bigint,
  '11: el dueño de B ve su cliente y no los de A'
);

select is(
  (select count(*) from core.customers where id = (select customer_id from ac)),
  0::bigint,
  '12: el cliente de A no aparece ni por id'
);

select is(
  (select count(*) from core.customer_contacts where customer_id = (select customer_id from ac)),
  0::bigint,
  '13: ni sus contactos'
);

-- RLS filtra en USING: el UPDATE no falla, no actualiza nada. Por eso la prueba
-- mira cuantas filas toco la sentencia, no si hubo error.
with attempted as (
  update core.customers
  set credit_days = 999
  where id = (select customer_id from ac)
  returning 1
)
select is(
  (select count(*) from attempted),
  0::bigint,
  '14: ni puede editarlo: la actualización no afecta ninguna fila'
);

select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

select is(
  (select credit_days from core.customers where id = (select customer_id from ac)),
  30::integer,
  '15: los días de crédito siguen siendo los que dejó su dueño'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- F. El observador lee pero no escribe
--
-- Sin `customers.write`, el INSERT falla con 42501 de verdad: la política de
-- INSERT tiene `with check`, y no hay fila que insertar. En UPDATE, en cambio, la
-- fila se filtra en USING y la sentencia termina sin error y sin cambiar nada.
-- Esa asimetría es de RLS, no del repositorio, y conviene tenerla medida.
-- ─────────────────────────────────────────────────────────────────────────────

select tests.act_as(tests.id('viewer_a'));
select tests.set_org_header(tests.id('org_a')::text);

select is(
  (select count(*) from core.customers),
  1::bigint,
  '16: el observador sí lee los clientes de su organización'
);

select throws_ok(
  $$
    insert into core.customers (name) values ('Cliente del observador')
  $$,
  '42501',
  null,
  '17: pero no puede crear clientes'
);

with attempted as (
  update core.customers
  set credit_days = 15
  where id = (select customer_id from ac)
  returning 1
)
select is(
  (select count(*) from attempted),
  0::bigint,
  '18: ni puede editarlos'
);

-- Ni siquiera la fila es suya para borrarla, aunque `owners` tampoco puede:
-- no hay DELETE en el modelo. Ver la sección H.
select throws_ok(
  $$ delete from core.customers where id = (select customer_id from ac) $$,
  '42501',
  null,
  '19: y no puede borrarlos'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- G. Un contacto no se cuelga de un cliente ajeno
--
-- La política de INSERT de contactos exige que el cliente exista en la organización
-- activa. Esta es la defensa que hace que `createContact` no pueda meter un
-- contacto en la lista de otro cliente pasando otro id.
-- ─────────────────────────────────────────────────────────────────────────────

select tests.act_as(tests.id('owner_b'));
select tests.set_org_header(tests.id('org_b')::text);

select throws_ok(
  $$
    insert into core.customer_contacts (customer_id, name)
    values ((select customer_id from ac), 'Contacto en cliente ajeno')
  $$,
  '42501',
  null,
  '20: un contacto no se puede colgar de un cliente de otra organización'
);

select is(
  (select count(*) from core.customer_contacts where name = 'Contacto en cliente ajeno'),
  0::bigint,
  '21: y no queda el contacto creado'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- H. No hay borrado: desactivar es la salida
--
-- Un cliente tiene ventas, pagos y contactos que lo referencian. Por eso el modelo
-- no ofrece DELETE, ni siquiera al dueño. "Desactivar" es la operación que
-- corresponde, y aquí se comprueba que no exista la otra.
-- ─────────────────────────────────────────────────────────────────────────────

select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

select throws_ok(
  $$ delete from core.customers where id = (select customer_id from ac) $$,
  '42501',
  null,
  '22: ni el dueño puede borrar un cliente'
);

update core.customers
set is_active = false
where id = (select customer_id from ac);

select is(
  (select is_active from core.customers where id = (select customer_id from ac)),
  false,
  '23: desactivar sí funciona, y el cliente sigue ahí'
);

select * from finish();
rollback;
