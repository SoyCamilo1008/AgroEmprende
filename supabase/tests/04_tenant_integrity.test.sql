-- Pruebas de integridad multitenant por clave foránea.
--
-- Regla que se prueba: una fila nunca puede colgar de algo que pertenece a otra
-- organización. No "no se puede ver", no "no se puede escribir desde la app": no
-- puede EXISTIR, ni siquiera escribiéndola el superusuario.
--
-- Por qué este archivo corre SIN cambiar de rol a propósito
-- --------------------------------------------------------
-- Con `set role authenticated`, una referencia cruzada fallaría igual por RLS
-- aunque la clave foránea no existiera, y la prueba seguiría en verde. Estas
-- aserciones solo valen algo porque el rol es el dueño del esquema: RLS no se
-- aplica, así que el único mecanismo que puede rechazarlas es la FK. Si alguien
-- revierte `member_business_units` a FKs simples por `id`, este archivo se
-- rompe y esa es exactamente su función.
--
-- Este archivo NO se ejecuta sin Docker: lo ejecuta el job `migrations` del CI.

begin;

select plan(14);

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

create table tests.ti (
  key text primary key,
  value uuid not null
);

grant usage on schema tests to anon, authenticated;
grant select on tests.ti to anon, authenticated;

create function tests.ti_id(p_key text)
returns uuid
language sql
stable
as $$
  select value from tests.ti where key = p_key
$$;

grant execute on function tests.ti_id(text) to anon, authenticated;

-- `code` es único POR organización, no global: por eso una cuenta se localiza
-- por (granja, código) y no por código. Usar solo el código escondería justo el
-- error que estas pruebas intentan cazar.
create function tests.ti_account_id(p_org_key text, p_code text)
returns uuid
language sql
stable
as $$
  select a.id
  from core.accounts a
  where a.organization_id = tests.ti_id(p_org_key) and a.code = p_code
$$;

grant execute on function tests.ti_account_id(text, text) to anon, authenticated;

create function tests.ti_act_as(p_user_id uuid)
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

grant execute on function tests.ti_act_as(uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Escenario
--
-- Dos granjas con su dueño y su unidad. En la granja A hay además un operador y
-- una cuenta de `auth.users` sin ninguna membresía: son los dos ways de
-- equivocarse al asignar un alcance, y merecen aserciones separadas.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_owner_a uuid;
  v_owner_b uuid;
  v_operator_a uuid;
  v_sin_membresia uuid;
  v_org_a uuid;
  v_org_b uuid;
  v_bu_a uuid;
  v_bu_b uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role) values
    (gen_random_uuid(), 'dueno.a@ejemplo.test', '{}'::jsonb, 'authenticated', 'authenticated'),
    (gen_random_uuid(), 'dueno.b@ejemplo.test', '{}'::jsonb, 'authenticated', 'authenticated'),
    (gen_random_uuid(), 'operador.a@ejemplo.test', '{}'::jsonb, 'authenticated', 'authenticated'),
    (gen_random_uuid(), 'sin.membresia@ejemplo.test', '{}'::jsonb, 'authenticated', 'authenticated');

  select id into v_owner_a from auth.users where email = 'dueno.a@ejemplo.test';
  select id into v_owner_b from auth.users where email = 'dueno.b@ejemplo.test';
  select id into v_operator_a from auth.users where email = 'operador.a@ejemplo.test';
  select id into v_sin_membresia from auth.users where email = 'sin.membresia@ejemplo.test';

  perform tests.ti_act_as(v_owner_a);
  select (r ->> 'organization_id')::uuid, (r ->> 'business_unit_id')::uuid
  into v_org_a, v_bu_a
  from public.create_organization_with_business_unit(
    'Granja A', 'PONEDORAS_A', 'Ponedoras A', 'poultry_layers'
  ) as r;

  perform tests.ti_act_as(v_owner_b);
  select (r ->> 'organization_id')::uuid, (r ->> 'business_unit_id')::uuid
  into v_org_b, v_bu_b
  from public.create_organization_with_business_unit(
    'Granja B', 'CERDOS_B', 'Cerdos B', 'swine'
  ) as r;

  insert into core.organization_members (organization_id, user_id, role_code)
  values (v_org_a, v_operator_a, 'operator');

  -- El plan de cuentas: el MISMO código en las dos granjas, porque `code` es
  -- único por organización. Es lo que hace indistinguibles a simple vista una
  -- referencia cruzada y una correcta.
  --
  -- `on conflict` porque `create_organization_with_business_unit` ya copia las
  -- plantillas del plan de cuentas a cada organización nueva: el 1105 de cada
  -- granja llega por ahí, y sin esto este test reventaba por duplicado. Que el
  -- código exista en las dos es justo lo que se quiere comprobar.
  insert into core.accounts (organization_id, code, name, type) values
    (v_org_a, '1105', 'Caja', 'asset'),
    (v_org_b, '1105', 'Caja', 'asset')
  on conflict (organization_id, code) do nothing;

  insert into tests.ti (key, value) values
    ('owner_a', v_owner_a),
    ('owner_b', v_owner_b),
    ('operator_a', v_operator_a),
    ('sin_membresia', v_sin_membresia),
    ('org_a', v_org_a),
    ('org_b', v_org_b),
    ('bu_a', v_bu_a),
    ('bu_b', v_bu_b)
  on conflict (key) do update set value = excluded.value;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-4. Alcances de unidad: `member_business_units`
