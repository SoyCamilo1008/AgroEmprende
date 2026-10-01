-- Alta y edicion de clientes y contactos dejan rastro de quien las hizo.
--
-- Estas pruebas NO se ejecutan sin Docker: las corre el job de migraciones del CI.
--
-- Que se prueba
-- -------------
-- Ventas, pagos, gastos e inversiones escriben en `core.audit_log` porque todas
-- pasan por funciones SECURITY DEFINER. Los clientes no: se escriben por DML
-- directo y sus politicas RLS solo miran organizacion y permiso. Antes de la
-- migracion `20260928170000`, cambiar los dias de credito de un cliente no
-- dejaba ningun rastro.
--
-- Lo que importa no es que exista una fila de auditoria, sino que diga QUIEN y
-- QUE cambio. Una auditoria que solo dice "se actualizo el cliente" no sirve
-- para nada, asi que se comprueba que un campo que no se toco no aparezca, y que
-- la organizacion ajena no pueda ni leer el rastro ni tocar el cliente.

begin;

select plan(26);

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
-- Escenario: dos organizaciones con un dueño cada una.
--
-- El cliente se crea aqui dentro de la prueba, no en el escenario, para que el
-- conteo de auditoria sea exacto y no dependa de las altas previas.
-- ─────────────────────────────────────────────────────────────────────────────

create function tests.build_scenario()
returns void
language plpgsql
as $$
declare
  v_owner_a uuid := tests.make_user();
  v_owner_b uuid := tests.make_user();
  v_org_a uuid;
  v_org_b uuid;
begin
  perform tests.act_as(v_owner_a);
  select (r ->> 'organization_id')::uuid
  into v_org_a
  from public.create_organization_with_business_unit(
    'Granja auditoría A', 'PONEDORAS', 'Ponederas auditoría', 'poultry_layers'
  ) as r;

  perform tests.act_as(v_owner_b);
  select (r ->> 'organization_id')::uuid
  into v_org_b
  from public.create_organization_with_business_unit(
    'Granja auditoría B', 'CERDOS', 'Cerdos auditoría', 'swine'
  ) as r;

  insert into tests.scenario (key, value) values
    ('owner_a', v_owner_a),
    ('owner_b', v_owner_b),
    ('org_a', v_org_a),
    ('org_b', v_org_b);
end;
$$;

select tests.build_scenario();

set local role authenticated;
select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- A. El alta de un cliente queda registrada
-- ─────────────────────────────────────────────────────────────────────────────

create temp table au (customer_id uuid);

with created as (
  insert into core.customers (organization_id, name, credit_days, notes)
  values (tests.id('org_a'), 'Cliente auditado', 30, 'compra todas las semanas')
  returning id
)
insert into au (customer_id) select id from created;

select is(
  (select count(*) from core.customers where id = (select customer_id from au)),
  1::bigint,
  '1: el cliente se creó'
);

