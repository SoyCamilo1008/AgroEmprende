-- Pruebas de la propiedad de la organización.
--
-- Regla que se prueba: toda organización tiene EXACTAMENTE un `owner` activo, y
-- cambiar quién es ese owner es una operación explícita, atómica y auditada.
--
-- Por qué necesita pruebas propias: la invariante se comprueba con un trigger
-- DIFERIDO, así que el error no aparece al escribir la sentencia sino al
-- terminar la transacción. Una suite que solo probara "se transfirió bien"
-- pasaría con la invariancia rota: el fallo de "degradar al único owner" es
-- justamente un fallo en el commit, que ninguna aserción normal alcanza.
--
-- Este archivo NO se ejecuta sin Docker: lo ejecuta el job `migrations` del CI.

begin;

select plan(17);

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

create table tests.own (
  key text primary key,
  value uuid not null
);

-- La transferencia devuelve un jsonb y solo puede ejecutarse UNA vez: la
-- segunda pasada fallaría porque el que la llama ya no es el propietario. Por eso
-- el resultado se guarda aquí y se consulta dos veces, en vez de transferir dos
-- veces y comparar dos transferencias distintas.
create table tests.own_result (
  key text primary key,
  value jsonb not null
);

grant usage on schema tests to anon, authenticated;
grant select on tests.own to anon, authenticated;
grant select, insert, update on tests.own_result to anon, authenticated;

create function tests.own_id(p_key text)
returns uuid
language sql
stable
as $$
  select value from tests.own where key = p_key
$$;

grant execute on function tests.own_id(text) to anon, authenticated;

create function tests.own_make_user()
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

grant execute on function tests.own_make_user() to anon, authenticated;

create function tests.own_act_as(p_user_id uuid)
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

grant execute on function tests.own_act_as(uuid) to anon, authenticated;

