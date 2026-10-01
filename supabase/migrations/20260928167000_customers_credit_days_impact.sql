-- description: Usa credit_days del cliente para calcular el due_date de las ventas a crédito y valida que el frontend no lo contradiga.
-- depends_on: 20260928166000_fix_multi_organization_context.sql

-- El defecto que arregla esta migración
-- -------------------------------------
-- `core.customers.credit_days` existía, estaba validado entre 0 y 365 y NO lo
-- leía nadie. `create_sale` recibía `p_due_date` como parámetro y lo aceptaba
-- tal cual: el vencimiento era, en la práctica, un dato del frontend que nadie
-- contrastaba con los términos del cliente.
--
-- Consecuencias reales:
--   1. El campo de condiciones de crédito del cliente era decorativo. Marcar
--      "30 días" y que la venta venciera a los 60 no protestsaba nada.
--   2. El backend no era la fuente de verdad del vencimiento, que es justo lo
--      que este proyecto exige para el dinero (docs/principios.md).
--
-- Qué cambia
-- ----------
-- Los términos de crédito del cliente pasan a ser la fuente de verdad:
--
--   - `credit_days IS NOT NULL` (crédito): el vencimiento es
--     `sale_date + credit_days`. Si el llamador manda un `p_due_date` que no
--     coincide, la venta se rechaza con 22023 en vez de aceptarse en silencio.
--     El frontend puede omitirlo (NULL) y dejar que lo calcule el servidor.
--   - `credit_days IS NULL` (sin plazo acordado): no hay términos que
--     aplicar, así que se acepta un `p_due_date` explícito, con la única
--     regla de que no sea anterior a la venta. Es el caso "el cliente paga al
--     contado pero la venta se registra a crédito", y por eso sigue siendo
--     legítimo.
--
-- La fecha que se persiste es la calculada aquí, no la que vino del cliente.
--
-- Qué NO cambia
-- -------------
-- - `p_due_date` sigue siendo un parámetro: cambiar la firma obligaría a tocar
--   las 120 aserciones verdes y al cliente a la vez. Lo que cambia es que ya no
--   es la fuente de verdad cuando hay términos.
-- - Las ventas existentes NO se tocan. `due_date` ya está materializado en
--   `finance.sales` y `finance.receivables`, así que cambiar `credit_days`
--   después no altera ninguna venta anterior: solo las nuevas. Esto es
--   justamente por lo que los términos se copian al documento en el momento de
--   la venta y no se leen al vuelo.
-- - No se toca el asiento: 1305 contra 4105 para toda venta, igual que antes.
--   En este modelo toda venta genera cartera y luego se cobra con
--   `register_payment`; una venta "de contado" significa que el pago llega por
--   efectivo, no que la obligación no exista. Cambiar eso rompería la FIFO y el
--   libro mayor ya validados, y se documenta en el CHANGELOG.
-- - No se afloja ninguna política: la validación de cliente sigue exigiendo que
--   sea de la organización activa, así que un cliente de otra organización
--   sigue dando 22023.

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
  v_credit_days integer;
  v_due_date date;
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

  if p_sale_date is null then
    raise exception 'La fecha de venta es obligatoria' using errcode = '22023';
  end if;

  if p_due_date is not null and p_due_date < p_sale_date then
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

  -- Los términos vigentes del cliente. Se leen AQUÍ, al crear la venta, y el
  -- resultado se materializa en due_date: a partir de ese momento la venta
  -- conserva sus propios términos aunque el cliente los cambie después.
  select c.credit_days
  into v_credit_days
  from core.customers c
  where c.organization_id = v_organization_id and c.id = p_customer_id;

  -- Defensa en profundidad: la tabla ya valida el rango, pero create_sale es
  -- la puerta de entrada del dinero y no depende de que un CHECK siga ahí.
  if v_credit_days is not null and (v_credit_days < 0 or v_credit_days > 365) then
    raise exception 'Los términos de crédito del cliente no son válidos' using errcode = '22023';
  end if;

  if v_credit_days is not null then
    v_due_date := p_sale_date + v_credit_days;
    if p_due_date is not null and p_due_date <> v_due_date then
      raise exception 'El vencimiento no coincide con los términos de crédito del cliente'
        using errcode = '22023';
    end if;
  else
    -- Sin plazo acordado no hay nada que contrastar: se exige que el llamador
    -- diga cuándo vence y que no sea una fecha pasada.
    if p_due_date is null then
      raise exception 'El cliente no tiene crédito acordado: indica el vencimiento'
        using errcode = '22023';
    end if;
    v_due_date := p_due_date;
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
    p_sale_date, v_due_date, p_payment_method, v_subtotal, 0, v_total, p_description,
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
  values (v_organization_id, v_sale_id, v_due_date, v_total);

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
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'total', v_total,
      'business_unit_id', p_business_unit_id,
      'credit_days', v_credit_days,
      'due_date', v_due_date
    )
  );

  return v_sale_id;
end;
$$;

grant execute on function public.create_sale(uuid, uuid, date, date, text, text, jsonb) to authenticated;

comment on function public.create_sale(uuid, uuid, date, date, text, text, jsonb) is
  'Crea una venta. El vencimiento lo fija el servidor: con credit_days en el cliente, due_date = sale_date + credit_days y un p_due_date distinto se rechaza (22023); sin plazo acordado, p_due_date es obligatorio. Los términos se copian al documento: cambiarlos después no altera ventas ya creadas.';