-- Historial de ventas del cliente: la tercera lectura del bloque financiero.
--
-- Estas pruebas NO se ejecutan sin Docker: las corre el job de migraciones del CI.
--
-- Que se prueba
-- -------------
-- La migracion `20260928173000` anade `finance.customer_sales`, la vista que el
-- historial de un cliente necesita y que `finance.sales` no puede dar.
--
-- Lo que NO se prueba aqui, y por que
-- -----------------------------------
-- Que los totales de las ventas sean los correctos: eso lo prueba
-- `05_finance_ledger` y `06_finance_payments` en la base. Aqui se prueba el dato
-- que la tabla `finance.sales` NO tiene y que sin esta vista se diria lo
-- contrario:
--
--   1. `is_voided`. Una venta anulada no tiene columna que lo diga: se reconoce
--      por su contra-asiento `reversal` en el libro mayor (ADR-0003), y no hay
--      llave foranea que permita incrustarlo con un embed de PostgREST. Sin la
--      vista, la pantalla de historial listaria una venta anulada junto a su
--      numero de factura, como si hubiera ocurrido.
--   2. Que el historial NO borre la venta anulada. `append-only`: se marca, no se
--      oculta. Ocultarla seria borrar historia.
--   3. Que el filtro de anulaciones no se pueda aplicar en silencio. Si un rol
--      puede leer ventas pero no el libro, el `exists` daria FALSE y la venta
--      anulada apareceria VIGENTE. La seccion F quita ese permiso a proposito.
--
-- El escenario, con numeros que se pueden contar a mano
-- ----------------------------------------------------
-- org_a, dos unidades: PONEDORAS (bu_a1) y CERDOS (bu_a2).
--
--   venta     unidad  metodo  total    fecha      estado final
--   ---------  ------  ------  -------  ----------  ---------------------------
--   contado   bu_a1   cash    10.000   2026-05-04  sin cartera (se liquido)
--   credito   bu_a2   credit  20.000   2026-04-01  pendiente, en cartera
--   anulada   bu_a1   credit   7.000   2026-05-04  anulada: en el historial, no en cartera

begin;

select plan(20);

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
    'Granja historial A', 'PONEDORAS', 'Ponederas historial', 'poultry_layers'
  ) as r;

  -- El plan de cuentas es de alcance organizacional, asi que una unidad nueva puede
  -- vender sin sembrar nada.
  insert into core.business_units (organization_id, code, name, type)
  values (v_org_a, 'CERDOS', 'Cerdos historial', 'swine')
  returning id into v_bu_a2;

  perform tests.act_as(v_owner_b);
  select (r ->> 'organization_id')::uuid, (r ->> 'business_unit_id')::uuid
  into v_org_b, v_bu_b1
  from public.create_organization_with_business_unit(
    'Granja historial B', 'OTRAS', 'Otras historial', 'other'
  ) as r;

  perform tests.act_as(v_owner_a);
  insert into core.organization_members (organization_id, user_id, role_code)
  values (v_org_a, v_viewer_a, 'viewer');

  insert into core.customers (organization_id, name, credit_days)
  values (v_org_a, 'Cliente con historial', 30)
  returning id into v_cliente_a;

  insert into core.customers (organization_id, name, credit_days)
  values (v_org_a, 'Cliente sin ventas', 30)
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

create temp table v_sale (clave text primary key, sale_id uuid);

insert into v_sale (clave, sale_id) values
  ('contado', public.create_sale(
    tests.id('bu_a1'), tests.id('cliente_a'), date '2026-05-04', null,
    'cash', 'Venta de contado',
    '[{"product_name":"Huevos","quantity":20,"unit_price":500}]'
  )),
  ('credito', public.create_sale(
    tests.id('bu_a2'), tests.id('cliente_a'), date '2026-04-01', null,
    'credit', 'Venta a credito',
    '[{"product_name":"Pollos","quantity":20,"unit_price":1000}]'
  )),
  ('anulada', public.create_sale(
    tests.id('bu_a1'), tests.id('cliente_a'), date '2026-05-04', null,
    'credit', 'Venta que se anula',
    '[{"product_name":"Huevos","quantity":7,"unit_price":1000}]'
  ));

select public.void_sale((select sale_id from v_sale where clave = 'anulada'));

