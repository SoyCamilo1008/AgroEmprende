-- Cartera e historial financiero del cliente: lo que la interfaz va a leer.
--
-- Estas pruebas NO se ejecutan sin Docker: las corre el job de migraciones del CI.
--
-- Que se prueba
-- -------------
-- La migracion `20260928172000` anade tres cosas de solo lectura:
-- `finance.customer_receivables`, `finance.customer_payments` y la funcion
-- `finance.customer_financial_summary`. Las tres derivan el saldo en PostgreSQL
-- en vez de dejarlo en TypeScript, y las tres dependen por completo del RLS de
-- las tablas que ya existian.
--
-- Lo que NO se prueba aqui, y por que
-- -----------------------------------
-- Que el saldo este bien. Lo que se prueba es lo que se rompe en silencio:
--
--   1. Que la vista no se salte el RLS. Una vista normal en PostgreSQL se
--      ejecuta con los privilegios de su DUENO y devolveria la cartera de todas
--      las organizaciones. `security_invoker = true` lo evita, y la seccion J
--      quita el permiso de cartera a un rol real: si la vista se ejecutara como
--      su dueño, seguiria devolviendo filas y esta prueba caeria.
--   2. Que la unidad de negocio no se mezcle (ADR-0004) y que la consolidada se
--      distinga de las de cada granja.
--   3. Que la fecha de negocio sea la que decide la app y no la del servidor
--      (ADR-0012).
--
-- El escenario, con numeros que se pueden contar a mano
-- ----------------------------------------------------
-- org_a, dos unidades: PONEDORAS (bu_a1) y CERDOS (bu_a2). Cliente con 30 dias
-- de credito. Fecha de negocio de todas las consultas: 2026-06-10.
--
--   venta           unidad  metodo    total     vencimiento  estado final
--   ---------------  ------  --------  --------  -----------  --------------------------
--   contado         bu_a1   cash      10.000    --           sin cartera (se liquido)
--   credito 1       bu_a1   credit    10.000    2026-06-03   abono parcial de 4.000
--   credito 2       bu_a2   credit    20.000    2026-05-01   abonada en su totalidad
--   credito 3       bu_a2   credit     5.000    2026-07-01   abonada desde bu_a1
--   anulada         bu_a1   credit     7.000    2026-06-03   anulada: fuera de la cartera
--
-- El abono de `credito 3` se registra DESDE bu_a1 y se aplica a una deuda de
-- bu_a2, que es lo que hace `register_payment` cuando el FIFO de la organizacion
-- cruza granjas. La cartera tiene que seguir perteneciendo a bu_a2.

begin;

select plan(56);

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
-- Escenario
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
  v_bu_a1 uuid;
  v_bu_a2 uuid;
  v_bu_b1 uuid;
  v_cliente_a uuid;
  v_cliente_b uuid;
  v_sin_historial uuid;
begin
  perform tests.act_as(v_owner_a);
  select (r ->> 'organization_id')::uuid, (r ->> 'business_unit_id')::uuid
  into v_org_a, v_bu_a1
  from public.create_organization_with_business_unit(
    'Granja cartera A', 'PONEDORAS', 'Ponederas cartera', 'poultry_layers'
  ) as r;

  -- Segunda unidad de la MISMA organizacion. El plan de cuentas es de alcance
  -- organizacional (`core.accounts` no tiene `business_unit_id`), asi que una
  -- unidad nueva puede vender sin sembrar nada. El cliente, en cambio, sigue
  -- siendo uno solo para las dos granjas (ADR-0004).
  insert into core.business_units (organization_id, code, name, type)
  values (v_org_a, 'CERDOS', 'Cerdos cartera', 'swine')
  returning id into v_bu_a2;

  perform tests.act_as(v_owner_b);
  select (r ->> 'organization_id')::uuid, (r ->> 'business_unit_id')::uuid
  into v_org_b, v_bu_b1
  from public.create_organization_with_business_unit(
    'Granja cartera B', 'OTRAS', 'Otras cartera', 'other'
  ) as r;

  perform tests.act_as(v_owner_a);
  insert into core.organization_members (organization_id, user_id, role_code)
  values (v_org_a, v_viewer_a, 'viewer');

  insert into core.customers (organization_id, name, credit_days)
  values (v_org_a, 'Cliente con cartera', 30)
  returning id into v_cliente_a;

  insert into core.customers (organization_id, name, credit_days)
  values (v_org_a, 'Cliente todavia sin ventas', 30)
  returning id into v_sin_historial;

  insert into core.customers (organization_id, name, credit_days)
  values (v_org_b, 'Cliente de la otra organizacion', 30)
  returning id into v_cliente_b;

  insert into tests.scenario (key, value) values
    ('owner_a', v_owner_a),
    ('owner_b', v_owner_b),
    ('viewer_a', v_viewer_a),
    ('org_a', v_org_a),
    ('org_b', v_org_b),
    ('bu_a1', v_bu_a1),
    ('bu_a2', v_bu_a2),
    ('bu_b1', v_bu_b1),
    ('cliente_a', v_cliente_a),
    ('cliente_b', v_cliente_b),
    ('sin_historial', v_sin_historial);
