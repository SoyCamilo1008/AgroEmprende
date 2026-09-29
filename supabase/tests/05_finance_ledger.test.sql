-- Pruebas del libro mayor, ventas, gastos, inversiones y reinversiones (Fase 3).
--
-- Solo se ejecutan con Docker: `pnpm db:test` (y el job `migrations` del CI).
-- El punto que se prueba es que CADA función de negocio deja el libro mayor en
-- balance: si el asiento de una venta abona una cuenta de más, "funcionan" los
-- totales de la pantalla pero el balance no cuadra jamás.
--
-- Aserciones con el rol `authenticated` puesto: las consultas corren con los
-- grants y las políticas reales (mismo bootstrap que 01_multitenant_rls).

begin;

select plan(30);

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
-- Utilerías del escenario (idénticas a 01_multitenant_rls)
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

-- Una organización con su dueño, su unidad y un cliente. Onboarding real, no
-- inserts directos (mismo criterio que 01).
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
-- 1. Contexto
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select private.current_organization_id()),
  tests.id('org_a'),
  '1: el dueño resuelve su única organización como contexto'
);

-- Ventas en el mismo JSON de líneas que usará el cliente.
create temporary table created_sales (sale_id uuid);

insert into created_sales (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('customer_a'), current_date, current_date + 15,
  'cash', 'Venta de prueba', '[{"product_name":"Huevos","quantity":20,"unit_price":500}]'
);

select is(
  (select count(*) from created_sales),
  1::bigint,
  '2: create_sale devuelve el id de la venta'
);

select is(
  (select count(*) from finance.sales),
  1::bigint,
  '3: la venta quedó registrada'
);

select is(
  (select original_amount from finance.receivables),
  10000::numeric,
  '4: la cartera nace con el total de la venta (20 × 500)'
);

select is(
  (select count(*) from finance.ledger_entries e
   join created_sales s on s.sale_id = e.source_id
   where e.source_type = 'finance.sales'),
  1::bigint,
  '5: la venta contabiliza exactamente un asiento'
);

select is(
  (select l.debit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_id in (select sale_id from created_sales) and a.code = '1305'),
  10000::numeric,
  '6: el asiento debita 1305 (cuentas por cobrar) por el total'
);

select is(
  (select l.credit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_id in (select sale_id from created_sales) and a.code = '4105'),
  10000::numeric,
  '7: el asiento abona 4105 (ventas) por el total'
);

select is(
  (select count(*) from finance.ledger_entries e
   join created_sales s on s.sale_id = e.source_id
   where (select sum(l2.debit) from finance.ledger_lines l2 where l2.entry_id = e.id) <>
         (select sum(l2.credit) from finance.ledger_lines l2 where l2.entry_id = e.id)),
  0::bigint,
  '8: todo asiento de venta queda en balance (débitos = créditos)'
);

-- Segunda venta: los números de factura son únicos por organización.
insert into created_sales (sale_id)
select public.create_sale(
  tests.id('bu_a'), tests.id('customer_a'), current_date, current_date + 15,
  'bank_transfer', 'Segunda venta', '[{"product_name":"Pollo","quantity":2,"unit_price":1200}]'
);

