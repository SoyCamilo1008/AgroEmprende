-- description: Crea las funciones de onboarding y de invitación, transaccionales e idempotentes.
-- depends_on: 20260928120000_create_core_partners.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Onboarding
--
-- docs/architecture/auth.md: "el primer usuario que se registra crea su propia
-- organización. No hay proceso de aprobación ni administrador global".
--
-- Por eso el alta es una FUNCIÓN, no un `insert()` del cliente: la organización,
-- la membresía de `owner` y la primera unidad de negocio tienen que existir
-- juntos o no existir. Con tres `insert()` sueltos, un fallo a la mitad deja una
-- organización sin dueño, que es un usuario que no puede hacer nada y no puede
-- arreglarlo.
--
-- Se expone en `public` porque es lo que el cliente llama con `rpc()`. Las
-- tablas quedan en `core`, que también está expuesta pero solo para CRUD
-- controlado por RLS.
--
-- `SECURITY DEFINER` + `set search_path = ''`: sin search_path fijo, un
-- atacante que controla el search_path podría ejecutar su propia función
-- como el dueño. Todas las referencias van calificadas.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_organization_with_business_unit(
  p_name text,
  p_business_unit_code text default null,
  p_business_unit_name text default null,
  p_business_unit_type text default null,
  p_timezone text default 'America/Bogota',
  p_tax_id text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_organization_id uuid;
  v_business_unit_id uuid;
  v_existing_id uuid;
  v_request_id text := gen_random_uuid()::text;
begin
  -- Sin sesión no hay `created_by` válido. La tabla lo exigiría con un error
  -- de FK poco claro; aquí el mensaje dice la causa.
  if v_user_id is null then
    raise exception 'Se requiere una sesión activa para crear la organización'
      using errcode = '28000';
  end if;

  if p_name is null or char_length(btrim(p_name)) < 2 then
    raise exception 'El nombre de la organización es obligatorio'
      using errcode = '22023';
  end if;

  -- Idempotencia 1: la misma llave del mismo usuario devuelve lo ya creado.
  -- Es lo que evita el doble toque en móvil con mala señal.
  if p_idempotency_key is not null then
    select o.id into v_existing_id
    from core.organizations o
    where o.created_by = v_user_id
      and o.idempotency_key = p_idempotency_key;

    if found then
      select bu.id into v_business_unit_id
      from core.business_units bu
      where bu.organization_id = v_existing_id
        and bu.deleted_at is null
      order by bu.created_at
      limit 1;

      return jsonb_build_object(
        'organization_id', v_existing_id,
        'business_unit_id', v_business_unit_id,
        'created', false
      );
    end if;
  end if;

  -- Idempotencia 2: sin llave, si el usuario YA CREÓ una organización, esa es
  -- la suya. Volver a "crear" no duplica ni adivina.
  --
  -- Se pregunta por `created_by` y no por "tener cualquier membresía": ser
  -- miembro de la organización de otro no es tener una organización propia. Si
  -- se mirara la primera membresía activa, un viewer invitado a la granja de
  -- otro recibiría esa granja como si fuera suya y no podría crear la suya.
  select o.id into v_existing_id
  from core.organizations o
  where o.created_by = v_user_id
  order by o.created_at
  limit 1;

  if found then
    select bu.id into v_business_unit_id
    from core.business_units bu
    where bu.organization_id = v_existing_id
      and bu.deleted_at is null
    order by bu.created_at
    limit 1;

    return jsonb_build_object(
      'organization_id', v_existing_id,
      'business_unit_id', v_business_unit_id,
      'created', false
    );
  end if;

  insert into core.organizations (
    name,
    tax_id,
    timezone,
    created_by,
    idempotency_key
  )
  values (
    btrim(p_name),
    nullif(btrim(coalesce(p_tax_id, '')), ''),
    coalesce(nullif(btrim(coalesce(p_timezone, '')), ''), 'America/Bogota'),
    v_user_id,
    p_idempotency_key
  )
  returning id into v_organization_id;

  insert into core.organization_members (
    organization_id,
    user_id,
    role_code,
    is_active
  )
  values (
    v_organization_id,
    v_user_id,
    'owner',
    true
  );

  -- Plan de cuentas base copiado de la plantilla del sistema.
  --
  -- `parent_template_code` es una FK a `core.account_templates`, no a
  -- `core.accounts`, así que el id del padre no existe todavía: se resuelve en
  -- dos pasadas (primero las sin padre, después las que sí lo tienen) en vez de
  -- con un `WITH RECURSIVE`, que para dos niveles es más difícil de leer que
  -- dos sentencias y podría entrar en recursión infinita si la plantilla
  -- llegara a tener un ciclo.
  insert into core.accounts (organization_id, code, name, type, is_system)
  select v_organization_id, t.code, t.name, t.type, true
  from core.account_templates t
  where t.parent_template_code is null
  on conflict (organization_id, code) do nothing;

  insert into core.accounts (organization_id, code, name, type, parent_id, is_system)
  select v_organization_id, t.code, t.name, t.type, parent.id, true
  from core.account_templates t
  join core.accounts parent
    on parent.organization_id = v_organization_id
   and parent.code = t.parent_template_code
  where t.parent_template_code is not null
  on conflict (organization_id, code) do nothing;

  -- La unidad es opcional: hay quien carga los lotes primero y nombra las
  -- granjas después. `other` como tipo por defecto NO es un dato inventado
  -- sobre la granja: es "todavía no la clasificamos", y se corrige después.
  if p_business_unit_code is not null and btrim(p_business_unit_code) <> '' then
    insert into core.business_units (
      organization_id,
      code,
      name,
      type
    )
    values (
      v_organization_id,
    upper(btrim(p_business_unit_code)),
      coalesce(nullif(btrim(coalesce(p_business_unit_name, '')), ''), upper(btrim(p_business_unit_code))),
      coalesce(nullif(btrim(coalesce(p_business_unit_type, '')), ''), 'other')
    )
    returning id into v_business_unit_id;
  end if;

  -- El `organization_id` explícito: en este punto la membresía todavía no es
  -- visible para el contexto de RLS del propio usuario que acaba de crearla.
  insert into core.audit_log (
    organization_id,
    actor_id,
    action,
    entity_type,
    entity_id,
    new_values,
    request_id
  )
  values (
    v_organization_id,
    v_user_id,
    'organization.created',
    'core.organizations',
    v_organization_id,
    jsonb_build_object('name', btrim(p_name), 'timezone', coalesce(p_timezone, 'America/Bogota')),
    v_request_id
  );

  return jsonb_build_object(
    'organization_id', v_organization_id,
    'business_unit_id', v_business_unit_id,
    'created', true
  );
end;
$$;

comment on function public.create_organization_with_business_unit(text, text, text, text, text, text, uuid) is
  'Alta de organización: crea organización + membresía owner + primera unidad en una transacción. Idempotente.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Invitaciones
--
-- Cómo entra un segundo usuario a una organización. Fase 2 no envía correo
-- (no hay proveedor de email configurado): la función devuelve el TOKEN para
-- que el invitante comparta el enlace. Un token de una invitación es una
-- credencial, así que se guarda con entropía criptográfica y caduca.
-- ─────────────────────────────────────────────────────────────────────────────

create table core.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  -- Se guarda en minúsculas para comparar sin depender de la collation.
  email text not null check (
    email = lower(btrim(email))
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  role_code text not null references core.roles (code) on delete restrict,
  -- 32 bytes en hex: 256 bits de entropía, no un `random()` adivinable.
  token text not null unique check (char_length(token) = 64),
  status text not null default 'pending' check (
    status in ('pending', 'accepted', 'revoked', 'expired')
  ),
  invited_by uuid not null references auth.users (id) on delete restrict,
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  -- Siete días: una invitación que nadie acepta en una semana ya no describe lo
  -- que el usuario quiere hoy.
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

-- Una invitación pendiente por correo y organización: reenviar reutiliza la fila.
create unique index organization_invitations_one_pending
  on core.organization_invitations (organization_id, email)
  where status = 'pending';

create index organization_invitations_token on core.organization_invitations (token);

comment on table core.organization_invitations is
  'Invitaciones pendientes y su historial. El token es una credencial: caduca y no se reutiliza.';

alter table core.organization_invitations enable row level security;

create policy organization_invitations_select on core.organization_invitations
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('org.members.manage'))
  );