end;
$$;

select tests.build_scenario();

set local role authenticated;
select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- Las ventas, que tienen que registrarse con la sesion puesta
--
-- `create_sale` es SECURITY DEFINER pero lee `auth.uid()` y
-- `current_organization_id()`: sin contexto no sabe de quien es la venta.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table v_sale (clave text primary key, sale_id uuid);

insert into v_sale (clave, sale_id) values
  ('contado', public.create_sale(
    tests.id('bu_a1'), tests.id('cliente_a'), date '2026-05-04', null,
    'cash', 'Venta de contado',
    '[{"product_name":"Huevos","quantity":20,"unit_price":500}]'
  )),
  ('credito_1', public.create_sale(
    tests.id('bu_a1'), tests.id('cliente_a'), date '2026-05-04', null,
    'credit', 'Venta a credito 1',
    '[{"product_name":"Huevos","quantity":10,"unit_price":1000}]'
  )),
  ('credito_2', public.create_sale(
    tests.id('bu_a2'), tests.id('cliente_a'), date '2026-04-01', null,
    'credit', 'Venta a credito 2',
    '[{"product_name":"Pollos","quantity":20,"unit_price":1000}]'
  )),
  ('credito_3', public.create_sale(
    tests.id('bu_a2'), tests.id('cliente_a'), date '2026-06-01', null,
    'credit', 'Venta a credito 3',
    '[{"product_name":"Cerdos","quantity":5,"unit_price":1000}]'
  )),
  ('anulada', public.create_sale(
    tests.id('bu_a1'), tests.id('cliente_a'), date '2026-05-04', null,
    'credit', 'Venta que se anula',
    '[{"product_name":"Huevos","quantity":7,"unit_price":1000}]'
  ));

select public.void_sale((select sale_id from v_sale where clave = 'anulada'));

-- Los abonos. Con `p_assignments` se apunta a una deuda concreta: el FIFO por
-- vencimiento se lo lleva la mas antigua, y estas pruebas necesitan elegir a
-- cual obligacion tocar.
insert into v_sale (clave, sale_id) values
  ('abono_parcial', public.register_payment(
    tests.id('bu_a1'), date '2026-06-05', 'inbound', 'cash', 4000,
    'Abono parcial',
    jsonb_build_array(jsonb_build_object(
      'type', 'receivable',
      'id', (select id from finance.receivables
             where sale_id = (select sale_id from v_sale where clave = 'credito_1'))
    ))
  )),
  ('abono_total', public.register_payment(
    tests.id('bu_a2'), date '2026-06-06', 'inbound', 'cash', 20000,
    'Abono total',
    jsonb_build_array(jsonb_build_object(
      'type', 'receivable',
      'id', (select id from finance.receivables
             where sale_id = (select sale_id from v_sale where clave = 'credito_2'))
    ))
  )),
  -- Este entra por bu_a1 y salda una deuda de bu_a2: es el cruce de granjas que
  -- hace el FIFO de la organizacion, y el que decide de quien es la cartera.
  ('abono_cruzado', public.register_payment(
    tests.id('bu_a1'), date '2026-06-07', 'inbound', 'cash', 5000,
    'Abono desde otra unidad',
    jsonb_build_array(jsonb_build_object(
      'type', 'receivable',
      'id', (select id from finance.receivables
             where sale_id = (select sale_id from v_sale where clave = 'credito_3'))
    ))
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Que es cartera y que no
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from finance.customer_receivables
   where customer_id = tests.id('cliente_a')),
  3::bigint,
  '1: la cartera tiene las tres obligaciones vivas, y solo esas'
);

