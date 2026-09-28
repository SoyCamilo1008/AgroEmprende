-- description: Garantiza que toda organización tenga exactamente un propietario activo y expone su transferencia.
-- depends_on: 20260928130000_create_onboarding_and_invitations.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Propiedad de la organización
--
-- Regla: toda organización tiene EXACTAMENTE un `owner` activo.
--
-- Antes de esta migración el índice `organization_members_one_active_owner`
-- cubría la mitad fácil del problema: como máximo un owner. La otra mitad —que
-- exista al menos uno— no la cubría nadie, y `organization_members_update`
-- llegaba hasta ella: un `admin` podía degradar o desactivar al único
-- propietario y dejar una organización sin dueño, que es el peor estado
-- posible porque no se puede recuperar desde la propia base de datos.
--
-- "Como máximo uno" y "al menos uno" necesitan herramientas distintas, y por eso
-- están separadas:
--
--   · COMO MÁXIMO → índice único parcial. Es lo único que un índice puede decir.
--   · AL MENOS UNO → trigger de restricción DIFERIDO. No hay forma declarativa
--     de decir "en cada organización hay un owner": un CHECK solo ve su fila, y
--     una FK no puede apuntar a "una fila que exista entre varias".
--
-- El diferido es lo que hace que la transferencia sea posible: en una
-- transacción, "el viejo deja de ser owner" y "el nuevo lo es" se escriben
-- juntos y solo se comprueba al final, cuando la cuenta cuadra. Con el trigger
-- inmediato, ninguna de las dos mitades por separado sería válida.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- La invariante
--
-- `SECURITY DEFINER` a propósito: el trigger corre en nombre de quien escribe,
-- y un `admin` que degrada al owner solo ve una fila de `organization_members`
-- (la suya). Contar con los ojos de ese rol daría 0 y levantaría un error que
-- no es cierto. Contando como el dueño del esquema, la cuenta es la real.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.assert_organization_has_one_active_owner(
  p_organization_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_active_owners integer;
begin
  if p_organization_id is null then
    return;
  end if;

  -- La organización ya no está: se borró en cascada y sus membresías con ella.
  -- La invariante termina con ella, no se viola.
  if not exists (
    select 1 from core.organizations o where o.id = p_organization_id
  ) then
    return;
  end if;

  select count(*)::integer into v_active_owners
  from core.organization_members m
  where m.organization_id = p_organization_id
    and m.is_active
    and m.role_code = 'owner';

  if v_active_owners <> 1 then
    raise exception
      'La organización debe tener exactamente un propietario activo y tiene %',
      v_active_owners
      using errcode = '23514',
            hint = 'Transfiere la propiedad con transfer_organization_ownership().';
  end if;
end;
$$;

comment on function private.assert_organization_has_one_active_owner(uuid) is
  'Falla si la organización no tiene exactamente un owner activo. Corre como el dueño del esquema para no contar con el RLS de quien escribe.';

-- Membresías: cualquier alta, cambio o baja puede mover la cuenta de owners.
create or replace function private.check_member_owner_invariant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.assert_organization_has_one_active_owner(new.organization_id);
  elsif tg_op = 'DELETE' then
    perform private.assert_organization_has_one_active_owner(old.organization_id);
  else
    perform private.assert_organization_has_one_active_owner(new.organization_id);

    -- Mudar una membresía de organización deja a la de origen sin su dueño
    -- aunque la de destino esté bien.
    if old.organization_id is distinct from new.organization_id then
      perform private.assert_organization_has_one_active_owner(old.organization_id);
    end if;
  end if;

  return null;
end;
$$;

-- Organizaciones: una organización recién creada todavía no tiene membresías,
-- pero el diferido hace que la cuenta se compruebe cuando ya las tiene. Sin este
-- trigger, `insert into core.organizations` a pelo dejaría una organización sin
-- dueño y ninguna otra comprobación lo vería.
create or replace function private.check_organization_owner_invariant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.assert_organization_has_one_active_owner(new.id);
  return null;
end;
$$;

create constraint trigger organization_members_one_active_owner_invariant
  after insert or update or delete on core.organization_members
  deferrable initially deferred
  for each row execute function private.check_member_owner_invariant();

create constraint trigger organizations_one_active_owner_invariant
  after insert on core.organizations
  deferrable initially deferred
  for each row execute function private.check_organization_owner_invariant();

comment on constraint organization_members_one_active_owner_invariant
  on core.organization_members is
  'Al finalizar la transacción, la organización debe tener exactamente un owner activo. Se comprueba diferida para que la transferencia pueda escribir los dos lados a la vez.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Transferencia de propiedad
--
-- Es la única operación que cambia quién es el dueño, y es transaccional por
-- construcción: si algo falla a mitad, la transacción entera se deshace y la
-- organización se queda con su propietario de antes.
--
-- Solo el propietario actual puede transferir. Un `admin` que pudiera hacerlo
-- podría nombrarse a sí mismo propietario, y la regla de "exactamente un
-- owner" no lo impide: lo impediría, pero para cuando ya es tarde.
--
-- El que deja de ser owner pasa a `admin`, que en esta fase tiene los mismos
-- permisos que `owner` (docs/architecture/auth.md): perder la propiedad no
-- significa perder el acceso a la granja.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.transfer_organization_ownership(
  p_organization_id uuid,
  p_new_owner_id uuid,
  p_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_previous_owner_id uuid;
begin
  if v_user_id is null then
    raise exception 'Se requiere una sesión activa' using errcode = '28000';
  end if;

  if p_organization_id is null or p_new_owner_id is null then
    raise exception 'La organización y el nuevo propietario son obligatorios'
      using errcode = '22023';
  end if;

  -- Bloquear la fila de la organización serializa dos transferencias
  -- simultáneas. Sin esto, los dos dueños en turno podrían pasar a la vez la
  -- comprobación de "sigo siendo el propietario" y el segundo UPDATE se
  -- encontraría con el primero ya aplicado.
  perform 1
  from core.organizations o
  where o.id = p_organization_id
  for update;

  if not found then
    raise exception 'La organización no existe' using errcode = 'P0002';
  end if;

  select m.user_id into v_previous_owner_id
  from core.organization_members m
  where m.organization_id = p_organization_id
    and m.role_code = 'owner'
    and m.is_active;

  if v_previous_owner_id is null or v_previous_owner_id <> v_user_id then
    raise exception 'Solo el propietario actual puede transferir la propiedad'
      using errcode = '42501';
  end if;

  if p_new_owner_id = v_user_id then
    raise exception 'El usuario indicado ya es el propietario'
      using errcode = '22023';
  end if;

  -- Tres fallos distintos y no un "usuario inválido": no existe la cuenta, no
  -- pertenece a esta organización, o está dado de baja. El primero es un id
  -- mal escrito; el segundo es alguien de otra granja; el tercero es un
  -- propietario que se desactivó y hay que reactivar antes de transferirle.
  if not exists (select 1 from auth.users u where u.id = p_new_owner_id) then
    raise exception 'El usuario indicado no existe' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from core.organization_members m
    where m.organization_id = p_organization_id
      and m.user_id = p_new_owner_id
  ) then
    raise exception 'El usuario indicado no pertenece a la organización'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from core.organization_members m
    where m.organization_id = p_organization_id
      and m.user_id = p_new_owner_id
      and m.is_active
  ) then
    raise exception 'El usuario indicado está inactivo en la organización'
      using errcode = '22023';
  end if;

  -- El orden no es decoración: `organization_members_one_active_owner` es un
  -- índice único y los índices únicos no son diferibles, así que promover antes
  -- de degradar daría violación de unicidad a mitad de la transferencia.
  update core.organization_members
  set role_code = 'admin', updated_at = now()
  where organization_id = p_organization_id
    and user_id = v_previous_owner_id
    and role_code = 'owner';

  update core.organization_members
  set role_code = 'owner', updated_at = now()
  where organization_id = p_organization_id
    and user_id = p_new_owner_id;

  insert into core.audit_log (
    organization_id,
    actor_id,
    action,
    entity_type,
    entity_id,
    old_values,
    new_values,
    request_id
  )
  values (
    p_organization_id,
    v_user_id,
    'organization.ownership_transferred',
    'core.organizations',
    p_organization_id,
    jsonb_build_object(
      'owner_id', v_previous_owner_id,
      'owner_role', 'owner'
    ),
    jsonb_build_object(
      'owner_id', p_new_owner_id,
      'owner_role', 'owner',
      'previous_owner_id', v_previous_owner_id,
      'previous_owner_role', 'admin'
    ),
    p_request_id
  );

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'previous_owner_id', v_previous_owner_id,
    'new_owner_id', p_new_owner_id
  );
end;
$$;

comment on function public.transfer_organization_ownership(uuid, uuid, text) is
  'Transfiere la propiedad de una organización al miembro activo indicado. Solo el propietario actual puede llamarla, y es atómica: o se transfiere entera o no se transfiere.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos SQL
--
-- Como las otras funciones de `public`: solo `authenticated`, y sin sesión no
-- hay nada que transferir. No concede ningún permiso de tabla, porque la
-- transferencia no necesita tocar las membresías del cliente.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on function public.transfer_organization_ownership(uuid, uuid, text) from public;

grant execute on function public.transfer_organization_ownership(uuid, uuid, text) to authenticated;
