-- description: La organizacion de clientes y contactos se deriva del contexto, no del formulario.
-- depends_on: 20260928170000_customers_audit_trail.sql

-- La organizacion del cliente la decide el contexto, no el formulario.
--
-- El problema que resuelve esta migracion
-- --------------------------------------
-- `core.customers.organization_id` es `NOT NULL` y no tiene valor por defecto,
-- asi que un INSERT directo tiene que mandarlo. La unica forma de que el
-- cliente de la app lo consiga es...
--
--   1. Preguntarselo al usuario. Es exactamente lo que esta migracion
--      prohibe: un `organizationId` que viene del formulario es un dato que el
--      cliente elige, y las politicas comparan contra
--      `private.current_organization_id()`. Mandarlo equivocado produce un
--      `42501` confuso; mandarlo a proposito produce lo mismo, porque RLS
--      corrige. Ninguna de las dos es una buena experiencia.
--
--   2. Exponer `private.current_organization_id()` en PostgREST para leerla y
--      mandarla de vuelta. Seria una lectura extra por cada alta y abriria una
--      via para que el cliente escriba una organizacion distinta de la que le
--      responde.
--
--   3. Que lo ponga el servidor. Esta es la que se aplica.
--
-- Que hace
-- --------
-- Un trigger `BEFORE INSERT` rellena `organization_id` cuando viene a NULL,
-- tomandolo de `private.current_organization_id()`. Si no hay contexto, falla
-- con un error que dice que falta contexto, no un "null value in column".
--
-- Lo que NO se hace aqui, a proposito
-- -----------------------------------
--
-- - NO se sobrescribe un `organization_id` que ya viene. Reteplen.
--   Las columnas del esquema se crean con un solo proveedor de contexto (el
--   script de arranque y las funciones de onboarding). Sobrescribir aqui haria
--   fallar esas cargas legitimas con un error que nadie entenderia.
--
-- - NO se toca ninguna politica ni se relaja ningun permiso. Esta migracion no
--   cambia QUIEN puede leer ni escribir clientes: solo deja de exigir al
--   cliente que adivine una columna.
--
-- - NO se anade `is_active` a los contactos ni se abre un `DELETE`. Si
--   `customer_contacts` no tiene esas columnas, es porque decidirlo es parte
--   del modelo, no de la capa de acceso.
--
-- Por que un trigger y no una funcion de negocio
-- ----------------------------------------------
-- Clientes y contactos se escriben por DML directo con permisos
-- `customers.write`, no por una funcion SECURITY DEFINER. Un trigger mantiene
-- ese camino y hace la invariante valida para TODO el que escriba, incluido un
-- `INSERT` hecho a mano desde un script. Una funcion solo la cumpliria quien la
-- llamara.

create or replace function private.derive_partner_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
begin
  -- Ya viene informado: no se toca. Ver la nota de arriba.
  if new.organization_id is not null then
    return new;
  end if;

  v_organization_id := private.current_organization_id();

  if v_organization_id is null then
    raise exception 'No hay organización activa: no se puede crear el registro'
      using errcode = '22023',
            hint = 'Inicia sesion y selecciona una organizacion antes de escribir.';
  end if;

  new.organization_id := v_organization_id;
  return new;
end;
$$;

comment on function private.derive_partner_organization() is
  'Rellena organization_id desde el contexto de la peticion cuando el INSERT lo omite. No sobrescribe un valor explicito.';

create trigger customers_derive_organization
  before insert on core.customers
  for each row
  execute function private.derive_partner_organization();

create trigger customer_contacts_derive_organization
  before insert on core.customer_contacts
  for each row
  execute function private.derive_partner_organization();