select is(
  (select count(*) from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'contado')),
  0::bigint,
  '2: una venta de contado no genera nada que cobrar'
);

select is(
  (select count(*) from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'anulada')),
  0::bigint,
  '3: una venta anulada no aparece como pendiente'
);

-- La anulación no borra la cartera: la esconde del modelo de lectura. Si se
-- borrara, el saldo de 1305 y esta vista empezarían a discrepar.
select is(
  (select count(*) from finance.receivables
   where sale_id = (select sale_id from v_sale where clave = 'anulada')),
  1::bigint,
  '4: la fila sigue en la tabla: la anulación es un contra-asiento, no un borrado'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- B. El saldo, y la diferencia entre tocar una deuda y saldarla
--
-- La aserción que importa aqui es la 8: `paid_at` marca la LIQUIDACIÓN. Un
-- abono parcial deja la cartera abierta y sin fecha, que es lo que corrigió
-- `20260928153000`. Si `paid_at` se llenara con el primer peso, la interfaz
-- mostraría una deuda como saldada que no lo está.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select balance from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'credito_1')),
  6000::numeric,
  '5: la venta a credito 1 debe 10.000 menos los 4.000 abonado'
);

select is(
  (select paid_amount from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'credito_1')),
  4000::numeric,
  '6: lo abonado hasta ahora son 4.000 de los 10.000 facturados'
);

select is(
  (select paid_at is null from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'credito_1')),
  true,
  '7: un abono parcial NO liquida la deuda: `paid_at` sigue sin fecha'
);

select is(
  (select balance from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'credito_2')),
  0::numeric,
  '8: la venta a credito 2 queda en cero'
);

select is(
  (select paid_at is not null from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'credito_2')),
  true,
  '9: y solo entonces `paid_at` queda fechado'
);

-- OJO con `paid_at`, porque la interfaz se va a equivocar con esto.
--
-- `private.allocate_payment` lo llena con `now()`: el INSTANTE en que el sistema
-- registró la liquidacion, no la fecha de negocio del pago (que vive en
-- `payments.payment_date` y sí aparece en `finance.customer_payments`). Por eso
-- esta prueba no compara `paid_at` con la fecha del abono: no tienen por qué
-- coincidir, y el pago se puede registrar dias después de que el cliente pagara.
--
-- La lección para la UI: "el cliente pagó el X" se saca de `payment_date`;
-- `paid_at` solo sirve para decir "esta deuda ya está liquidada".

select is(
  (select balance from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'credito_3')),
  0::numeric,
  '10: el abono cruzado tambien salda su obligacion'
);

select is(
  (select balance from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'anulada')),
  null::numeric,
  '11: y la venta anulada no tiene saldo que mostrar'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. La unidad de negocio es la de la VENTA
--
-- El abono de `credito 3` entro por bu_a1. Si la cartera se atribuyera a la
-- unidad del PAGO, el saldo de esa venta aparecería en la granja equivocada.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select business_unit_id from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'credito_1')),
  tests.id('bu_a1'),
  '12: cada obligacion conserva la unidad de su venta'
);

select is(
  (select business_unit_id from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'credito_3')),
  tests.id('bu_a2'),
  '13: la venta de bu_a2 no cambia de unidad porque el abono viniera de bu_a1'
);

select is(
  (select business_unit_code from finance.customer_receivables
   where sale_id = (select sale_id from v_sale where clave = 'credito_3')),
  'CERDOS',
  '14: y el código de la unidad viene listo, sin una segunda consulta'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- D. Los abonos, y por que quedo como quedo
--
-- `paid_amount` dice CUANTO se ha cobrado; esta vista dice QUIEN, CUANDO y
-- CONTRA QUE venta. Sin ella, "por que esta deuda quedo asi" no tiene respuesta.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from finance.customer_payments
   where customer_id = tests.id('cliente_a')),
  3::bigint,
  '15: los tres abonos quedan atribuidos al cliente'
);

