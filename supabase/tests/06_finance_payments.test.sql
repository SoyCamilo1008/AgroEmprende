-- Pruebas de pagos (Fase 3): FIFO, sobrepago → saldo a favor 2210, gasto a
-- crédito contra pagables, asignación explícita y anulación bloqueada.
--
-- Mismo patrón que 01_multitenant_rls: escenario real por onboarding, rol
-- `authenticated`, y el libro mayor se lee con los grants/policies reales.

begin;

select plan(27);

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
-- Utilerías del escenario (idénticas a 01/05)
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

create function tests.build_scenario()
returns void
language plpgsql
as $$
declare
  v_owner_a uuid := tests.make_user();
  v_org_a uuid;
  v_bu_a uuid;
  v_customer_a uuid;
begin
  perform tests.act_as(v_owner_a);
  select (r ->> 'organization_id')::uuid, (r ->> 'business_unit_id')::uuid
  into v_org_a, v_bu_a
  from public.create_organization_with_business_unit(
    'Granja de prueba A', 'PONEDORAS', 'Ponedoras de prueba', 'poultry_layers'
  ) as r;

  perform tests.act_as(v_owner_a);
  insert into core.customers (organization_id, name)
  values (v_org_a, 'Cliente de la organización A')
  returning id into v_customer_a;

  insert into tests.scenario (key, value) values
    ('user_owner_a', v_owner_a),
    ('org_a', v_org_a),
    ('bu_a', v_bu_a),
    ('customer_a', v_customer_a)
  on conflict (key) do update set value = excluded.value;
end;
$$;

grant execute on function tests.build_scenario() to anon, authenticated;

select tests.build_scenario();

