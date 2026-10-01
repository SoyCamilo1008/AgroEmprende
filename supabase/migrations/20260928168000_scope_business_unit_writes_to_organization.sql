-- Endurece private.can_write_business_unit: la pertenencia a la organización no
-- basta, la unidad tiene que ser DE ESA organización.
--
-- El fallo: la función solo miraba `core.organization_members`. Para un usuario
-- con membresía en la organización activa, la rama "sin alcance explícito" se
-- cumplía siempre, sin comprobar jamás que `p_business_unit_id` perteneciera a
-- esa organización. El alcance por `member_business_units` sí comparaba la
-- unidad, así que solo la ruta sin acotar era la puerta abierta.
--
-- Consecuencia real: un miembro de org_b con `finance.sales.create` podía pasar
-- el id de una unidad de org_a y esa comprobación devolvía true. Las escrituras
-- siguientes siguen tenant de su propia org (`organization_id` activo, RLS,
-- y el propio `create_sale` valida que el cliente pertenezca a la organización
-- activa), así que no se colaba información ajena, pero la función de
-- autorización estaba mintiendo sobre lo que autorizaba. La 22023 posterior
-- sobre el cliente hacía de red de seguridad, no de control de acceso.
--
-- Esta corrección cierra la autorización en la capa que le corresponde, para que
-- el permiso sobre la unidad sea un límite real y no una formalidad.
create or replace function private.can_write_business_unit(p_business_unit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from core.business_units bu
    where bu.id = p_business_unit_id
      and bu.organization_id = (select private.current_organization_id())
      and bu.is_active
      and bu.deleted_at is null
  )
  and exists (
    select 1
    from core.organization_members m
    where m.user_id = (select auth.uid())
      and m.is_active
      and m.organization_id = (select private.current_organization_id())
      and (
        not exists (
          select 1
          from core.member_business_units mbu
          where mbu.organization_id = m.organization_id
            and mbu.user_id = m.user_id
        )
        or exists (
          select 1
          from core.member_business_units mbu
          where mbu.organization_id = m.organization_id
            and mbu.user_id = m.user_id
            and mbu.business_unit_id = p_business_unit_id
        )
      )
  )
$$;

comment on function private.can_write_business_unit(uuid) is
  'true si el usuario puede escribir en la unidad: la unidad debe ser de la organización activa y el usuario debe tener alcance sobre ella. El alcance explícito acota; sin filas, no acota.';