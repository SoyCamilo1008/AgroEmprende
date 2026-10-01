-- Terminos de credito del clienteapplied al flujo de ventas.
--
-- Estas pruebas NO se ejecutan sin Docker: las corre el job de migraciones del CI.
--
-- Que se prueba
-- -------------
-- `core.customers.credit_days` existia validado (0-365) y no lo leia nadie:
-- `create_sale` aceptaba el `p_due_date` del llamador sin contrastarlo. Con la
-- migracion `20260928167000` los terminos del cliente son la fuente de verdad.
--
-- Lo que importa no es que el vencimiento se calcule, sino que NO se pueda
-- colar una fecha que contradiga los terminos, y que cambiar los terminos
-- despues no reescriba la historia: el documento congela su vencimiento.

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
-- Escenario
--
--   owner_a + org_a + bu_a + cliente_a   (credit_days = 30)
--   owner_b + org_b + cliente_b           (otra organización, para RLS)
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
  v_bu_a uuid;
  v_customer_a uuid;
  v_customer_b uuid;
begin
  perform tests.act_as(v_owner_a);
  select (r ->> 'organization_id')::uuid, (r ->> 'business_unit_id')::uuid
  into v_org_a, v_bu_a
  from public.create_organization_with_business_unit(
    'Granja crédito A', 'PONEDORAS', 'Ponederas crédito', 'poultry_layers'
  ) as r;

  perform tests.act_as(v_owner_b);
  select (r ->> 'organization_id')::uuid
  into v_org_b
  from public.create_organization_with_business_unit(
    'Granja crédito B', 'CERDOS', 'Cerdos crédito', 'swine'
  ) as r;

  perform tests.act_as(v_owner_a);

  insert into core.customers (organization_id, name, credit_days)
  values (v_org_a, 'Cliente crédito 30', 30)
  returning id into v_customer_a;

  insert into core.customers (organization_id, name, credit_days)
  values (v_org_b, 'Cliente ajeno', 30)
  returning id into v_customer_b;

  insert into tests.scenario (key, value) values
    ('owner_a', v_owner_a),
    ('owner_b', v_owner_b),
    ('org_a', v_org_a),
    ('org_b', v_org_b),
    ('bu_a', v_bu_a),
    ('customer_a', v_customer_a),
    ('customer_b', v_customer_b);
end;
$$;

select tests.build_scenario();

set local role authenticated;
select tests.clear_session();
select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- A. credit_days = 30: el servidor calcula el vencimiento
-- ─────────────────────────────────────────────────────────────────────────────

create temp table cd_s1 (sale_id uuid, due_date date);
insert into cd_s1 (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('customer_a'), date '2026-03-01', null,
  'bank_transfer', 'Venta con crédito 30',
  '[{"product_name":"Huevos","quantity":10,"unit_price":1000}]'
);

select is(
  (select due_date from finance.sales where id = (select sale_id from cd_s1)),
  date '2026-03-31',
  '1: el vencimiento es sale_date + 30 días cuando el cliente tiene 30 de crédito'
);

select is(
  (select due_date from finance.receivables where sale_id = (select sale_id from cd_s1)),
  date '2026-03-31',
  '2: la cartera hereda el vencimiento calculado'
);

-- Si el frontend envía la fecha CORRECTA, se acepta: no se obliga a omitirla.
select is(
  public.create_sale(
    tests.id('bu_a'), tests.id('customer_a'), date '2026-03-01', date '2026-03-31',
    'bank_transfer', 'Venta con vencimiento correcto',
    '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
  ) is not null,
  true,
  '3: enviar el vencimiento que coincide con los términos se acepta'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- B. El frontend no puede contradecir los términos
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$
  select public.create_sale(
    tests.id('bu_a'), tests.id('customer_a'), date '2026-03-01', date '2026-06-30',
    'bank_transfer', 'Venta con vencimiento inventado',
    '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
  )
  $$,
  '22023',
  null,
  '4: un vencimiento más largo que los términos se rechaza'
);

select throws_ok(
  $$
  select public.create_sale(
    tests.id('bu_a'), tests.id('customer_a'), date '2026-03-01', date '2026-03-15',
    'bank_transfer', 'Venta con vencimiento corto',
    '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
  )
  $$,
  '22023',
  null,
  '5: un vencimiento más corto que los términos también se rechaza'
);

