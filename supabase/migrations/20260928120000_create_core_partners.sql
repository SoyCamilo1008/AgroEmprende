-- description: Crea clientes, contactos y proveedores, con su RLS por organización.
-- depends_on: 20260928110000_create_core_accounts_and_parameters.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Clientes y proveedores
--
-- Un cliente es GLOBAL para la organización y la unidad de negocio vive en las
-- líneas del movimiento (ADR-0004). Por eso estas tablas NO tienen
-- `business_unit_id`: un cliente que compra huevos y carne es el mismo cliente,
-- y duplicarlo por unidad partaría su saldo en dos.
--
-- No hay columna de saldo aquí. El saldo es la suma de cuentas por cobrar
-- (ADR-0003) y se calcula, no se guarda.
--
-- Todo el contacto es opcional salvo el nombre: no se inventa un teléfono ni un
-- NIT para poder filtrar una tabla (ADR-0011).
-- ─────────────────────────────────────────────────────────────────────────────

create table core.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  -- Código interno de la granja. Opcional: no todas las granjas codifican a sus
  -- clientes, y exigirlo solo para llenar la tabla no aporta nada.
  code text check (code is null or code ~ '^[A-Z0-9_-]{2,32}$'),
  name text not null check (char_length(btrim(name)) between 2 and 160),
  tax_id text check (tax_id is null or tax_id ~ '^[0-9]{6,15}$'),
  email text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone text check (phone is null or char_length(btrim(phone)) between 7 and 32),
  address text,
  -- Días de crédito acordados. NULL = "no sabemos" (todavía no hay acuerdo, o
  -- se paga de contado). No se rellena con 30 por defecto: 30 días es un dato
  -- comercial, y ponerlo cambia la cartera sin que nadie lo haya decidido.
  credit_days integer check (credit_days is null or credit_days between 0 and 365),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index customers_organization_code
  on core.customers (organization_id, code)
  where code is not null;

create index customers_organization on core.customers (organization_id);

-- Búsqueda por nombre: el cliente se busca por lo que el usuario teclea, no por
-- un id. `unaccent` no se usa porque requiere la extensión y el patrón
--ICU varies por plataforma; en la v1 un `ILIKE` es suficiente.
create index customers_name_search on core.customers (organization_id, lower(name));

comment on table core.customers is
  'Cliente de la organización, global entre unidades. Su saldo se calcula de finance.receivables, no se guarda aquí.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Contactos
--
-- Un cliente puede tener un dueño de compra, un bodeguista y un pagador. Se
-- guardan aparte para no llenar el cliente de campos que casi siempre están vacíos.
-- ─────────────────────────────────────────────────────────────────────────────

create table core.customer_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  customer_id uuid not null references core.customers (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 160),
  -- Cargo o relación: "Dueño de compra", "Bodega". Texto libre, no un enum:
  -- cada granja lo llama de una forma y forzar un catálogo sería inventar.
  role text check (role is null or char_length(btrim(role)) between 2 and 80),
  email text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone text check (phone is null or char_length(btrim(phone)) between 7 and 32),
  is_primary boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index customer_contacts_customer on core.customer_contacts (customer_id);

-- Solo un contacto principal por cliente. `where is_primary` lo hace único
-- entre los que son principales, sin limitar a los secundarios.
create unique index customer_contacts_one_primary
  on core.customer_contacts (customer_id)
  where is_primary;

comment on table core.customer_contacts is
  'Personas de contacto del cliente. Nullables salvo el nombre: no se inventan datos de contacto.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Proveedores
--
-- Proveedores y clientes son tablas y no una tabla con un discriminator
-- porque se consultan distinto, se validejan distinto y los permisos difieren:
-- `customers.write` no debería permitir tocar la lista de proveedores.
-- ─────────────────────────────────────────────────────────────────────────────

create table core.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  code text check (code is null or code ~ '^[A-Z0-9_-]{2,32}$'),
  name text not null check (char_length(btrim(name)) between 2 and 160),
  tax_id text check (tax_id is null or tax_id ~ '^[0-9]{6,15}$'),
  email text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone text check (phone is null or char_length(btrim(phone)) between 7 and 32),
  address text,
  -- Categoría de lo que el proveedor vende, en las palabras de la granja. Texto
  -- libre a propósito: "alimento", "medicamentos", "pollito" cambian por región y
  -- forzar un catálogo cerrado es inventar la operación del cliente.
  category text check (category is null or char_length(btrim(category)) between 2 and 80),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index suppliers_organization_code
  on core.suppliers (organization_id, code)
  where code is not null;

create index suppliers_organization on core.suppliers (organization_id);
create index suppliers_name_search on core.suppliers (organization_id, lower(name));

comment on table core.suppliers is
  'Proveedor de la organización. Global entre unidades, como el cliente.';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
--
-- Clientes y contactos comparten permiso; los proveedores tienen los suyos.
-- Borrado lógico: `is_active` en vez de DELETE, porque un cliente con ventas
-- conciliadas no puede desaparecer de la historia.
-- ─────────────────────────────────────────────────────────────────────────────

alter table core.customers enable row level security;
alter table core.customer_contacts enable row level security;
alter table core.suppliers enable row level security;

create policy customers_select on core.customers
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('customers.read'))
  );

create policy customers_insert on core.customers
  for insert
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('customers.write'))
  );

create policy customers_update on core.customers
  for update
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('customers.write'))
  )
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('customers.write'))
  );

-- El contacto se filtra por SU organización, no por la del cliente: si el id
-- del cliente fuera de otra organización, esta política seguiría admitiendo un
-- contacto ajeno. El `exists` del INSERT y el UPDATE lo cierran.
create policy customer_contacts_select on core.customer_contacts
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('customers.read'))
  );

create policy customer_contacts_insert on core.customer_contacts
  for insert
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('customers.write'))
    and exists (
      select 1
      from core.customers c
      where c.id = customer_id
        and c.organization_id = (select private.current_organization_id())
    )
  );

create policy customer_contacts_update on core.customer_contacts
  for update
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('customers.write'))
  )
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('customers.write'))
    and exists (
      select 1
      from core.customers c
      where c.id = customer_id
        and c.organization_id = (select private.current_organization_id())
    )
  );

create policy suppliers_select on core.suppliers
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('suppliers.read'))
  );

create policy suppliers_insert on core.suppliers
  for insert
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('suppliers.write'))
  );

create policy suppliers_update on core.suppliers
  for update
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('suppliers.write'))
  )
  with check (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('suppliers.write'))
  );

create trigger customers_touch_updated_at
  before update on core.customers
  for each row execute function private.touch_updated_at();

create trigger customer_contacts_touch_updated_at
  before update on core.customer_contacts
  for each row execute function private.touch_updated_at();

create trigger suppliers_touch_updated_at
  before update on core.suppliers
  for each row execute function private.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos SQL
-- ─────────────────────────────────────────────────────────────────────────────

-- Solo las tablas de ESTA migración (ver el motivo en la migración de
-- business_units): un revoke global destruiría los permisos previos.
revoke all on core.customers, core.customer_contacts, core.suppliers
  from anon, authenticated;

grant usage on schema core to authenticated;

grant select, insert, update on core.customers to authenticated;
grant select, insert, update on core.customer_contacts to authenticated;
grant select, insert, update on core.suppliers to authenticated;