select is(
  (select business_unit_id from finance.customer_payments
   where payment_id = (select sale_id from v_sale where clave = 'abono_cruzado')),
  tests.id('bu_a2'),
  '16: el abono cruzado se atribuye a la unidad de la VENTA, no a la del pago'
);

select is(
  (select applied_amount from finance.customer_payments
   where payment_id = (select sale_id from v_sale where clave = 'abono_cruzado')),
  5000::numeric,
  '17: y se le atribuye el importe que REALMENTE aplico a esa obligacion'
);

select is(
  (select unapplied_amount from finance.customer_payments
   where payment_id = (select sale_id from v_sale where clave = 'abono_cruzado')),
  0::numeric,
  '18: no queda saldo a favor pendiente en este abono'
);

-- Lo aplicado por la vista tiene que sumar exactamente lo abonado en la tabla.
-- Si no, la vista estaria contando un pago que el libro no conoce.
select is(
  (select sum(applied_amount) from finance.customer_payments
   where receivable_id = (select id from finance.receivables
     where sale_id = (select sale_id from v_sale where clave = 'credito_1'))),
  (select paid_amount from finance.receivables
   where sale_id = (select sale_id from v_sale where clave = 'credito_1')),
  '19: lo aplicado por pago es exactamente lo que dice `paid_amount`'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- E. El resumen, separado por unidad y con su total
--
-- ADR-0004: la unidad es la frontera contable. El resumen devuelve una fila por
-- unidad y una consolidada, marcada con `is_consolidated`: la interfaz puede
-- mostrar el total del cliente sin borrar de que granja es cada peso.
--
-- Numeros esperados con fecha de negocio 2026-06-10:
--
--   unidad    vendido  cartera  abiertas  parciales  vencidas  pagadas
--   --------  -------  -------  ---------  ---------  --------  -------
--   bu_a1     20.000   6.000         1          1         1        0
--   bu_a2     25.000       0         0          0         0        2
--   TOTAL     45.000   6.000         1          1         1        2
--
-- La venta de 7.000 anulada no aparece en ninguna celda.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10')),
  3::bigint,
  '20: el resumen devuelve una fila por unidad y la consolidada'
);