--
-- La misma tabla, dos referencias que antes colgaban de un `id` suelto. La
-- segunda es la más discreta: el usuario existe, está en el sistema, y solo
-- pertenece a OTRA granja.
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ insert into core.member_business_units (organization_id, user_id, business_unit_id)
     values (
       (select tests.ti_id('org_a')),
       (select tests.ti_id('owner_a')),
       (select tests.ti_id('bu_b'))
     ) $$,
  '23503',
  null,
  'un alcance no puede apuntar a una unidad de otra granja'
);

select throws_ok(
  $$ insert into core.member_business_units (organization_id, user_id, business_unit_id)
     values (
       (select tests.ti_id('org_a')),
       (select tests.ti_id('owner_b')),
       (select tests.ti_id('bu_a'))
     ) $$,
  '23503',
  null,
  'un alcance no puede asignarse a un dueño que pertenece a otra granja'
);

select throws_ok(
  $$ insert into core.member_business_units (organization_id, user_id, business_unit_id)
     values (
       (select tests.ti_id('org_a')),
       (select tests.ti_id('sin_membresia')),
       (select tests.ti_id('bu_a'))
     ) $$,
  '23503',
  null,
  'un usuario que no es miembro de la granja no puede tener alcance en ella: el alcance se define sobre una membresía'
);

select is(
  (select count(*)
   from core.member_business_units
   where organization_id = tests.ti_id('org_a')
     and user_id = tests.ti_id('operator_a')
     and business_unit_id = tests.ti_id('bu_a')),
  0::bigint,
  'los intentos fallidos no dejaron filas: ninguna referencia cruzada se coló'
);

insert into core.member_business_units (organization_id, user_id, business_unit_id)
values (
  (select tests.ti_id('org_a')),
  (select tests.ti_id('operator_a')),
  (select tests.ti_id('bu_a'))
);

select is(
  (select count(*)
   from core.member_business_units
   where organization_id = tests.ti_id('org_a')
     and user_id = tests.ti_id('operator_a')
     and business_unit_id = tests.ti_id('bu_a')),
  1::bigint,
  'el mismo alcance con la unidad de SU granja sí se guarda: la FK no restringe de más'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5-6. Jerarquía de cuentas: `accounts.parent_id`
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ insert into core.accounts (organization_id, code, name, type, parent_id)
     values (
       (select tests.ti_id('org_a')),
       '1110',
       'Bancos',
       'asset',
       (select id from core.accounts where organization_id = tests.ti_id('org_b') and code = '1105')
     ) $$,
  '23503',
  null,
  'una cuenta no puede colgarse de una cuenta de otra granja'
);