-- ─────────────────────────────────────────────────────────────────────────────
-- A. El historial es historial, no la cartera
--
-- `customer_receivables` y `customer_sales` responden preguntas distintas y por
-- eso cuentan distinto. La cartera excluye lo anulado y lo de contado; el
-- historial los incluye a los dos. Confundirlas seria mostrarle a un cliente una
-- venta de 10.000 que no le debe, o esconderle una factura que emitio.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from finance.customer_sales
   where customer_id = tests.id('cliente_a')),
  3::bigint,
  '1: el historial tiene las tres ventas del cliente'
);

select is(
  (select count(*) from finance.customer_sales
   where customer_id = tests.id('cliente_a')
     and payment_method = 'cash'),
  1::bigint,
  '2: la venta de contado tambien, que se liquido en el acto'
);

select is(
  (select count(*) from finance.customer_sales
   where customer_id = tests.id('cliente_a') and is_voided),
  1::bigint,
  '3: y la anulada tambien: append-only, se marca, no se borra'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- B. La marca de anulacion, que es el motivo de esta vista
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from finance.customer_sales
   where customer_id = tests.id('cliente_a') and not is_voided),
  2::bigint,
  '4: las dos ventas vivas no estan anuladas'
);

select is(
  (select is_voided from finance.customer_sales
   where sale_id = (select sale_id from v_sale where clave = 'anulada')),
  true,
  '5: la anulada se marca como anulada, leyendo su contra-asiento'
);

-- Si la fila saliera sin numero de factura, la pantalla tendria que inventar una
-- etiqueta, y el contador de facturas del cliente dejaria de cuadrar.
select ok(
  (select invoice_number is not null and char_length(invoice_number) > 0
   from finance.customer_sales
   where sale_id = (select sale_id from v_sale where clave = 'anulada')),
  '6: la venta anulada conserva su numero de factura'
);

-- Anular no es borrar: el importe sigue siendo el que se emitio.
select is(
  (select total from finance.customer_sales
   where sale_id = (select sale_id from v_sale where clave = 'anulada')),
  7000::numeric,
  '7: y su total, que es el que se registro en el dia'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. La unidad de negocio (ADR-0004)
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select business_unit_id from finance.customer_sales
   where sale_id = (select sale_id from v_sale where clave = 'contado')),
  tests.id('bu_a1'),
  '8: la venta de contado es de PONEDORAS'
);

select is(
  (select business_unit_id from finance.customer_sales
   where sale_id = (select sale_id from v_sale where clave = 'credito')),
  tests.id('bu_a2'),
  '9: la venta a credito es de CERDOS, sin mezclarla con la anterior'
);

select is(
  (select business_unit_code from finance.customer_sales
   where sale_id = (select sale_id from v_sale where clave = 'credito')),
  'CERDOS',
  '10: y cada venta trae el codigo de su unidad, no solo el id'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- D. Coherencia con la cartera
--
-- Las dos vistas se leen en la misma pantalla. Si una contuviera una venta que la
-- otra excluye, la suma de la cartera no cuadraria con el historial, sin error
-- que nadie pueda ver.
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from finance.customer_receivables
   where customer_id = tests.id('cliente_a')
     and invoice_number = (select invoice_number from finance.customer_sales
                           where sale_id = (select sale_id from v_sale where clave = 'anulada'))),
  0::bigint,
  '11: la venta anulada no aparece en la cartera'
);

select is(
  (select count(*) from finance.customer_receivables
   where customer_id = tests.id('cliente_a')
     and invoice_number = (select invoice_number from finance.customer_sales
                           where sale_id = (select sale_id from v_sale where clave = 'contado'))),
  0::bigint,
  '12: ni la de contado, que nunca genero obligacion'
);

select is(
  (select balance from finance.customer_receivables
   where customer_id = tests.id('cliente_a')
     and invoice_number = (select invoice_number from finance.customer_sales
                           where sale_id = (select sale_id from v_sale where clave = 'credito'))),
  20000::numeric,
  '13: la de credito si, con lo que el cliente debe'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- E. Vacio y aislamiento
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*) from finance.customer_sales
   where customer_id = tests.id('sin_historial')),
  0::bigint,
  '14: un cliente sin ventas tiene un historial vacio, no un error'
);

select tests.act_as(tests.id('owner_b'));
select tests.set_org_header(tests.id('org_b')::text);

insert into v_sale (clave, sale_id) values
  ('venta_b', public.create_sale(
    tests.id('bu_b1'), tests.id('cliente_b'), date '2026-06-01', null,
    'credit', 'Venta en B',
    '[{"product_name":"Producto B","quantity":1,"unit_price":9000}]'
  ));