create function tests.own_capture(p_key text, p_value jsonb)
returns void
language sql
as $$
  insert into tests.own_result (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value
$$;

grant execute on function tests.own_capture(text, jsonb) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Escenario
--
-- Una granja con dueño, sucesor, un miembro dado de baja, un admin, un
-- encargado y un observador; y una granja ajena con su propio dueño, que es el
-- usuario "de otra organización" con el que no se puede transferir.
--
-- Los usuarios se crean con superusuario porque `authenticated` no puede
-- insertar en `auth.users`, y las membresías también: no hay política de INSERT
-- en `core.organization_members` a propósito (el onboarding y las invitaciones
-- son los caminos válidos).
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_owner uuid := tests.own_make_user();
  v_successor uuid := tests.own_make_user();
  v_inactive uuid := tests.own_make_user();
  v_admin uuid := tests.own_make_user();
  v_manager uuid := tests.own_make_user();
  v_viewer uuid := tests.own_make_user();
  v_outsider uuid := tests.own_make_user();
  v_org_a uuid;
  v_org_b uuid;
begin
  perform tests.own_act_as(v_owner);
  select (r ->> 'organization_id')::uuid into v_org_a
  from public.create_organization_with_business_unit(
    'Granja con dueño', 'PONEDORAS', 'Ponedoras', 'poultry_layers'
  ) as r;

  -- Dueño de una granja distinta: existe, es miembro activo, pero no de esta.
  perform tests.own_act_as(v_outsider);
  select (r ->> 'organization_id')::uuid into v_org_b
  from public.create_organization_with_business_unit(
    'Granja ajena', 'CERDOS', 'Cerdos', 'swine'
  ) as r;

  insert into core.organization_members (organization_id, user_id, role_code) values
    (v_org_a, v_successor, 'manager'),
    (v_org_a, v_inactive, 'operator'),
    (v_org_a, v_admin, 'admin'),
    (v_org_a, v_manager, 'manager'),
    (v_org_a, v_viewer, 'viewer');

  -- El que se reactiva después: una baja no es una baja definitiva.
  update core.organization_members
  set is_active = false
  where organization_id = v_org_a and user_id = v_inactive;

  insert into tests.own (key, value) values
    ('owner', v_owner),
    ('successor', v_successor),
    ('inactive', v_inactive),
    ('admin', v_admin),
    ('manager', v_manager),
    ('viewer', v_viewer),
    ('outsider', v_outsider),
    ('org_a', v_org_a),
    ('org_b', v_org_b)
  on conflict (key) do update set value = excluded.value;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-3. Solo el propietario actual transfiere
--
-- El caso del `admin` es el que importa: si pudiera transferir, podría
-- nombrarse a sí mismo propietario, y la invariante de "un owner" no lo
-- detectaría porque se cumpliría.
-- ─────────────────────────────────────────────────────────────────────────────

set local role authenticated;

select tests.own_act_as(tests.own_id('viewer'));

select throws_ok(
  $$ select public.transfer_organization_ownership(
       (select tests.own_id('org_a')), (select tests.own_id('successor'))) $$,
  '42501',
  'Solo el propietario actual puede transferir la propiedad',
  'un observador no puede transferir la propiedad'
);

select tests.own_act_as(tests.own_id('manager'));

select throws_ok(
  $$ select public.transfer_organization_ownership(
       (select tests.own_id('org_a')), (select tests.own_id('successor'))) $$,
  '42501',
  'Solo el propietario actual puede transferir la propiedad',
  'un encargado no puede transferir la propiedad aunque administre la granja'
);

select tests.own_act_as(tests.own_id('admin'));

select throws_ok(
  $$ select public.transfer_organization_ownership(
       (select tests.own_id('org_a')), (select tests.own_id('admin'))) $$,
  '42501',
  'Solo el propietario actual puede transferir la propiedad',
  'un administrador no puede tomar la propiedad: es el escalamiento que la regla de un solo owner no cubre'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4-8. Destinatario inválido, cada motivo con su propio mensaje
-- ─────────────────────────────────────────────────────────────────────────────

select tests.own_act_as(tests.own_id('owner'));

select throws_ok(
  $$ select public.transfer_organization_ownership(
       (select tests.own_id('org_a')), gen_random_uuid()) $$,
  '22023',
  'El usuario indicado no existe',
  'un id que no corresponde a ninguna cuenta no es un dueño posible'
);

select throws_ok(
  $$ select public.transfer_organization_ownership(
       (select tests.own_id('org_a')), (select tests.own_id('outsider'))) $$,
  '22023',
  'El usuario indicado no pertenece a la organización',
  'el dueño de otra granja no puede recibir la propiedad de esta'
);

select throws_ok(
  $$ select public.transfer_organization_ownership(
       (select tests.own_id('org_a')), (select tests.own_id('inactive'))) $$,
  '22023',
  'El usuario indicado está inactivo en la organización',
  'un miembro dado de baja no puede recibir la propiedad: hay que reactivarlo antes'
);

select throws_ok(
  $$ select public.transfer_organization_ownership(
       (select tests.own_id('org_a')), (select tests.own_id('owner'))) $$,
  '22023',
  'El usuario indicado ya es el propietario',
  'transferirse la propiedad a uno mismo no es una transferencia'
);

select throws_ok(
  $$ select public.transfer_organization_ownership(
       gen_random_uuid(), (select tests.own_id('successor'))) $$,
  'P0002',
  'La organización no existe',
  'una organización que no existe no tiene dueño que transferir'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Sin sesión no se transfiere
-- ─────────────────────────────────────────────────────────────────────────────

select set_config('request.jwt.claims', '', true);

select throws_ok(
  $$ select public.transfer_organization_ownership(
       (select tests.own_id('org_a')), (select tests.own_id('successor'))) $$,
  '28000',
  'Se requiere una sesión activa',
  'transferir sin sesión es el camino para que cualquiera tome una granja'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10-14. La transferencia válida
--
-- Todo lo anterior no cambió nada: las ocho aserciones fallaron y la
-- organización sigue teniendo su dueño. Eso también se comprueba.
-- ─────────────────────────────────────────────────────────────────────────────

select tests.own_act_as(tests.own_id('owner'));

select tests.own_capture(
  'transfer',
  public.transfer_organization_ownership(
    (select tests.own_id('org_a')), (select tests.own_id('successor'))
  )
);

select is(
  (select (value ->> 'previous_owner_id')::uuid from tests.own_result where key = 'transfer'),
  tests.own_id('owner'),
  'la transferencia devuelve quién cedía la propiedad'
);

select is(
  (select (value ->> 'new_owner_id')::uuid from tests.own_result where key = 'transfer'),
  tests.own_id('successor'),
  'y quién la recibe'
);

select is(
  (select count(*)
   from core.organization_members
   where organization_id = tests.own_id('org_a')
     and role_code = 'owner'
     and is_active),
  1::bigint,
  'después de transferir hay exactamente un propietario activo, no dos'
);

select is(
  (select role_code || '|' || is_active::text
   from core.organization_members
   where organization_id = tests.own_id('org_a')
     and user_id = tests.own_id('owner')),
  'admin|true',
  'el que cedió la propiedad conserva el acceso como admin y sigue activo'
);

select is(
  (select count(*)
   from core.audit_log
   where action = 'organization.ownership_transferred'
     and (old_values ->> 'owner_id') = tests.own_id('owner')::text
     and (new_values ->> 'owner_id') = tests.own_id('successor')::text),
  1::bigint,
  'la transferencia quedó auditada con el propietario antes y el después'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 15-17. La invariante, que no se ve hasta el commit
--
-- `set constraints all immediate` convierte el trigger diferido en inmediato:
-- sin esto, el error se produciría en el COMMIT del archivo, donde ninguna
-- aserción puede alcanzarlo, y estas tres comprobaciones pasarían sin estar
-- probando nada. Es la razón de que este archivo sea más difícil de leer que
-- los otros dos.
--
-- A partir de aquí se actúa como el NUEVO propietario: es el escenario en el
-- que alguien intentaría quedarse con el dueño.
-- ─────────────────────────────────────────────────────────────────────────────

select tests.own_act_as(tests.own_id('successor'));

set constraints all immediate;

select throws_ok(
  $$ update core.organization_members
     set role_code = 'admin'
     where organization_id = (select tests.own_id('org_a'))
       and role_code = 'owner' $$,
  '23514',
  'La organización debe tener exactamente un propietario activo y tiene 0',
  'degradar al único propietario se rechaza: la organización no puede quedarse sin dueño'
);

select throws_ok(
  $$ update core.organization_members
     set role_code = 'owner'
     where organization_id = (select tests.own_id('org_a'))
       and user_id = (select tests.own_id('admin')) $$,
  '23505',
  null,
  'no se pueden declarar dos propietarios activos a la vez'
);

set constraints all deferred;

select is(
  (select count(*)
   from core.organization_members
   where organization_id = tests.own_id('org_a')
     and role_code = 'owner'
     and is_active),
  1::bigint,
  'los dos intentos fallidos no dejaron la organización sin propietario ni con dos'
);

select * from finish();
rollback;