select is(
  (select count(*) from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.insert'),
  1::bigint,
  '2: el alta dejó exactamente una entrada de auditoría'
);

select is(
  (select entity_type from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.insert'),
  'core.customers',
  '3: la entrada dice sobre qué entidad es'
);

select is(
  (select actor_id from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.insert'),
  tests.id('owner_a'),
  '4: la entrada dice QUIÉN creó el cliente'
);

select is(
  (select organization_id from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.insert'),
  tests.id('org_a'),
  '5: la auditoría queda en la organización del cliente, no en otra'
);

select is(
  (select new_values ->> 'name' from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.insert'),
  'Cliente auditado',
  '6: la auditoría guarda el nombre con el que se creó'
);

select is(
  (select new_values ->> 'credit_days' from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.insert'),
  '30',
  '7: la auditoría guarda los días de crédito iniciales'
);

select is(
  (select old_values from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.insert'),
  null::jsonb,
  '8: un alta no tiene valores anteriores'
);

select is(
  (select new_values ? 'updated_at' from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.insert'),
  false,
  '9: updated_at no se audita: en un alta es el mismo created_at'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- B. La modificación dice QUÉ cambió, no "cambió algo"
-- ─────────────────────────────────────────────────────────────────────────────

update core.customers
set credit_days = 45
where id = (select customer_id from au);

select is(
  (select count(*) from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.update'),
  1::bigint,
  '10: el cambio de días de crédito dejó una entrada'
);

select is(
  (select old_values ->> 'credit_days' from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.update'),
  '30',
  '11: la auditoría guarda el valor anterior'
);

select is(
  (select new_values ->> 'credit_days' from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.update'),
  '45',
  '12: la auditoría guarda el valor nuevo'
);

select is(
  (select old_values ? 'name' from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.update'),
  false,
  '13: un campo que no cambió no aparece en la auditoría'
);

select is(
  (select new_values ? 'name' from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.update'),
  false,
  '14: ni en los valores nuevos'
);

select is(
  (select jsonb_object_length(new_values) from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.update'),
  1,
  '15: la entrada tiene un solo campo, el que de verdad se movió'
);

select is(
  (select new_values ? 'updated_at' from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.update'),
  false,
  '16: updated_at se descarta: lo cambia el trigger en cada modificación'
);

-- Guardar el formulario sin tocar un solo campo no es un cambio. Si se auditara,
-- el registro se llenaría de entradas idénticas y el cambio que sí importa
-- quedaría enterrado.
update core.customers
set name = name
where id = (select customer_id from au);

select is(
  (select count(*) from core.audit_log
   where entity_id = (select customer_id from au) and action = 'customers.update'),
  1::bigint,
  '17: guardar sin cambiar nada no genera una entrada más'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Los contactos también dejan rastro
--
-- El contacto es quien realmente recibe la llamada de cobro. Saber quién lo
-- editó vale lo mismo que saber quién editó al cliente.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table auc (contact_id uuid);

with created as (
  insert into core.customer_contacts (organization_id, customer_id, name, role, phone)
  values (
    tests.id('org_a'), (select customer_id from au),
    'María López', 'Dueño de compra', '3101234567'
  )
  returning id
)
insert into auc (contact_id) select id from created;

select is(
  (select count(*) from core.audit_log
   where entity_id = (select contact_id from auc) and action = 'customer_contacts.insert'),
  1::bigint,
  '18: el alta del contacto queda auditada'
);

select is(
  (select actor_id from core.audit_log
   where entity_id = (select contact_id from auc) and action = 'customer_contacts.insert'),
  tests.id('owner_a'),
  '19: con el actor que lo creó'
);

update core.customer_contacts
set is_primary = true
where id = (select contact_id from auc);

select is(
  (select new_values ->> 'is_primary' from core.audit_log
   where entity_id = (select contact_id from auc) and action = 'customer_contacts.update'),
  'true',
  '20: el cambio del contacto se registra'
);

select is(
  (select jsonb_object_length(new_values) from core.audit_log
   where entity_id = (select contact_id from auc) and action = 'customer_contacts.update'),
  1,
  '21: y registra solo el campo que cambió'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- D. La auditoría no se puede falsificar ni se filtra entre organizaciones
--
-- Si el cliente pudiera escribir en `core.audit_log`, el rastro no valdría
-- nada: bastaría con insertar a mano la entrada que uno mismo quiere ver.
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$
    insert into core.audit_log (organization_id, action, entity_type, entity_id)
    values (tests.id('org_a'), 'customers.update', 'core.customers', tests.id('owner_a'))
  $$,
  '42501',
  null,
  '22: el cliente no puede escribir entradas de auditoría a mano'
);

select is(
  (select count(*) from core.audit_log where organization_id = tests.id('org_b')),
  0::bigint,
  '23: una organización no ve la auditoría de la otra'
);

select tests.act_as(tests.id('owner_b'));
select tests.set_org_header(tests.id('org_b')::text);

select is(
  (select count(*) from core.audit_log where entity_id = (select customer_id from au)),
  0::bigint,
  '24: el dueño ajeno no ve el rastro del cliente de la otra organización'
);

-- RLS filtra la fila en la cláusula USING: la actualización no toca ni una, y
-- PostgreSQL no lanza error, simplemente no cambia nada.
with attempted as (
  update core.customers set credit_days = 999
  where id = (select customer_id from au)
  returning 1
)
select is(
  (select count(*) from attempted),
  0::bigint,
  '25: ni puede editarlo en silencio: la actualización no afecta ninguna fila'
);

select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

select is(
  (select credit_days from core.customers where id = (select customer_id from au)),
  45::integer,
  '26: los días de crédito siguen siendo los que dejó su dueño'
);

select * from finish();
rollback;