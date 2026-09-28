-- Pruebas del flujo de invitaciones.
--
-- Una invitación es el único camino por el que un usuario nuevo entra a una
-- organización, así que concentra tres riesgos:
--   1. Que el token se pueda adivinar o reutilizar.
--   2. Que un token válido le regale la organización a la cuenta equivocada.
--   3. Que alguien reciba un rol superior al que le corresponde.
--
-- Se prueba que CADA uno de los tres falla, no solo que el camino feliz funciona.
--
-- Cada archivo de prueba es su propia transacción con `rollback`, así que los
-- helpers se declaran aquí en vez de compartirse: los de `01_multitenant_rls`
-- ya no existen cuando este archivo empieza.

begin;

select plan(16);

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

  -- Ver 01_multitenant_rls: el `search_path` incluye el esquema real de pgtap.
  perform set_config('search_path', v_pgtap_schema || ', public', true);
end;
$$;

create table tests.inv (
  key text primary key,
  value uuid not null
);

-- Los tokens se copian aquí porque la tabla real los esconde a quien no
-- administra miembros, y con eso la función recibiría NULL en vez del token:
-- la prueba pasaría por el motivo equivocado (`no encontrada`) y no probaría
-- ni el enlace con el correo ni el uso único. En producción el token llega por
-- el enlace de la invitación, no por una consulta a la base.
create table tests.inv_token (
  email text primary key,
  token text not null
);

grant usage on schema tests to anon, authenticated;
grant select on tests.inv, tests.inv_token to anon, authenticated;

create function tests.inv_id(p_key text)
returns uuid
language sql
stable
as $$
  select value from tests.inv where key = p_key
$$;

grant execute on function tests.inv_id(text) to anon, authenticated;

create function tests.inv_token_of(p_email text)
returns text
language sql
stable
as $$
  select token from tests.inv_token where email = p_email
$$;

grant execute on function tests.inv_token_of(text) to anon, authenticated;

create function tests.inv_act_as(p_user_id uuid)
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