set local role authenticated;
select tests.clear_session();
select tests.act_as(tests.id('user_owner_a'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Datos: dos cuentas por cobrar (la más vieja vence primero) y una caja real.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table fin_s1 (sale_id uuid, rec_id uuid);
insert into fin_s1 (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('customer_a'), current_date - 20, current_date - 5,
  'cash', 'Primera venta', '[{"product_name":"Huevos","quantity":10,"unit_price":100}]'
);
update fin_s1 set rec_id =
  (select r.id from finance.receivables r where r.sale_id = fin_s1.sale_id);

create temp table fin_s2 (sale_id uuid, rec_id uuid);
insert into fin_s2 (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('customer_a'), current_date - 10, current_date + 5,
  'bank_transfer', 'Segunda venta', '[{"product_name":"Pollo","quantity":1,"unit_price":2000}]'
);
update fin_s2 set rec_id =
  (select r.id from finance.receivables r where r.sale_id = fin_s2.sale_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- A. FIFO: un cobro de 1500 aplica primero a la deuda que vence primero.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table fin_p1 (payment_id uuid);
insert into fin_p1
select public.register_payment(tests.id('bu_a'), current_date, 'inbound', 'cash', 1500);

select is(
  (select paid_amount from finance.receivables where id = (select rec_id from fin_s1)),
  1000::numeric,
  '1: FIFO cierra la deuda más antigua'
);

select is(
  (select paid_amount from finance.receivables where id = (select rec_id from fin_s2)),
  500::numeric,
  '2: el saldo del pago sigue con la siguiente deuda'
);

select is(
  (select unapplied_amount from finance.payments where id = (select payment_id from fin_p1)),
  0::numeric,
  '3: sin saldo sobrante cuando el pago alcanza'
);

select is(
  (select l.credit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.payments' and e.source_id = (select payment_id from fin_p1)
     and a.code = '1305'),
  1500::numeric,
  '4: el tramo aplicado abona cuentas por cobrar'
);

select is(
  (select l.debit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.payments' and e.source_id = (select payment_id from fin_p1)
     and a.code = '1105'),
  1500::numeric,
  '5: la caja recibe el total del cobro'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Sobrepago: el exceso queda como dinero de los clientes (2210), no como
-- inventario de caja sin explicación.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table fin_p2 (payment_id uuid);
insert into fin_p2
select public.register_payment(tests.id('bu_a'), current_date, 'inbound', 'bank_transfer', 2000);

select is(
  (select paid_amount from finance.receivables where id = (select rec_id from fin_s2)),
  2000::numeric,
  '6: el sobrepago cierra la deuda pendiente'
);

select is(
  (select unapplied_amount from finance.payments where id = (select payment_id from fin_p2)),
  500::numeric,
  '7: el exceso queda como saldo sin aplicar'
);

select is(
  (select l.credit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.payments' and e.source_id = (select payment_id from fin_p2)
     and a.code = '1305'),
  1500::numeric,
  '8: el tramo aplicado abona la cartera'
);

select is(
  (select l.credit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.payments' and e.source_id = (select payment_id from fin_p2)
     and a.code = '2210'),
  500::numeric,
  '9: el exceso abona anticipos de clientes (2210)'
);

select is(
  (select l.debit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.payments' and e.source_id = (select payment_id from fin_p2)
     and a.code = '1110'),
  2000::numeric,
  '10: el banco recibe el total'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Gasto al crédito: nace un pagable, y los pagos de salida lo consumen.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table fin_e1 (expense_id uuid, payable_id uuid);
insert into fin_e1 (expense_id)
select public.create_expense(
  tests.id('bu_a'), 'feed', current_date - 3, 'credit', 'Alimento al crédito', 2000, current_date + 10
);
update fin_e1 set payable_id =
  (select p.id from finance.payables p where p.origin_type = 'expense' and p.origin_id = fin_e1.expense_id);

select is(
  (select count(*) from finance.payables),
  1::bigint,
  '11: un gasto a crédito crea su pagable'
);

select is(
  (select original_amount from finance.payables where id = (select payable_id from fin_e1)),
  2000::numeric,
  '12: el pagable nace por el monto del gasto'
);

create temp table fin_p3 (payment_id uuid);
insert into fin_p3
select public.register_payment(tests.id('bu_a'), current_date, 'outbound', 'cash', 800);

select is(
  (select paid_amount from finance.payables where id = (select payable_id from fin_e1)),
  800::numeric,
  '13: el pago de salida reduce el pagable'
);

select is(
  (select unapplied_amount from finance.payments where id = (select payment_id from fin_p3)),
  0::numeric,
  '14: el pago de salida queda aplicado del todo'
);

select is(
  (select l.debit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.payments' and e.source_id = (select payment_id from fin_p3)
     and a.code = '2105'),
  800::numeric,
  '15: el pago a proveedores debita 2105'
);

select is(
  (select l.credit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.payments' and e.source_id = (select payment_id from fin_p3)
     and a.code = '1105'),
  800::numeric,
  '16: la caja entrega el pago'
);

create temp table fin_p4 (payment_id uuid);
insert into fin_p4
select public.register_payment(tests.id('bu_a'), current_date, 'outbound', 'cash', 1200);

select is(
  (select paid_amount from finance.payables where id = (select payable_id from fin_e1)),
  2000::numeric,
  '17: el pagable queda saldado'
);

select is(
  (select unapplied_amount from finance.payments where id = (select payment_id from fin_p4)),
  0::numeric,
  '18: sin saldo sobrante al saldar'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- D. No hay deuda abierta: el pago se descarta completo, no nace "en el aire".
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ select public.register_payment(tests.id('bu_a'), current_date, 'outbound', 'cash', 100) $$,
  '22023',
  null,
  '19: sin deuda abierta el pago no se registra'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- E. Asignación explícita a una cuenta por cobrar concreta.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table fin_s3 (sale_id uuid, rec_id uuid);
insert into fin_s3 (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('customer_a'), current_date, current_date + 5,
  'card', 'Tercera venta', '[{"product_name":"Huevos","quantity":1,"unit_price":1000}]'
);
update fin_s3 set rec_id =
  (select r.id from finance.receivables r where r.sale_id = fin_s3.sale_id);

create temp table fin_p5 (payment_id uuid);
insert into fin_p5
select public.register_payment(
  tests.id('bu_a'), current_date, 'inbound', 'cash', 300, null,
  jsonb_build_array(
    jsonb_build_object('type', 'receivable', 'id', (select rec_id from fin_s3))
  )
);

select is(
  (select paid_amount from finance.receivables where id = (select rec_id from fin_s3)),
  300::numeric,
  '20: la asignación explícita paga la deuda indicada'
);

select is(
  (select unapplied_amount from finance.payments where id = (select payment_id from fin_p5)),
  0::numeric,
  '21: el pago explícito se consume completo'
);

select throws_ok(
  $$ select public.register_payment(
       tests.id('bu_a'), current_date, 'inbound', 'cash', 50, null,
       '[{"type":"payable","id":"00000000-0000-0000-0000-000000000001"}]'::jsonb
     ) $$,
  '22023',
  null,
  '22: asignar un pagable a un cobro es inválido'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- F. Anulación bloqueada por pagos aplicados.
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ select public.void_sale((select sale_id from fin_s1)) $$,
  '22023',
  null,
  '23: una venta con pagos aplicados no se anula'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- G. Visibilidad y estados finales.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from finance.payments),
  5::bigint,
  '24: quedan cinco pagos registrados (los fallidos no dejaron residuos)'
);

select is(
  (select paid_at is not null from finance.receivables where id = (select rec_id from fin_s3)),
  false,
  '25: una deuda parcial no se marca como pagada'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- H. El invariante del pago: el total es la suma de asignaciones más el sobrante.
--
-- Este invariante se escribio primero como `check` de tabla y PostgreSQL lo
-- rechazo (`cannot use subquery in check constraint`), porque necesita leer la
-- tabla de asignaciones. Ahora es un trigger de restriccion diferido, igual que
-- el balance del libro mayor. Se prueba con una escritura directa y como
-- superusuario: si el rechazo lo diera el RLS o un GRANT, la prueba probaria
-- algo distinto de lo que dice.
-- ─────────────────────────────────────────────────────────────────────────────

reset role;
set constraints all immediate;

-- Agregar una asignacion de mas descuadra el pago. Solo puede fallar por el
-- invariante: la fila cumple sus propios CHECK y no hay permisos que la frenen.
select throws_ok(
  $sql$
    do $$
    begin
      insert into finance.payment_allocations (
        organization_id, payment_id, allocation_type, allocation_id, amount
      )
      values (
        tests.id('org_a'), (select payment_id from fin_p1), 'receivable',
        gen_random_uuid(), 1
      );
    end $$;
  $sql$,
  '22023',
  null,
  '27: una asignacion que descuadra el pago es rechazada por el invariante'
);

set constraints all deferred;

set local role anon;

select throws_ok(
  $$ select count(*) from finance.payments $$,
  '42501',
  null,
  '26: el público no lee pagos (falta el permiso, no solo la política)'
);

select * from finish();
rollback;