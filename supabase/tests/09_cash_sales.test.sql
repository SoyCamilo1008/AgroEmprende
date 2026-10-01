-- Ventas de contado: el dinero entra ahora, no hay nada que cobrar.
--
-- Estas pruebas NO se ejecutan sin Docker: las corre el job de migraciones del CI.
--
-- Que se prueba
-- -------------
-- Antes TODA venta nacia con cartera, incluso la que se cobraba en el acto. Eso
-- obligaba a registrar un cobro posterior de un dinero que ya estaba recibido y
-- dejaba el saldo del cliente inflado por una deuda que nadie tenia.
--
-- Con la migracion `20260928169000` la venta de contado se liquida en el momento:
-- no genera `finance.receivables`, no guarda vencimiento y debita caja (1105) o
-- bancos (1110) segun el metodo, en vez de 1305. La venta a credito sigue igual
-- que antes, con su cartera y su vencimiento.
--
-- Lo que importa NO es que la venta exista: es que el libro mayor y la cartera
-- dejen de discrepar. El saldo de 1305 tiene que ser exactamente la suma de las
-- carteras, y el saldo del cliente no puede contar dinero que ya se recibio.

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
--   owner_a + org_a + bu_a
--   cliente_credito (credit_days = 30)  : compra a credito
--   cliente_contado (credit_days = null): compra pagando en el acto
--
-- El cliente con terminos es el caso importante: tener credito acordado con un
-- cliente NO obliga a que cada venta sea a credito. Confundir ambas cosas es
-- exactamente el bug que esta migracion arregla.
-- ─────────────────────────────────────────────────────────────────────────────

create function tests.build_scenario()
returns void
language plpgsql
as $$
declare
  v_owner_a uuid := tests.make_user();
  v_org_a uuid;
  v_bu_a uuid;
  v_credit uuid;
  v_contado uuid;
begin
  perform tests.act_as(v_owner_a);
  select (r ->> 'organization_id')::uuid, (r ->> 'business_unit_id')::uuid
  into v_org_a, v_bu_a
  from public.create_organization_with_business_unit(
    'Granja contado A', 'PONEDORAS', 'Ponederas contado', 'poultry_layers'
  ) as r;

  insert into core.customers (organization_id, name, credit_days)
  values (v_org_a, 'Cliente con credito acordado', 30)
  returning id into v_credit;

  insert into core.customers (organization_id, name, credit_days)
  values (v_org_a, 'Cliente que paga en el acto', null)
  returning id into v_contado;

  insert into tests.scenario (key, value) values
    ('owner_a', v_owner_a),
    ('org_a', v_org_a),
    ('bu_a', v_bu_a),
    ('cliente_credito', v_credit),
    ('cliente_contado', v_contado);
end;
$$;

select tests.build_scenario();

set local role authenticated;
select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Una venta de contado no genera cartera
-- ─────────────────────────────────────────────────────────────────────────────

create temp table ct_cash (sale_id uuid);
insert into ct_cash (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('cliente_contado'), date '2026-05-04', null,
  'cash', 'Venta de contado en efectivo',
  '[{"product_name":"Huevos","quantity":20,"unit_price":500}]'
);

select is(
  (select count(*) from finance.sales where id = (select sale_id from ct_cash)),
  1::bigint,
  '1: la venta de contado sí existe como documento'
);

select is(
  (select due_date from finance.sales where id = (select sale_id from ct_cash)),
  null::date,
  '2: la venta de contado no guarda vencimiento, no hay nada que venzar'
);

-- La aserción central del bloque: cero filas de cartera para una venta pagada.
select is(
  (select count(*) from finance.receivables where sale_id = (select sale_id from ct_cash)),
  0::bigint,
  '3: la venta de contado NO genera cuenta por cobrar'
);

select is(
  (select original_amount from finance.receivables where sale_id = (select sale_id from ct_cash)),
  null::numeric,
  '4: tampoco hay saldo pendiente asociado a esa venta'
);