grant execute on function tests.inv_act_as(uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Escenario
--
-- Todos los usuarios se crean AQUÍ, con el rol de superusuario, porque
-- `authenticated` no puede insertar en `auth.users`. Cambiar de rol antes de
-- crearlos haría fallar el arranque de la prueba por un permiso, no por la
-- invitación que se quiere probar.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_owner uuid;
  v_manager uuid;
  v_invitee uuid;
  v_other uuid;
  v_org uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  values
    (gen_random_uuid(), 'dueno@ejemplo.test', '{}'::jsonb, 'authenticated', 'authenticated'),
    (gen_random_uuid(), 'encargado@ejemplo.test', '{}'::jsonb, 'authenticated', 'authenticated'),
    (gen_random_uuid(), 'invitada@ejemplo.test', '{}'::jsonb, 'authenticated', 'authenticated'),
    (gen_random_uuid(), 'otracuenta@ejemplo.test', '{}'::jsonb, 'authenticated', 'authenticated');

  select id into v_owner from auth.users where email = 'dueno@ejemplo.test';
  select id into v_manager from auth.users where email = 'encargado@ejemplo.test';
  select id into v_invitee from auth.users where email = 'invitada@ejemplo.test';
  select id into v_other from auth.users where email = 'otracuenta@ejemplo.test';

  perform tests.inv_act_as(v_owner);
  select (r ->> 'organization_id')::uuid into v_org
  from public.create_organization_with_business_unit(
    'Granja de invitaciones', 'AVICOLA', 'Aviícola de prueba', 'broilers'
  ) as r;

  insert into core.organization_members (organization_id, user_id, role_code)
  values (v_org, v_manager, 'manager');

  -- Dos invitaciones pendientes: una con rol `operator` y otra con `viewer`.
  perform public.create_organization_invitation('invitada@ejemplo.test', 'operator');
  perform public.create_organization_invitation('observador@ejemplo.test', 'viewer');

  insert into tests.inv (key, value) values
    ('owner', v_owner),
    ('manager', v_manager),
    ('invitee', v_invitee),
    ('other', v_other),
    ('org', v_org)
  on conflict (key) do update set value = excluded.value;

  insert into tests.inv_token (email, token)
  select email, token from core.organization_invitations
  on conflict (email) do update set token = excluded.token;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-2. El token: entropía y unicidad
-- ─────────────────────────────────────────────────────────────────────────────

set local role authenticated;
select tests.inv_act_as(tests.inv_id('owner'));

select is(
  (select char_length(token) from core.organization_invitations where email = 'invitada@ejemplo.test'),
  64,
  'el token son 32 bytes en hexadecimal: no es adivinable'
);

select is(
  (select count(distinct token) from core.organization_invitations),
  2::bigint,
  'dos invitaciones nunca comparten token'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3-4. Solo quien administra miembros puede invitar ni ver las invitaciones
-- ─────────────────────────────────────────────────────────────────────────────

select tests.inv_act_as(tests.inv_id('manager'));

select throws_ok(
  $$ select public.create_organization_invitation('intruso@ejemplo.test', 'viewer') $$,
  '42501',
  'Permiso requerido: org.members.manage',
  'un encargado no puede invitar: no administra miembros'
);

select is(
  (select count(*) from core.organization_invitations),
  0::bigint,
  'y tampoco puede leer los tokens de la organización, aunque sea miembro de ella'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. La propiedad no se importa por invitación
-- ─────────────────────────────────────────────────────────────────────────────

select tests.inv_act_as(tests.inv_id('owner'));

select throws_ok(
  $$ select public.create_organization_invitation('nuevo@ejemplo.test', 'owner') $$,
  '22023',
  'La propiedad no se transfiere por invitación; usa el proceso de transferencia',
  'ninguna invitación puede crear un segundo dueño'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Sin sesión no se acepta nada
-- ─────────────────────────────────────────────────────────────────────────────

select set_config('request.jwt.claims', '', true);

select throws_ok(
  $$ select public.accept_organization_invitation(
       tests.inv_token_of('invitada@ejemplo.test')
     ) $$,
  '28000',
  'Se requiere una sesión activa',
  'aceptar exige una sesión, aunque se conozca el token'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. El token se ata al correo, no a quien lo tenga
--
-- Es el caso real del token robado o reenviado por error: la cuenta equivocada
-- lo abre y la función se niega. Sin esto, Bastaría con que el enlace llegara
-- al correo equivocado para regalar la organización.
-- ─────────────────────────────────────────────────────────────────────────────

select tests.inv_act_as(tests.inv_id('other'));

select throws_ok(
  $$ select public.accept_organization_invitation(
       tests.inv_token_of('invitada@ejemplo.test')
     ) $$,
  '42501',
  null,
  'un token reenviado por error no da la organización a otra cuenta'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8-10. El camino feliz: entra con el rol prometido, ni uno más
-- ─────────────────────────────────────────────────────────────────────────────

select tests.inv_act_as(tests.inv_id('invitee'));

select is(
  (select role_code from core.organization_members where user_id = tests.inv_id('invitee')),
  'operator',
  'la invitada entra con el rol que decía la invitación'
);

select is(
  (select is_active from core.organization_members where user_id = tests.inv_id('invitee')),
  true,
  'la membresía queda activa'
);

-- El rol llega JUSTO donde debía. El rol «operator» puede leer mucho, pero
-- no ver la utilidad consolidada: si el token concediera un permiso de más,
-- esta sería la aserción que lo detectaría.
select is(
  (select private.has_permission('finance.profit.read')),
  false,
  'la invitada no hereda permisos que no le corresponden'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. El token es de un solo uso
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  $$ select public.accept_organization_invitation(
       tests.inv_token_of('invitada@ejemplo.test')
     ) $$,
  '22023',
  'La invitación ya no está disponible',
  'aceptar dos veces con el mismo token falla en vez de fingir que fue la primera'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 12-16. La organización ve su propio historial de invitaciones
-- ─────────────────────────────────────────────────────────────────────────────

select tests.inv_act_as(tests.inv_id('owner'));

select is(
  (select status from core.organization_invitations where email = 'invitada@ejemplo.test'),
  'accepted',
  'la invitación queda marcada como aceptada'
);

select is(
  (select accepted_by from core.organization_invitations where email = 'invitada@ejemplo.test'),
  tests.inv_id('invitee'),
  'y se guarda QUIÉN la aceptó, no solo que se aceptó'
);

select is(
  (select count(*) from core.organization_members where user_id = tests.inv_id('invitee')),
  1::bigint,
  'aceptar no duplicó la membresía'
);

select is(
  (select count(*)
   from core.audit_log
   where action = 'organization.invitation_accepted'),
  1::bigint,
  'el alta por invitación quedó auditada'
);

select is(
  (select status from core.organization_invitations where email = 'observador@ejemplo.test'),
  'pending',
  'la otra invitación sigue pendiente: aceptar una no arrastra a la otra'
);

select * from finish();
rollback;