insert into core.accounts (organization_id, code, name, type, parent_id)
values (
  (select tests.ti_id('org_a')),
  '110501',
  'Caja principal',
  'asset',
  (select tests.ti_account_id('org_a', '1105'))
);

select is(
  (select count(*)
   from core.accounts
   where organization_id = tests.ti_id('org_a')
     and parent_id = (select tests.ti_account_id('org_a', '1105'))),
  1::bigint,
  'una cuenta sí puede colgarse de otra de SU granja'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7-9. Parámetros de referencia: `business_unit_id` y el caso NULL
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ insert into core.reference_parameters (
       organization_id, business_unit_id, key, label, category, data_kind, numeric_value)
     values (
       (select tests.ti_id('org_a')),
       (select tests.ti_id('bu_b')),
       'precio.venta.reference',
       'Precio de venta de referencia',
       'price_reference',
       'reference',
       12000
     ) $$,
  '23503',
  null,
  'un parámetro no puede describir una unidad de otra granja'
);

insert into core.reference_parameters (
  organization_id, business_unit_id, key, label, category, data_kind, numeric_value)
values (
  (select tests.ti_id('org_a')),
  null,
  'dias.crianza.configured',
  'Días de cría configurados',
  'planning',
  'configured',
  35
);

select is(
  (select count(*)
   from core.reference_parameters
   where organization_id = tests.ti_id('org_a') and business_unit_id is null),
  1::bigint,
  'un parámetro sin unidad sigue siendo válido: significa "de toda la granja"'
);

insert into core.reference_parameters (
  organization_id, business_unit_id, key, label, category, data_kind, numeric_value)
values (
  (select tests.ti_id('org_a')),
  (select tests.ti_id('bu_a')),
  'densidad.ponedoras.reference',
  'Densidad de ponedoras de referencia',
  'technical',
  'reference',
  6
);

select is(
  (select count(*)
   from core.reference_parameters
   where organization_id = tests.ti_id('org_a')
     and business_unit_id = tests.ti_id('bu_a')),
  1::bigint,
  'un parámetro con la unidad de SU granja se guarda'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10-11. Las FKs en cascada hacen el trabajo de la baja
--
-- Una FK que además borra lo que cuelga evita el estado imposible "el operador
-- sigue teniendo un alcance en una unidad que ya no existe".
-- ─────────────────────────────────────────────────────────────────────────────

delete from core.organization_members
where organization_id = tests.ti_id('org_a')
  and user_id = tests.ti_id('operator_a');

select is(
  (select count(*)
   from core.member_business_units
   where organization_id = tests.ti_id('org_a')
     and user_id = tests.ti_id('operator_a')),
  0::bigint,
  'dar de baja a un miembro elimina sus alcances: no sobreviven filas colgadas de una membresía que ya no existe'
);

delete from core.business_units where id = tests.ti_id('bu_a');

select is(
  (select count(*)
   from core.reference_parameters
   where organization_id = tests.ti_id('org_a')
     and business_unit_id is not null),
  0::bigint,
  'borrar la unidad elimina sus parámetros, y deja intactos los de la granja entera'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 12-13. `on delete no action` en la jerarquía de cuentas
--
-- Con `on delete set null` sobre una FK compuesta, borrar el padre intentaría
-- anular también `organization_id`, que es NOT NULL: la cuenta hija moriría en
-- lugar de sobrevivir. `no action` dice lo que se quiere, que es no poder
-- borrar el padre mientras tenga hijos.
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ delete from core.accounts
     where organization_id = tests.ti_id('org_a') and code = '1105' $$,
  '23503',
  null,
  'no se puede borrar una cuenta que tiene cuentas colgando'
);

select is(
  (select count(*) from core.accounts where organization_id = tests.ti_id('org_a')),
  2::bigint,
  'y el rechazo no borró ni la cuenta ni su hija'
);

select * from finish();
rollback;
