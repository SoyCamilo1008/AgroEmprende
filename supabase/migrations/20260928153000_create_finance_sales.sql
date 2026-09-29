-- description: Ventas, items y cartera, con creacion y anulacion como funciones de negocio SECURITY DEFINER (ADR-0003).
-- depends_on: 20260928150000_create_finance_ledger.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Ventas (obligación comercial)
--
-- Una venta NO es un asiento: es el documento comercial (a quién, qué, cuánto,
-- vence cuándo). El asiento lo escribe `create_sale` en el momento de registrar
-- (sin borradores: una venta guardada está contabilizada). No hay columna de
-- estado: "postada", "anulada" y "cobrada" se DERIVAN de (a) la existencia de
-- la fila, (b) un contra-asiento de tipo 'reversal' y (c) los pagos aplicados
-- (ADR-0003). La cartera (receivables) es la columna de vencimientos; el pago
-- no disminuye la venta, aplica contra la cartera.
--
-- Impuestos: en la v1 el precio es el total y `tax` siempre es 0. El impuesto
-- real (retención, IVA) llega con la parametrización contable; el esquema ya
-- lo soporta.
-- ─────────────────────────────────────────────────────────────────────────────

-- El catálogo de productos (`core.products`) aún no existe en la Fase 3: el
-- inventario llega en su propia fase. Mientras tanto, la línea de venta guarda
-- el nombre libre del producto; el número y el precio ya quedan en su columna.
-- La FK de producto se suma cuando el catálogo exista.
--
-- Hasta aquí la referencia compuesta de `core.customers (organization_id, id)`:
-- `unique (organization_id, id)` no existía en Fase 2 (solo `unique (org, code)`),
-- así que esta migración lo agrega ANTES de declarar la FK de venta.

alter table core.customers add constraint customers_org_id_uq unique (organization_id, id);

create table finance.sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  business_unit_id uuid not null,
  invoice_number text not null,
  customer_id uuid not null,
  sale_date date not null,
  due_date date not null check (due_date >= sale_date),
  payment_method text not null check (
    payment_method in ('cash', 'bank_transfer', 'card', 'digital_wallet')
  ),
  subtotal numeric(18, 2) not null,
  tax numeric(18, 2) not null default 0 check (tax >= 0),
  total numeric(18, 2) not null check (total >= 0),
  description text check (description is null or char_length(btrim(description)) <= 400),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (total = round(subtotal + tax, 2)),
  unique (organization_id, invoice_number),
  -- Igual que customers/accounts/business_units: destino de las FK compuestas
  -- de items y cartera, para que una fila nunca quede colgada de otra granja.
  unique (organization_id, id),
  foreign key (organization_id, business_unit_id)
    references core.business_units (organization_id, id) on delete cascade,
  -- El cliente es GLOBAL de la organización (ADR-0004): las ventas se pueden
  -- filtrar por unidad, pero la cartera de un cliente cruza sus granjas.
  foreign key (organization_id, customer_id)
    references core.customers (organization_id, id) on delete restrict
);

-- Cartera por cobrar: la consulta diaria de vencimientos vive aquí.
create index sales_receivables_due on finance.sales (organization_id, due_date);
create index sales_period on finance.sales (organization_id, sale_date);

comment on table finance.sales is
  'Documento de venta. "Postada" se deriva de la existencia de la fila; "anulada", de un contra-asiento (ADR-0003).';

create table finance.sale_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  sale_id uuid not null references finance.sales (id) on delete cascade,
  -- Nombre libre del producto: el catálogo no existe todavía (ver nota arriba).
  product_name text not null check (char_length(btrim(product_name)) between 1 and 120),
  quantity numeric(18, 2) not null check (quantity > 0),
  unit_price numeric(18, 2) not null check (unit_price >= 0),
  line_total numeric(18, 2) not null check (line_total >= 0),
  foreign key (organization_id, sale_id)
    references finance.sales (organization_id, id) on delete cascade
);

create index sale_items_sale on finance.sale_items (sale_id);

comment on table finance.sale_items is
  'Líneas de la venta. `line_total = round(quantity * unit_price, 2)` se calcula al registrar y se guarda: el reporte no vuelve a multiplicar.';

create table finance.receivables (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  sale_id uuid not null,
  due_date date not null,
  original_amount numeric(18, 2) not null check (original_amount >= 0),
  -- Lo abonado. `paid_amount <= original_amount` hace imposible un saldo
  -- negativo por la puerta (ADR-0003): el exceso de un pago termina como saldo
  -- a favor (2210), no como "cartera negativa".
  paid_amount numeric(18, 2) not null default 0 check (paid_amount between 0 and original_amount),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  check ((paid_amount > 0) = (paid_at is not null)),
  unique (organization_id, sale_id),
  foreign key (organization_id, sale_id)
    references finance.sales (organization_id, id) on delete cascade
);

