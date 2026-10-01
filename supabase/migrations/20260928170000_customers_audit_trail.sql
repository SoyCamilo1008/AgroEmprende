-- description: Alta y edición de clientes y contactos quedan auditadas con quién las hizo y qué cambió.

-- ─────────────────────────────────────────────────────────────────────────────
-- Auditoría de clientes y contactos
--
-- `core.audit_log` es, por su comentario, "la explicación de un número". Las
-- ventas, los pagos, los gastos y las inversiones escriben ahí desde funciones
-- SECURITY DEFINER porque todas pasan por `create_sale`, `register_payment` y
-- compañía.
--
-- Los clientes no: `core.customers` y `core.customer_contacts` se escriben con
-- DML directo y sus políticas RLS solo filtran por organización y permiso. El
-- resultado era que el dato maestro más consultado de la aplicación no tenía
-- rastro de nada: nadie podía responder "¿quién cambió los días de crédito de
-- este cliente y cuándo?", que es justo la pregunta que aparece cuando una
-- cartera sale mal.
--
-- No se migra la escritura a funciones nuevas. Los permisos ya están resueltos y
-- probados por RLS, y para auditar no hace falta tocar el camino de escritura. Un
-- trigger AFTER cubre el DML directo y también cualquier RPC que se añada después,
-- que es el caso que importa.
--
-- `updated_at` se descarta explícitamente porque el trigger `touch_updated_at` lo
-- cambia en cada UPDATE: dejarlo convertiría cada auditoría de modificación en
-- "cambió updated_at", que es ruido.
--
-- Un INSERT registra la fila completa; un UPDATE registra SOLO los campos que de
-- verdad cambiaron, para que "qué le movieron a este cliente" se lea sin tener que
-- comparar dos jsonb a ojo.
--
-- A diferencia del caso sin actor —que `private.write_audit_log` ya descarta en
-- silencio— un fallo real al escribir la auditoría SÍ aborta la operación. El
-- trigger corre en la misma transacción que el cambio: si la auditoría no se
-- puede escribir, tampoco se guarda el cambio, y el usuario recibe un error y
-- reintenta. Perder el rastro en silencio sería peor que un error visible, porque
-- un cliente sin auditoría es indistinguible de uno que nunca se editó.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- Disparador genérico de auditoría de datos maestros
--
-- `p_entity_type` y el prefijo de la acción viajan en TG_ARGV porque el mismo
-- cuerpo sirve para clientes y contactos: lo que cambia entre las dos tablas son
-- las etiquetas, no la lógica.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.audit_master_data_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_field text;
  v_changed_old jsonb := '{}'::jsonb;
  v_changed_new jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    perform private.write_audit_log(
      (tg_argv[1] || '.insert'),
      tg_argv[0],
      new.id,
      null,
      to_jsonb(new) - 'updated_at'
    );

    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old) - 'updated_at';
    v_new := to_jsonb(new) - 'updated_at';

    -- Solo los campos cuyo valor difiere. Se recorren las claves de las dos filas
    -- para que un campo agregado también cuente como cambio.
    for v_field in
      select key from jsonb_object_keys(v_new) as key
      union
      select key from jsonb_object_keys(v_old) as key
    loop
      if v_old -> v_field is distinct from v_new -> v_field then
        if v_old ? v_field then
          v_changed_old := v_changed_old || jsonb_build_object(v_field, v_old -> v_field);
        end if;
        if v_new ? v_field then
          v_changed_new := v_changed_new || jsonb_build_object(v_field, v_new -> v_field);
        end if;
      end if;
    end loop;

    -- Guardar el formulario sin editar un solo campo no merece una entrada:
    -- llena el registro de ruido y entierra el cambio que sí importa.
    if v_changed_new = '{}'::jsonb and v_changed_old = '{}'::jsonb then
      return new;
    end if;

    perform private.write_audit_log(
      (tg_argv[1] || '.update'),
      tg_argv[0],
      new.id,
      v_changed_old,
      v_changed_new
    );
  end if;

  return new;
end;
$$;

comment on function private.audit_master_data_change() is
  'Audita el AFTER INSERT/UPDATE de datos maestros que se escriben por DML directo. Argumentos: entity_type, prefijo de la acción.';

create trigger customers_audit_change
  after insert or update on core.customers
  for each row execute function private.audit_master_data_change(
    'core.customers', 'customers'
  );

create trigger customer_contacts_audit_change
  after insert or update on core.customer_contacts
  for each row execute function private.audit_master_data_change(
    'core.customer_contacts', 'customer_contacts'
  );

-- `core.suppliers` tiene exactamente la misma forma y queda fuera de esta
-- migración a propósito: los proveedores son otro bloque y se auditan cuando se
-- construya su capa de datos.