select is(
  (select count(*) from finance.customer_sales
   where customer_id = tests.id('cliente_a')),
  0::bigint,
  '15: la otra organizacion no ve el historial de este cliente'
);

select is(
  (select count(*) from finance.customer_sales
   where customer_id = tests.id('cliente_b')),
  1::bigint,
  '16: pero si el de su propio cliente'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- F. La seguridad de la vista
-- ─────────────────────────────────────────────────────────────────────────────

set local role anon;

select throws_ok(
  $$ select count(*) from finance.customer_sales $$,
  '42501',
  null,
  '17: anon no puede ni leer el historial'
);

set local role authenticated;
select tests.act_as(tests.id('owner_a'));
select tests.set_org_header(tests.id('org_a')::text);

-- El `exists` que produce `is_voided` lee `ledger_entries`, cuya politica exige
-- `finance.read`. Si un rol pudiera leer ventas sin leer el libro, el `exists`
-- devolveria FALSE y la venta anulada se presentaria como VIGENTE. Hoy ningun rol
-- esta en esa situacion; esta asercion convierte la coincidencia en una regla.
select is(
  (
    select count(*)
    from core.role_permissions rp
    where rp.permission_code = 'finance.sales.read'
      and not exists (
        select 1
        from core.role_permissions rp2
        where rp2.role_code = rp.role_code
          and rp2.permission_code = 'finance.read'
      )
  ),
  0::bigint,
  '18: ningun rol puede leer ventas sin poder leer el libro mayor'
);

-- La prueba que fija `security_invoker`.
--
-- En PostgreSQL una vista normal se ejecuta con los privilegios de su DUEÑO, que
-- aqui es quien aplico la migracion: un superusuario. Sin `security_invoker = true`
-- las politicas de `sales` y `ledger_entries` no se evaluarian y esta vista
-- devolveria las ventas de TODAS las organizaciones.
--
-- A `viewer` se le quita SOLO `finance.sales.read` y se le CONSERVA `finance.read` a
-- proposito. Es lo que separa esta asercion de una que pasaria por la razon
-- equivocada: con `finance.read` presente, el filtro `has_permission('finance.read')`
-- de la vista deja pasar, asi que lo unico que puede impedir las filas es el RLS de
-- `finance.sales`. En la primera version de esta migracion la vista venia sin la
-- opcion `security_invoker`, las aserciones 19 y 20 PASARON (el filtro de permisos
-- las tapaba) y la 15 fallo con una fuga entre organizaciones: tres ventas de la
-- granja A servidas al dueño de la granja B.
--
-- Por eso el permiso que se quita es el de ventas, no el del modulo. Y por eso la
-- prueba que de verdad atrapa la fuga es la 15, que cruza organizaciones con un
-- dueno que tiene todos los permisos: ahi no hay ningun filtro que disimule un RLS
-- ausente.
--
-- Modifica el catalogo de permisos, asi que va al final, y todo vive dentro de la
-- transaccion que cierra con `rollback`.
reset role;

delete from core.role_permissions
where role_code = 'viewer' and permission_code = 'finance.sales.read';

set local role authenticated;
select tests.act_as(tests.id('viewer_a'));
select tests.set_org_header(tests.id('org_a')::text);

select is(
  (select count(*) from finance.customer_sales
   where customer_id = tests.id('cliente_a')),
  0::bigint,
  '19: con permiso del modulo pero sin el de ventas, RLS lo detiene'
);

-- Y el caso del que depende toda la honestidad de `is_voided`: `viewer` vuelve a
-- tener permiso de ventas, pero se le quita `finance.read`, que es lo que autoriza
-- leer el contra-asiento.
--
-- Si la vista devolviera filas aqui, las devolveria con `is_voided = false` en la
-- venta anulada: un historial que cuadra con la cartera y no con la realidad, y que
-- no da ninguna pista de estar mal. Se espera CERO filas, que es un sintoma
-- visible y diagnosticable en vez de un numero silenciosamente equivocado.
reset role;

insert into core.role_permissions (role_code, permission_code)
values ('viewer', 'finance.sales.read')
on conflict do nothing;

delete from core.role_permissions
where role_code = 'viewer' and permission_code = 'finance.read';

set local role authenticated;
select tests.act_as(tests.id('viewer_a'));
select tests.set_org_header(tests.id('org_a')::text);

select is(
  (select count(*) from finance.customer_sales
   where customer_id = tests.id('cliente_a')),
  0::bigint,
  '20: con ventas pero sin libro, historial vacio: falla en cerrado'
);

select * from finish();
rollback;