select is(
  (select count(distinct invoice_number) from finance.sales),
  2::bigint,
  '9: cada venta tiene su número de factura'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Gastos: cuenta derivada del tipo, contra caja (1105) al ser de contado.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table fin_gasto (id uuid);
insert into fin_gasto
select public.create_expense(tests.id('bu_a'), 'feed', current_date, 'cash', 'Alimento', 3000);

select is(
  (select count(*) from fin_gasto),
  1::bigint,
  '10: create_expense devuelve el id del gasto'
);

select is(
  (select count(*) from finance.expenses),
  1::bigint,
  '11: el gasto quedó registrado'
);

select is(
  (select l.debit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.expenses' and e.source_id in (select id from fin_gasto)
     and a.code = '5205'),
  3000::numeric,
  '12: el gasto de alimento debita 5205'
);

select is(
  (select l.credit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.expenses' and e.source_id in (select id from fin_gasto)
     and a.code = '1105'),
  3000::numeric,
  '13: el gasto de contado abona 1105 (caja)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Inversión y reinversión
-- ─────────────────────────────────────────────────────────────────────────────

create temp table fin_inv (id uuid);
insert into fin_inv
select public.create_investment(tests.id('bu_a'), current_date, 'bank_transfer', 'Molino', 5000);

select is(
  (select count(*) from fin_inv),
  1::bigint,
  '14: create_investment devuelve el id de la inversión'
);

select is(
  (select count(*) from finance.investments),
  1::bigint,
  '15: la inversión quedó registrada'
);

select is(
  (select l.debit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.investments' and e.source_id in (select id from fin_inv)
     and a.code = '1590'),
  5000::numeric,
  '16: la inversión capitaliza en 1590 (activo sin depreciar)'
);

select is(
  (select l.credit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.investments' and e.source_id in (select id from fin_inv)
     and a.code = '1110'),
  5000::numeric,
  '17: la inversión de banco abona 1110'
);

create temp table fin_reinv (id uuid);
insert into fin_reinv
select public.create_reinvestment(tests.id('bu_a'), current_date, 'Proyecto de ampliación', 2000);

select is(
  (select count(*) from fin_reinv),
  1::bigint,
  '18: create_reinvestment devuelve el id de la reinversión'
);

select is(
  (select count(*) from finance.reinvestments),
  1::bigint,
  '19: la reinversión quedó registrada'
);

select is(
  (select l.debit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.reinvestments' and e.source_id in (select id from fin_reinv)
     and a.code = '3110'),
  2000::numeric,
  '20: se comprometen 2000 de utilidad del ejercicio (3110)'
);

select is(
  (select l.credit from finance.ledger_lines l
   join finance.ledger_entries e on e.id = l.entry_id
   join core.accounts a on a.id = l.account_id
   where e.source_type = 'finance.reinvestments' and e.source_id in (select id from fin_reinv)
     and a.code = '3120'),
  2000::numeric,
  '21: la contraparte es utilidad retenida (3120)'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- La invariante: un asiento fuera de balance no entra por NINGUNA puerta.
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ select private.post_ledger_entry(
       tests.id('bu_a'), current_date, 'payment', 'test.out-of-balance', gen_random_uuid(),
       'asiento artificial', '[{"account_code":"1105","side":"debit","amount":100}]'
     ) $$,
  '22023',
  null,
  '22: post_ledger_entry rechaza un asiento desbalanceado'
);

-- Y tampoco por una escritura directa: el invariante dispara AL CIERRE de la
-- restricción diferida. Se fuerza con SET CONSTRAINTS IMMEDIATE fuera del
-- bloque (un raise dentro no puede restaurarla, y quedar IMMEDIATE rompería
-- las funciones que insertan líneas de una en una). Corría como superusuario
-- para que el RLS no sea la razón del rechazo: se prueba la base misma.
reset role;
set constraints all immediate;

select throws_ok(
  $sql$
    do $$
    declare
      v_entry_id uuid;
      v_account_id uuid;
    begin
      insert into finance.ledger_entries (
        organization_id, business_unit_id, entry_date, entry_type, source_type, source_id
      )
      values (
        tests.id('org_a'), tests.id('bu_a'), current_date, 'sale',
        'test.direct', gen_random_uuid()
      )
      returning id into v_entry_id;

      select a.id into v_account_id
      from core.accounts a
      where a.organization_id = tests.id('org_a') and a.code = '1305'
      limit 1;

      insert into finance.ledger_lines (organization_id, entry_id, account_id, debit, credit)
      values (tests.id('org_a'), v_entry_id, v_account_id, 100, 0);
    end $$;
  $sql$,
  '22023',
  null,
  '23: la escritura directa de un asiento sin contraparte es rechazada por el invariante'
);

-- Y la rama DELETE del mismo invariante: borrar una línea de un asiento que sí
-- estaba balanceado lo deja descuadrado, y el trigger debe decirlo. Hoy ninguna
-- función borra líneas y ningún permiso lo permite, pero la defensa existe para
-- cuando exista, y esta prueba la ejecuta: sin la rama `TG_OP = 'DELETE'` el
-- trigger aborta con `record "new" is not assigned yet` en vez de `22023`.
--
-- Las dos líneas entran en UN solo `insert`: con las restricciones ya inmediatas
-- el trigger corre al final de cada sentencia, y dos sentencias dejarían el
-- asiento descuadrado ya en la primera.
select throws_ok(
  $sql$
    do $$
    declare
      v_entry_id uuid;
      v_account_id uuid;
    begin
      select a.id into v_account_id
      from core.accounts a
      where a.organization_id = tests.id('org_a') and a.code = '1305'
      limit 1;

      insert into finance.ledger_entries (
        organization_id, business_unit_id, entry_date, entry_type, source_type, source_id
      )
      values (
        tests.id('org_a'), tests.id('bu_a'), current_date, 'sale',
        'test.delete-line', gen_random_uuid()
      )
      returning id into v_entry_id;

      insert into finance.ledger_lines (organization_id, entry_id, account_id, debit, credit)
      values (tests.id('org_a'), v_entry_id, v_account_id, 100, 0),
             (tests.id('org_a'), v_entry_id, v_account_id, 0, 100);

      delete from finance.ledger_lines
      where entry_id = v_entry_id and credit = 100;
    end $$;
  $sql$,
  '22023',
  null,
  '24: borrar una línea de un asiento balanceado es rechazado por el invariante'
);

set constraints all deferred;
set local role authenticated;
select tests.act_as(tests.id('user_owner_a'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Anulación: contra-asiento, historia intacta, una sola vez.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from finance.ledger_entries
   where source_type = 'finance.sales'
     and entry_type = 'reversal'),
  0::bigint,
  '25: todavía no hay ningún contra-asiento'
);

create temp table voided_sale (id uuid);
insert into voided_sale
select sale_id from created_sales
limit 1;

select lives_ok(
  $$ select public.void_sale((select id from voided_sale limit 1)) $$,
  '26: void_sale escribe la reversa sin errores'
);

select is(
  (select count(*) from finance.sales),
  2::bigint,
  '27: la venta anulada permanece en el registro (no se borra)'
);

select is(
  (select count(*) from finance.ledger_entries
   where source_type = 'finance.sales'
     and entry_type = 'reversal'),
  1::bigint,
  '28: quedó exactamente un contra-asiento de reversa'
);

select is(
  (select count(*) from core.audit_log where action in ('create_sale', 'void_sale')),
  3::bigint,
  '29: se auditó la creación y la anulación de la venta'
);

-- Segunda anulación: idempotente en el rechazo, no en el hecho.
select throws_ok(
  $$ select public.void_sale((select id from voided_sale limit 1)) $$,
  '22023',
  null,
  '30: anular dos veces devuelve el error verdadero, no re-contabiliza'
);

select * from finish();
rollback;