-- El saldo del cliente no puede contar dinero ya recibido.
select is(
  coalesce((
    select sum(r.original_amount - r.paid_amount)
    from finance.receivables r
    join finance.sales s on s.id = r.sale_id
    where s.customer_id = tests.id('cliente_contado')
  ), 0),
  0::numeric,
  '5: el cliente de contado no debe nada'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- B. El asiento va a caja, no a cuentas por cobrar
--
-- La cuenta se decide con el mismo criterio que ya usa create_expense: efectivo
-- es caja, todo lo demas es bancos. Aqui se comprueba que una venta de contado
-- NO toque 1305, porque 1305 sin cartera seria un saldo que el libro inventa.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select l.debit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.sales'
     and e.source_id = (select sale_id from ct_cash)
     and a.code = '1105'),
  10000::numeric,
  '6: la venta en efectivo debita 1105 (caja)'
);

select is(
  (select l.credit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.sales'
     and e.source_id = (select sale_id from ct_cash)
     and a.code = '4105'),
  10000::numeric,
  '7: la venta en efectivo abona 4105 (ventas) por el total'
);

select is(
  (select count(*) from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.sales'
     and e.source_id = (select sale_id from ct_cash)
     and a.code = '1305'),
  0::bigint,
  '8: una venta de contado no toca 1305 (cuentas por cobrar)'
);

-- Transferencia, tarjeta y billetera no son efectivo: van a bancos (1110).
create temp table ct_transfer (sale_id uuid);
insert into ct_transfer (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('cliente_contado'), date '2026-05-04', null,
  'bank_transfer', 'Venta de contado por transferencia',
  '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
);

select is(
  (select l.debit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.sales'
     and e.source_id = (select sale_id from ct_transfer)
     and a.code = '1110'),
  1000::numeric,
  '9: una venta sin efectivo debita 1110 (bancos)'
);