create index receivables_open on finance.receivables (organization_id, due_date) where paid_amount < original_amount;

comment on table finance.receivables is
  'Cartera: lo que un cliente debe y cuánto lleva pagado. `paid_amount` lo mueve `register_payment`, nunca el cliente.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Crear venta
--
-- Lo que no se negocia aquí: las líneas llegan calculadas del cliente (cantidad
-- y precio unitario), la suma la hace la base. Con la validación de unidad y de
-- permiso primero, el error que recibe el usuario es el suyo y no "la FK no
-- dejó escribir".
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_sale(
  p_business_unit_id uuid,
  p_customer_id uuid,
  p_sale_date date,
  p_due_date date,
  p_payment_method text,
  p_description text,
  p_items jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := (select private.current_organization_id());
  v_invoice_number text;
  v_sale_id uuid;
  v_item jsonb;
  v_subtotal numeric(18, 2) := 0;
  v_total numeric(18, 2);
begin
  if v_organization_id is null then
    raise exception 'No hay organización activa' using errcode = '22023';
  end if;

  perform private.assert_permission('finance.sales.create');

  if not private.can_write_business_unit(p_business_unit_id) then
    raise exception 'Permiso requerido' using errcode = '42501';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Una venta necesita al menos una línea' using errcode = '22023';
  end if;

  if p_due_date < p_sale_date then
    raise exception 'El vencimiento no puede ser anterior a la venta' using errcode = '22023';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'bank_transfer', 'card', 'digital_wallet') then
    raise exception 'Método de pago inválido' using errcode = '22023';
  end if;

  if not exists (
    select 1 from core.customers
    where organization_id = v_organization_id and id = p_customer_id
  ) then
    raise exception 'Cliente no encontrado en esta organización' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if coalesce(btrim(v_item ->> 'product_name'), '') = '' then
      raise exception 'Toda línea necesita el nombre del producto' using errcode = '22023';
    end if;
    if (v_item ->> 'quantity')::numeric <= 0 or (v_item ->> 'unit_price')::numeric < 0 then
      raise exception 'Cantidad y precio inválidos' using errcode = '22023';
    end if;
    v_subtotal := v_subtotal
      + round((v_item ->> 'quantity')::numeric * (v_item ->> 'unit_price')::numeric, 2);
  end loop;

  v_total := round(v_subtotal, 2);
  if v_total <= 0 then
    raise exception 'El total de la venta debe ser positivo' using errcode = '22023';
  end if;

  v_invoice_number := to_char(now(), 'YYYYMMDD') || '-' ||
    lpad((select coalesce(max(right(invoice_number, 6))::int, 0) + 1 from finance.sales where organization_id = v_organization_id)::text, 6, '0');

  insert into finance.sales (
    organization_id, business_unit_id, invoice_number, customer_id,
    sale_date, due_date, payment_method, subtotal, tax, total, description, created_by
  )
  values (
    v_organization_id, p_business_unit_id, v_invoice_number, p_customer_id,
    p_sale_date, p_due_date, p_payment_method, v_subtotal, 0, v_total, p_description,
    (select auth.uid())
  )
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into finance.sale_items (
      organization_id, sale_id, product_name, quantity, unit_price, line_total
    )
    values (
      v_organization_id, v_sale_id, v_item ->> 'product_name',
      (v_item ->> 'quantity')::numeric, (v_item ->> 'unit_price')::numeric,
      round((v_item ->> 'quantity')::numeric * (v_item ->> 'unit_price')::numeric, 2)
    );
  end loop;

  insert into finance.receivables (organization_id, sale_id, due_date, original_amount)
  values (v_organization_id, v_sale_id, p_due_date, v_total);

  -- Doble partida: nace la cuenta por cobrar y el ingreso. El débito 1305 y el
  -- crédito 4105 suman exactamente el total: la cartera y las ventas del
  -- reporte salen del mismo cálculo.

  perform private.post_ledger_entry(
    p_business_unit_id, p_sale_date, 'sale', 'finance.sales', v_sale_id, p_description,
    jsonb_build_array(
      jsonb_build_object('account_code', '1305', 'side', 'debit', 'amount', v_total),
      jsonb_build_object('account_code', '4105', 'side', 'credit', 'amount', v_total)
    )
  );

  perform private.write_audit_log(
    'create_sale', 'finance.sales', v_sale_id,
    null,
    jsonb_build_object('invoice_number', v_invoice_number, 'total', v_total, 'business_unit_id', p_business_unit_id)
  );

  return v_sale_id;