-- INSERT y UPDATE los hace la función de abajo, no el cliente: el token tiene
-- que generarse con entropía criptográfica y no se acepta un token del cuerpo.

create or replace function public.create_organization_invitation(
  p_email text,
  p_role_code text default 'viewer'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_organization_id uuid := (select private.current_organization_id());
  v_token text;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'Se requiere una sesión activa' using errcode = '28000';
  end if;

  -- Antes de `assert_permission`, no después: sin contexto el permiso se ve
  -- falso y el error sería "Permiso requerido", que manda a buscar un problema
  -- de rol donde el problema es que la petición no dijo de qué organización
  -- se trata.
  if v_organization_id is null then
    raise exception 'No hay organización activa: el usuario pertenece a varias y la petición no indica cuál'
      using errcode = '22023';
  end if;

  perform private.assert_permission('org.members.manage');

  if p_email is null or btrim(p_email) = '' then
    raise exception 'El correo de la invitación es obligatorio' using errcode = '22023';
  end if;

  if p_role_code is null or not exists (
    select 1 from core.roles r where r.code = p_role_code
  ) then
    raise exception 'Rol desconocido: %', p_role_code using errcode = '22023';
  end if;

  -- Invitar a `owner` chocaría con organization_members_one_active_owner y
  -- ademásaría la propiedad por el enlace equivocado. La transferencia de
  -- propiedad es un proceso explícito, no una invitación más.
  if p_role_code = 'owner' then
    raise exception 'La propiedad no se transfiere por invitación; usa el proceso de transferencia'
      using errcode = '22023';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into core.organization_invitations (
    organization_id,
    email,
    role_code,
    token,
    invited_by
  )
  values (
    v_organization_id,
    lower(btrim(p_email)),
    p_role_code,
    v_token,
    v_user_id
  )
  on conflict (organization_id, email) where status = 'pending'
  do update set token = excluded.token, role_code = excluded.role_code,
                invited_by = excluded.invited_by, expires_at = now() + interval '7 days'
  returning id, token into v_id, v_token;

  return jsonb_build_object(
    'invitation_id', v_id,
    'email', lower(btrim(p_email)),
    'role_code', p_role_code,
    'token', v_token
  );
end;
$$;

comment on function public.create_organization_invitation(text, text) is
  'Crea o renueva una invitación y devuelve su token. Requiere org.members.manage. No envía correo.';

create or replace function public.accept_organization_invitation(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_invitation core.organization_invitations;
  v_email text;
begin
  if v_user_id is null then
    raise exception 'Se requiere una sesión activa' using errcode = '28000';
  end if;

  -- Esta lectura depende de que la función sea SECURITY DEFINER: al aceptar,
  -- el usuario AÚN NO es miembro de la organización, así que
  -- `private.current_organization_id()` devuelve NULL y la política de
  -- `core.organization_invitations` le ocultaría la fila. Al ejecutarse como
  -- el dueño (postgres, que no está sujeto a RLS) la encuentra. Si algún día
  -- alguien aplica `FORCE ROW LEVEL SECURITY` a esa tabla, esta función deja de
  -- encontrar invitaciones: hay que revisarla en el mismo PR.
  select * into v_invitation
  from core.organization_invitations i
  where i.token = p_token
  for update;

  if not found then
    raise exception 'Invitación no encontrada' using errcode = 'P0002';
  end if;

  if v_invitation.status <> 'pending' then
    raise exception 'La invitación ya no está disponible' using errcode = '22023';
  end if;

  if v_invitation.expires_at <= now() then
    update core.organization_invitations
    set status = 'expired'
    where id = v_invitation.id;

    raise exception 'La invitación expiró' using errcode = '22023';
  end if;

  -- El token se acepta solo si el correo de la cuenta coincide. Un token
  -- reenviado por error no debe darle la organización a otra persona.
  select u.email into v_email
  from auth.users u
  where u.id = v_user_id;

  if v_email is null or lower(v_email) <> v_invitation.email then
    raise exception 'La invitación es para otro correo (%, esta cuenta es %)',
      v_invitation.email, coalesce(v_email, 'desconocido')
      using errcode = '42501';
  end if;

  -- El token es de UN SOLO USO. Aceptarlo dos veces falla con un mensaje claro
  -- (la comprobación de `status` de arriba) en vez de devolver éxito: quien llega
  -- con un token ya usado no es la persona invitada, y responderle "ok" lo haría
  -- creer que sí lo es.
  --
  -- El `on conflict` de abajo no es para eso. Cubre la REINVITACIÓN: a alguien
  -- que se desactivó y vuelve a invitarse, la fila de membresía existe y hay que
  -- reactivarla con el rol nuevo en vez de chocar con la restricción.
  insert into core.organization_members (
    organization_id,
    user_id,
    role_code,
    is_active,
    invited_by
  )
  values (
    v_invitation.organization_id,
    v_user_id,
    v_invitation.role_code,
    true,
    v_invitation.invited_by
  )
  on conflict (organization_id, user_id) do update
    set role_code = excluded.role_code,
        is_active = true,
        updated_at = now();

  update core.organization_invitations
  set status = 'accepted',
      accepted_by = v_user_id,
      accepted_at = now()
  where id = v_invitation.id;

  insert into core.audit_log (
    organization_id,
    actor_id,
    action,
    entity_type,
    entity_id,
    new_values
  )
  values (
    v_invitation.organization_id,
    v_user_id,
    'organization.invitation_accepted',
    'core.organization_members',
    v_user_id,
    jsonb_build_object('role_code', v_invitation.role_code)
  );

  return jsonb_build_object(
    'organization_id', v_invitation.organization_id,
    'role_code', v_invitation.role_code
  );
end;
$$;

comment on function public.accept_organization_invitation(text) is
  'Acepta una invitación de un solo uso y solo si el correo de la cuenta coincide con el invitado. Repetirla con el mismo token falla con 22023.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos SQL
--
-- Las funciones se conceden solo a `authenticated`: son de escritura y no
-- tienen sentido sin sesión. Se les quita el acceso a PUBLIC (el default de
-- Postgres es EJECUTAR para todos) antes de conceder.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on function public.create_organization_with_business_unit(text, text, text, text, text, text, uuid) from public;
revoke all on function public.create_organization_invitation(text, text) from public;
revoke all on function public.accept_organization_invitation(text) from public;

grant execute on function public.create_organization_with_business_unit(text, text, text, text, text, text, uuid) to authenticated;
grant execute on function public.create_organization_invitation(text, text) to authenticated;
grant execute on function public.accept_organization_invitation(text) to authenticated;

-- Solo la tabla de ESTA migración (ver el motivo en la migración de
-- business_units): un revoke global destruiría TODOS los permisos de las
-- migraciones anteriores. Esta es la última migración, así que el error sería
-- silencioso e irreversible para el resto del esquema.
revoke all on core.organization_invitations from anon, authenticated;

grant usage on schema core to authenticated;
grant select on core.organization_invitations to authenticated;