select is(
  (select count(*) from finance.receivables where sale_id = (select sale_id from ct_transfer)),
  0::bigint,
  '10: tampoco por transferencia nace cartera'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Tener credito acordado no obliga a vender a credito
--
-- El cliente tiene 30 dias. La venta es de contado. Este es el caso que hacia
-- imposible el modelo anterior: los terminos existen, y aun asi no hay deuda.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table ct_con_credito (sale_id uuid);
insert into ct_con_credito (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('cliente_credito'), date '2026-05-04', null,
  'cash', 'Paga en el acto aunque tenga 30 dias de credito',
  '[{"product_name":"Huevos","quantity":2,"unit_price":1000}]'
);

select is(
  (select count(*) from finance.receivables where sale_id = (select sale_id from ct_con_credito)),
  0::bigint,
  '11: tener terminos acordados no convierte la venta en cartera'
);

select is(
  (select due_date from finance.sales where id = (select sale_id from ct_con_credito)),
  null::date,
  '12: y esa venta tampoco hereda el vencimiento del cliente'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- D. La venta a credito sigue siendo una venta a credito
--
-- El camino nuevo no puede haber cambiado el viejo.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table ct_credito (sale_id uuid);
insert into ct_credito (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('cliente_credito'), date '2026-05-04', null,
  'credit', 'Venta a credito de verdad',
  '[{"product_name":"Huevos","quantity":10,"unit_price":1000}]'
);

select is(
  (select due_date from finance.sales where id = (select sale_id from ct_credito)),
  date '2026-06-03',
  '13: la venta a credito conserva el vencimiento de los terminos del cliente'
);

select is(
  (select original_amount from finance.receivables where sale_id = (select sale_id from ct_credito)),
  10000::numeric,
  '14: la venta a credito si genera cartera por el total'
);

select is(
  (select l.debit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.sales'
     and e.source_id = (select sale_id from ct_credito)
     and a.code = '1305'),
  10000::numeric,
  '15: la venta a credito debita 1305 como siempre'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- E. El invariante entre metodo y vencimiento
--
-- El CHECK `sales_credit_due_date_agreement` ata las dos columnas. Estas
-- aserciones no lo escriben a proposito (RLS deja a authenticated en solo
-- lectura sobre ventas); comprueban que create_sale respeta el invariante.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (
    select count(*) from finance.sales
    where (payment_method = 'credit') <> (due_date is not null)
  ),
  0::bigint,
  '16: toda venta a credito tiene vencimiento y toda venta de contado no lo tiene'
);

-- Una venta de contado con vencimiento no significa nada: se rechaza, y no
-- queda ninguna venta a medias.
select throws_ok(
  $$
  select public.create_sale(
    tests.id('bu_a'), tests.id('cliente_contado'), date '2026-05-04', date '2026-05-20',
    'cash', 'Contada con vencimiento',
    '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
  )
  $$,
  '22023',
  null,
  '17: una venta de contado con fecha de vencimiento se rechaza'
);

select is(
  (select count(*) from finance.sales where description = 'Contada con vencimiento'),
  0::bigint,
  '18: el rechazo no dejó la venta a medias'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- F. Una venta de contado no se cobra dos veces
--
-- El pago FIFO de `register_payment` recorre las carteras abiertas. Si la venta
-- de contado fabricase una, un cobro posterior se aplicaria a una deuda que no
-- existe: el cliente veria saldar algo que ya pago al contado, y el saldo de
-- 1305 se llevaria un doble cobro.
--
-- Esta comprobacion va ANTES de crear la venta a credito a proposito: hasta aqui
-- la organizacion solo tiene ventas de contado, asi que no hay nada que cobrar y
-- el cobro debe rechazarse. Esa es la prueba de que las ventas de contado no
-- dejaron deuda colgada.
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ select public.register_payment(tests.id('bu_a'), date '2026-05-05', 'inbound', 'cash', 1000) $$,
  '22023',
  null,
  '19: sin carteras abiertas no hay nada a que aplicar un cobro'
);

select is(
  (select count(*) from finance.payments),
  0::bigint,
  '20: el intento fallido no dejó pagos registrados'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- G. El libro y la cartera cuentan lo mismo
--
-- Esta es la conciliacion que hacia el modelo viejo. Si 1305 y la cartera
-- divergen, el balance dice una cosa y la lista de vencimientos otra.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (
    select coalesce(sum(l.debit - l.credit), 0)
    from finance.ledger_lines l
    join core.accounts a on a.id = l.account_id
    where a.code = '1305'
  ),
  coalesce((
    select sum(original_amount - paid_amount) from finance.receivables
  ), 0),
  '21: el saldo de 1305 es exactamente la suma de las carteras'
);

select is(
  (select count(*) from finance.receivables),
  1::bigint,
  '22: de todas las ventas, solo la venta a credito dejó cartera'
);

-- Ahora sí hay algo que cobrar, y el mismo cobro que antes fallaba se aplica a
-- la deuda real. Las ventas de contado quedan fuera del FIFO: no tienen fila que
--Ordering pueda tomar.
select lives_ok(
  $$ select public.register_payment(tests.id('bu_a'), date '2026-05-05', 'inbound', 'cash', 1000) $$,
  '23: el cobro se aplica a la venta a credito'
);

select is(
  (select paid_amount from finance.receivables where sale_id = (select sale_id from ct_credito)),
  1000::numeric,
  '24: la cartera a credito recibió el abono'
);

select is(
  (select count(*) from finance.payments),
  1::bigint,
  '25: un solo cobro, y no toca ninguna venta de contado'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- H. La auditoría dice que pasó
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (
    select new_values ->> 'credit'
    from core.audit_log
    where action = 'create_sale'
      and entity_id = (select sale_id from ct_cash)
  ),
  'false',
  '26: la auditoría distingue la venta de contado de la venta a crédito'
);

select * from finish();
rollback;