end;
$$;

grant execute on function public.create_sale(uuid, uuid, date, date, text, text, jsonb) to authenticated;

comment on function public.create_sale(uuid, uuid, date, date, text, text, jsonb) is
  'Registra una venta: inserta el documento, sus líneas, la cartera y el asiento 1305/4105. Una sola transacción: o todo, o nada.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Anular venta
--
-- No se borra nada: se escribe el contra-asiento (4190 devoluciones vs. 1305)
-- y la cartera queda cerrada. La venta original, su número y su asiento siguen
-- ahí para que la auditoría explique números pasados (docs/architecture/rls.md).
-- Un pago ya aplicado a la cartera impide anular: el efectivo ya movió la caja,
-- y deshacerlo es un hecho financiero aparte (deuda técnica explícita).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.void_sale(p_sale_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := (select private.current_organization_id());
  v_sale finance.sales%rowtype;
begin
  if v_organization_id is null then
    raise exception 'No hay organización activa' using errcode = '22023';
  end if;

  perform private.assert_permission('finance.sales.void');

  select * into v_sale
  from finance.sales
  where id = p_sale_id and organization_id = v_organization_id;

  if not found then
    raise exception 'Venta no encontrada en esta organización' using errcode = '22023';
  end if;

  -- La anulación pertenece a la unidad de la venta: un operador con alcance
  -- limitado no anula lo que otra unidad registró.
  if not private.can_write_business_unit(v_sale.business_unit_id) then
    raise exception 'Permiso requerido' using errcode = '42501';
  end if;

  -- Ya anulada: su contra-asiento existe. La anulación es idempotente en el
  -- sentido de que el segundo intento NO re-contabiliza, falla con la verdad.
  if exists (
    select 1 from finance.ledger_entries
    where organization_id = v_organization_id
      and source_type = 'finance.sales'
      and source_id = v_sale.id
      and entry_type = 'reversal'
  ) then
    raise exception 'La venta % ya está anulada', v_sale.invoice_number using errcode = '22023';
  end if;

  if exists (
    select 1 from finance.receivables
    where organization_id = v_organization_id and sale_id = v_sale.id and paid_amount > 0
  ) then
    raise exception 'No se puede anular: la venta ya tiene pagos aplicados' using errcode = '22023';
  end if;

  perform private.post_ledger_entry(
    v_sale.business_unit_id, v_sale.sale_date, 'reversal', 'finance.sales', v_sale.id,
    'Anulación de la venta ' || v_sale.invoice_number,
    jsonb_build_array(
      jsonb_build_object('account_code', '4190', 'side', 'debit', 'amount', v_sale.total),
      jsonb_build_object('account_code', '1305', 'side', 'credit', 'amount', v_sale.total)
    )
  );

  perform private.write_audit_log(
    'void_sale', 'finance.sales', v_sale.id,
    jsonb_build_object('invoice_number', v_sale.invoice_number, 'total', v_sale.total),
    null
  );
end;
$$;

grant execute on function public.void_sale(uuid) to authenticated;

comment on function public.void_sale(uuid) is
  'Anula una venta sin pagos aplicados escribiendo el contra-asiento 4190/1305. La historia permanece (ADR-0003).';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS y permisos
--
-- Sales, items y cartera son de SOLO LECTURA por policies. La escritura pasa
-- por `create_sale`/`void_sale` (SECURITY DEFINER). Como `ledger_lines`, la
-- política llama a `has_permission` una vez por consulta
-- (docs/architecture/rls.md).
-- ─────────────────────────────────────────────────────────────────────────────

alter table finance.sales enable row level security;
alter table finance.sale_items enable row level security;
alter table finance.receivables enable row level security;

create policy sales_select on finance.sales
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.sales.read'))
  );

create policy sale_items_select on finance.sale_items
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.sales.read'))
  );

create policy receivables_select on finance.receivables
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.receivables.read'))
  );

revoke all on finance.sales, finance.sale_items, finance.receivables from anon, authenticated;

grant select on finance.sales, finance.sale_items to authenticated;
grant select on finance.receivables to authenticated;

grant execute on function public.create_sale(uuid, uuid, date, date, text, text, jsonb) to authenticated;
grant execute on function public.void_sale(uuid) to authenticated;