select is(
  (select count(*) from finance.sales where description like 'Venta con vencimiento%'),
  0::bigint,
  '6: los rechazos no dejan ventas a medias'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. credit_days = 0: vence el día de la venta
-- ─────────────────────────────────────────────────────────────────────────────

update core.customers set credit_days = 0 where id = tests.id('customer_a');

create temp table cd_s0 (sale_id uuid);
insert into cd_s0 (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('customer_a'), date '2026-03-01', null,
  'bank_transfer', 'Venta sin crédito',
  '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
);

select is(
  (select due_date from finance.sales where id = (select sale_id from cd_s0)),
  date '2026-03-01',
  '7: credit_days = 0 vence el mismo día de la venta'
);

select throws_ok(
  $$
  select public.create_sale(
    tests.id('bu_a'), tests.id('customer_a'), date '2026-03-01', date '2026-03-02',
    'bank_transfer', 'Con crédito cero no se alarga',
    '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
  )
  $$,
  '22023',
  null,
  '8: con credit_days = 0 tampoco se puede extender el vencimiento'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- D. credit_days = NULL: sin plazo acordado el vencimiento es obligatorio
-- ─────────────────────────────────────────────────────────────────────────────

update core.customers set credit_days = null where id = tests.id('customer_a');

select throws_ok(
  $$
  select public.create_sale(
    tests.id('bu_a'), tests.id('customer_a'), date '2026-03-01', null,
    'bank_transfer', 'Sin plazo y sin vencimiento',
    '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
  )
  $$,
  '22023',
  null,
  '9: sin crédito acordado no se puede omitir el vencimiento'
);

create temp table cd_sn (sale_id uuid);
insert into cd_sn (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('customer_a'), date '2026-03-01', date '2026-03-05',
  'bank_transfer', 'Sin plazo con vencimiento explícito',
  '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
);

select is(
  (select due_date from finance.sales where id = (select sale_id from cd_sn)),
  date '2026-03-05',
  '10: sin crédito acordado se respeta el vencimiento explícito del llamador'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- E. Los términos se congelan en el documento
--
--   30 días -> venta -> 15 días -> venta
-- La primera conserva su vencimiento original.
-- ─────────────────────────────────────────────────────────────────────────────

update core.customers set credit_days = 30 where id = tests.id('customer_a');

create temp table cd_h1 (sale_id uuid);
insert into cd_h1 (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('customer_a'), date '2026-04-01', null,
  'bank_transfer', 'Venta con 30 días',
  '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
);

update core.customers set credit_days = 15 where id = tests.id('customer_a');

create temp table cd_h2 (sale_id uuid);
insert into cd_h2 (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('customer_a'), date '2026-04-01', null,
  'bank_transfer', 'Venta con 15 días',
  '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
);

select is(
  (select due_date from finance.sales where id = (select sale_id from cd_h1)),
  date '2026-05-01',
  '11: cambiar los términos NO altera una venta ya creada'
);

select is(
  (select due_date from finance.receivables where sale_id = (select sale_id from cd_h1)),
  date '2026-05-01',
  '12: la cartera de la venta antigua tampoco cambia'
);

select is(
  (select due_date from finance.sales where id = (select sale_id from cd_h2)),
  date '2026-04-16',
  '13: la venta nueva sí usa los términos nuevos'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- F. La cartera: pago parcial, pago completo y paid_at
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select paid_at from finance.receivables where sale_id = (select sale_id from cd_h2)),
  null::timestamptz,
  '14: una venta recién creada no está liquidada'
);

select public.register_payment(tests.id('bu_a'), date '2026-04-05', 'inbound', 'cash', 500);

select is(
  (
    select paid_amount
    from finance.receivables
    where sale_id = (select sale_id from cd_h2)
  ),
  500::numeric,
  '15: un pago parcial deja abonado lo pagado'
);

select is(
  (
    select paid_at
    from finance.receivables
    where sale_id = (select sale_id from cd_h2)
  ),
  null::timestamptz,
  '16: un pago parcial NO marca la cartera como liquidada'
);

select public.register_payment(tests.id('bu_a'), date '2026-04-10', 'inbound', 'cash', 500);

select is(
  (
    select paid_amount
    from finance.receivables
    where sale_id = (select sale_id from cd_h2)
  ),
  1000::numeric,
  '17: el segundo pago completa el saldo'
);

select ok(
  (
    select paid_at is not null
    from finance.receivables
    where sale_id = (select sale_id from cd_h2)
  ),
  '18: paid_at se escribe SOLO al liquidar la obligación por completo'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- G. Rango de credit_days y aislamiento
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ update core.customers set credit_days = -1 where id = tests.id('customer_a') $$,
  '23514',
  null,
  '19: credit_days negativo lo rechaza el CHECK de la tabla'
);

select throws_ok(
  $$ update core.customers set credit_days = 400 where id = tests.id('customer_a') $$,
  '23514',
  null,
  '20: credit_days mayor a 365 lo rechaza el CHECK de la tabla'
);

select is(
  (select credit_days from core.customers where id = tests.id('customer_a')),
  15::integer,
  '21: los intentos inválidos no alteran los términos vigentes'
);

-- Cliente de otra organización: no existe para esta sesión, así que create_sale
-- lo rechaza por cliente, no por fecha.
select throws_ok(
  $$
  select public.create_sale(
    tests.id('bu_a'), tests.id('customer_b'), date '2026-04-01', null,
    'bank_transfer', 'Cliente ajeno',
    '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
  )
  $$,
  '22023',
  null,
  '22: no se puede vender a un cliente de otra organización'
);

select is(
  (select count(*) from finance.sales where customer_id = tests.id('customer_b')),
  0::bigint,
  '23: el intento con cliente ajeno no creó ninguna venta'
);

select is(
  (select count(*) from finance.receivables where customer_id is null),
  0::bigint,
  '24: ninguna cartera quedó sin cliente'
);

-- Sin contexto de organización: ni siquiera el propio cliente es visible.
select tests.set_org_header(tests.id('org_b')::text);

select throws_ok(
  $$
  select public.create_sale(
    (select id from core.business_units where organization_id = tests.id('org_b') limit 1),
    tests.id('customer_a'), date '2026-04-01', null,
    'bank_transfer', 'Sin contexto válido',
    '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
  )
  $$,
  '42501',
  null,
  '25: sin permiso sobre la unidad de negocio, la venta se rechaza'
);

select is(
  (select count(*) from finance.sales),
  6::bigint,
  '26: las ventas de esta organización no grewan al cambiar de contexto'
);

select * from finish();
rollback;