select is(
  (select count(*) from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  1::bigint,
  '21: hay exactamente una fila consolidada, y se distingue de las de unidad'
);

select is(
  (select count(*) from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10')
   where is_consolidated and business_unit_id is not null),
  0::bigint,
  '22: la consolidada no pertenece a ninguna unidad: su unidad es "todas"'
);

select is(
  (select outstanding from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  6000::numeric,
  '23: el saldo consolidado es lo que el cliente debe'
);

select is(
  (select total_sold from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  45000::numeric,
  '24: lo vendido son las ventas vivas de contado y de credito, sin la anulada'
);

select is(
  (select cash_sales_total from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  10000::numeric,
  '25: las ventas de contado se venden y no dejan cartera'
);

select is(
  (select total_paid from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  29000::numeric,
  '26: lo cobrado son los abonos contra ventas a credito'
);

-- La cuenta que hace que el resumen no pueda mentir: lo vendido a credito y lo
-- que se facturo como cartera tienen que ser la misma cifra.
select is(
  (select total_sold - cash_sales_total - credit_billed
   from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  0::numeric,
  '27: vendido a credito y cartera emitida son la misma cifra'
);

select is(
  (select open_count from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  1::bigint,
  '28: una sola obligacion sigue debiendo algo'
);

select is(
  (select partial_count from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  1::bigint,
  '29: y es justamente la que esta a medio pagar'
);

select is(
  (select overdue_count from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  1::bigint,
  '30: vencida a 2026-06-10, porque vencio el 2026-06-03'
);

select is(
  (select overdue_outstanding from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  6000::numeric,
  '31: y se sabe cuanto se le debe de vencido'
);

select is(
  (select oldest_open_due_date from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  date '2026-06-03',
  '32: el resumen dice cual es la deuda mas antigua'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- F. El consolidado es la suma de las unidades, no otro cálculo
--
-- Si el total se calculara aparte, dos fórmulas para el mismo numero divergirían
-- en cuanto alguien tocara una de las dos.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select sum(outstanding) from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where not is_consolidated),
  (select outstanding from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  '33: el saldo consolidado es la suma exacta de las unidades'
);

select is(
  (select total_sold from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where business_unit_code = 'PONEDORAS'),
  20000::numeric,
  '34: bu_a1 vendio 20.000, contando la venta de contado'
);

select is(
  (select outstanding from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where business_unit_code = 'PONEDORAS'),
  6000::numeric,
  '35: bu_a1 debe 6.000'
);

select is(
  (select total_sold from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where business_unit_code = 'CERDOS'),
  25000::numeric,
  '36: bu_a2 vendio 25.000'
);

select is(
  (select outstanding from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where business_unit_code = 'CERDOS'),
  0::numeric,
  '37: bu_a2 no debe nada: el abono cruzó desde la otra granja'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- G. HOY lo decide la app (ADR-0012)
--
-- Con `current_date` el resumen dependeria de la maquina del servidor. Estas dos
-- aserciones lo demuestran cambiando solo la fecha que recibe la funcion: el
-- mismo cliente, los mismos datos, dos veredictos de "vencida".
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$
    select * from finance.customer_financial_summary(tests.id('cliente_a'), null)
  $$,
  '22023',
  null,
  '38: sin fecha de negocio el resumen se niega, en vez de decir "0 vencidas"'
);

select is(
  (select overdue_count from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-02') where is_consolidated),
  0::bigint,
  '39: el 2026-06-02 la deuda del 2026-06-03 todavia no estaba vencida'
);

select is(
  (select overdue_count from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10') where is_consolidated),
  1::bigint,
  '40: el 2026-06-10 si lo estaba, con los mismos datos de siempre'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- H. Un cliente sin ventas no es un error ni un hueco raro
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from finance.customer_receivables
   where customer_id = tests.id('sin_historial')),
  0::bigint,
  '41: sin ventas no hay cartera'
);

select is(
  (select count(*) from finance.customer_financial_summary(
     tests.id('sin_historial'), date '2026-06-10')),
  1::bigint,
  '42: y el resumen responde una fila consolidada en cero, no cero filas'
);

select is(
  (select outstanding from finance.customer_financial_summary(
     tests.id('sin_historial'), date '2026-06-10')),
  0::numeric,
  '43: con todo en cero, para que la interfaz no tenga que tratar el vacio'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- I. Una organización no ve la cartera de la otra
-- ─────────────────────────────────────────────────────────────────────────────

select tests.act_as(tests.id('owner_b'));
select tests.set_org_header(tests.id('org_b')::text);

select is(
  (select count(*) from finance.customer_receivables
   where customer_id = tests.id('cliente_a')),
  0::bigint,
  '44: el dueño de B no ve la cartera de un cliente de A'
);

select is(
  (select outstanding from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10')),
  0::numeric,
  '45: ni el resumen de un cliente ajeno le devuelve saldos'
);

-- Un cliente de B con su propia venta: el filtro por cliente sigue siendo real.
insert into v_sale (clave, sale_id) values
  ('venta_b', public.create_sale(
    tests.id('bu_b1'), tests.id('cliente_b'), date '2026-06-01', null,
    'credit', 'Venta en B',
    '[{"product_name":"Producto B","quantity":1,"unit_price":9000}]'
  ));

select is(
  (select count(*) from finance.customer_receivables
   where customer_id = tests.id('cliente_b')),
  1::bigint,
  '46: y si ve la cartera de su propio cliente'
);

select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- J. Los identificadores que no son de esta organización
--
-- Un filtro manipulado no puede ampliar nada: RLS decide, no el `where`.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from finance.customer_receivables
   where customer_id = tests.id('cliente_b')),
  0::bigint,
  '47: filtrar por el cliente de otra organización no devuelve sus filas'
);

select is(
  (select count(*) from finance.customer_receivables
   where customer_id = tests.id('cliente_a')
     and business_unit_id = tests.id('bu_b1')),
  0::bigint,
  '48: filtrar por la unidad de otra organización tampoco'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- K. Sin contexto no se lee
--
-- Sin `x-organization-id` no hay organización activa, y las políticas comparan
-- contra NULL: no hay nada que ver. Como con RLS el silencio es la norma, estas
-- aserciones NO restauran la sesión antes de mirar, serían verdad por la razón
-- equivocada (es lo que corrigió `ac07b02` en las pruebas de clientes).
-- ─────────────────────────────────────────────────────────────────────────────

select tests.clear_session();
select tests.set_org_header('');

select is(
  (select count(*) from finance.customer_receivables),
  0::bigint,
  '49: sin contexto la cartera viene vacía'
);

select is(
  (select count(*) from finance.customer_payments),
  0::bigint,
  '50: y los abonos también'
);

select is(
  (select outstanding from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10')),
  0::numeric,
  '51: el resumen responde cero en vez de filtrar el saldo'
);

select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- L. `anon` no existe en este mundo financiero
--
-- No es que `anon` lea cero filas: es que no tiene permiso para preguntar. Por eso
-- aquí se espera 42501 y no un cero. Un cero significaría que la vista se abrió
-- y no devolvió nada, que es un estado distinto y peor.
-- ─────────────────────────────────────────────────────────────────────────────

set local role anon;

select throws_ok(
  $$ select count(*) from finance.customer_receivables $$,
  '42501',
  null,
  '52: anon no puede ni leer la vista de cartera'
);

select throws_ok(
  $$ select * from finance.customer_financial_summary(tests.id('cliente_a'), date '2026-06-10') $$,
  '42501',
  null,
  '53: anon no puede ejecutar el resumen'
);

set local role authenticated;
select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

-- ─────────────────────────────────────────────────────────────────────────────
-- M. La dependencia que hace que el filtro de anulaciones funcione
--
-- La vista excluye las ventas anuladas mirando su contra-asiento en
-- `finance.ledger_entries`, cuya política de lectura exige `finance.read`. Si un
-- rol pudiera leer cartera sin leer el libro, sus ventas anuladas volverían a
-- aparecer como saldo pendiente, y sin ningún error: simplemente el `not exists`
-- no encontraría el reverso.
--
-- Hoy los tres roles que llevan `finance.receivables.read` llevan también
-- `finance.read`, así que funciona. Esta aserción convierte esa coincidencia en
-- una regla: si alguien replica el permiso, la prueba falla y avisa.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (
    select count(*)
    from core.role_permissions rp
    where rp.permission_code = 'finance.receivables.read'
      and not exists (
        select 1
        from core.role_permissions rp2
        where rp2.role_code = rp.role_code
          and rp2.permission_code = 'finance.read'
      )
  ),
  0::bigint,
  '54: ningún rol puede leer cartera sin poder leer el libro mayor'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- N. La prueba que fija `security_invoker`
--
-- Esta es la que justifica el `security_invoker = true` de las dos vistas.
--
-- En PostgreSQL una vista normal se ejecuta con los privilegios de su DUEÑO, y
-- su dueño es quien aplicó la migración: un superusuario. Si las vistas NO
-- tuvieran `security_invoker`, las políticas RLS de `sales` y `receivables` no se
-- evaluarían y estas vistas devolverían la cartera de TODAS las organizaciones,
-- con la session del Dueño y sin que nadie lo notara.
--
-- Aquí se le quita a `viewer` todo permiso de finanzas y se le pregunta. Con
-- `security_invoker` correcto no ve nada. Si alguien quita la opción, esta
-- aserción devuelve filas y falla: ese es su trabajo.
--
-- Va al final porque modifica el catálogo de permisos, y hasta aquí las pruebas
-- necesitan ese rol intacto. Todo esto vive dentro de la transacción que cierra con
-- `rollback`, así que el catálogo real no se entera.
-- ─────────────────────────────────────────────────────────────────────────────

reset role;

delete from core.role_permissions
where role_code = 'viewer'
  and permission_code in (
    'finance.read',
    'finance.sales.read',
    'finance.receivables.read',
    'finance.payments.read'
  );

set local role authenticated;
select tests.act_as(tests.id('viewer_a'));
select tests.set_org_header(tests.id('org_a')::text);

select is(
  (select count(*) from finance.customer_receivables
   where customer_id = tests.id('cliente_a')),
  0::bigint,
  '55: sin permiso de cartera la vista no devuelve ni una fila'
);

select is(
  (select outstanding from finance.customer_financial_summary(
     tests.id('cliente_a'), date '2026-06-10')),
  0::numeric,
  '56: ni el resumen le muestra saldos'
);

select * from finish();
rollback;
