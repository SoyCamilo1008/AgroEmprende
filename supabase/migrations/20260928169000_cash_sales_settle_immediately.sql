-- description: Una venta de contado no genera cartera: el dinero entra a caja/bancos en el momento y no existe cuenta por cobrar que cobrar.

-- ─────────────────────────────────────────────────────────────────────────────
-- Ventas de contado
--
-- Antes TODA venta nacía con cartera: `create_sale` insertaba siempre una fila
-- en `finance.receivables` y debitaba 1305 en el asiento, sin importar cómo se
-- pagaba. Eso obligaba a registrar un cobro posterior para una venta que ya
-- estaba pagada, y dejaba el saldo del cliente inflado por dinero que nunca fue
-- adeudado.
--
-- El módulo de gastos ya tenía resuelto este problema: `create_expense` acepta
-- `payment_method = 'credit'` y solo en ese caso genera `finance.payables` y
-- carga 2105; el resto va directo a caja/bancos por `private.cash_account_code`.
-- Esta migración es el espejo exacto para ventas. El vocabulario es el mismo a
-- los dos lados del libro, que es lo que hace auditable un sistema contable.
--
-- La regla:
--   - `payment_method = 'credit'`  → cartera + débito 1305. Requiere vencimiento.
--   - cualquier otro método        → se liquida en el acto. Sin cartera, sin
--     vencimiento, y el débito es caja (1105) o bancos (1110) según el método.
--
-- El importe recibido no cambia: los dos caminos acreditan 4105 por el total, y
-- el total es la suma redondeada de las líneas. Lo que cambia es DÓNDE queda el
-- débito y si existe una obligación por cobrar.
--
-- `due_date` queda NULLABLE porque una venta de contado no vence: no hay nada
-- que venzar. Una cartera sin fecha sí sería un agujero (se perdería de la
-- antigüedad), y por eso `finance.receivables.due_date` sigue NOT NULL.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. El método admite 'credit', igual que `finance.expenses.payment_method`.
alter table finance.sales drop constraint sales_payment_method_check;
alter table finance.sales add constraint sales_payment_method_check
  check (payment_method in ('cash', 'bank_transfer', 'card', 'digital_wallet', 'credit'));

-- 2. Backfill. Toda venta con vencimiento la tiene porque nació con cartera: ese
--    es el hecho económico que ya ocurrió, no una reinterpretación. Marcar esas
--    ventas como 'credit' describe lo que ya pasó; no se toca ni el total ni el
--    asiento ni el número de factura.
update finance.sales
set payment_method = 'credit'
where due_date is not null
  and payment_method <> 'credit';

-- 3. El vencimiento es opcional en el documento, no en la cartera.
alter table finance.sales alter column due_date drop not null;

-- 4. El invariante, en la base y no en la cabeza de nadie: es a crédito si y
--    solo si tiene vencimiento. Una venta de contado con fecha no se puede
--    colar, ni una venta a crédito sin fecha que se pierda de la antigüedad.
alter table finance.sales add constraint sales_credit_due_date_agreement
  check ((payment_method = 'credit') = (due_date is not null));

comment on column finance.sales.due_date is
  'Vencimiento. NULL en ventas de contado: no hay cartera que cobrar. Obligatorio si payment_method = ''credit''. El CHECK sales_credit_due_date_agreement ata ambas cosas.';

comment on column finance.sales.payment_method is
  '''credit'' = la venta se cobra después y genera cartera en 1305. Los demás métodos se liquidan en el acto contra caja (1105) o bancos (1110).';

-- 5. El índice de vencimientos solo tiene sentido donde hay algo que vence.
--    Sin calificar, igual que lo creó `20260928153000`: el índice vive en el
--    esquema por defecto y el nombre es el mismo.
drop index if exists sales_receivables_due;
create index sales_receivables_due on finance.sales (organization_id, due_date)
  where due_date is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- La cuenta contra la que se debita una venta, en un solo lugar.
--
-- Antes el '1305' estaba escrito a mano en `create_sale` y en `void_sale`. Con
-- dos caminos de cobro, copiar el `case` en ambos sitios es exactamente donde
-- un contra-asiento termina descontando la cartera de una venta que nunca la
-- tuvo. Aquí se decide una vez y los dos lo consumen.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.sale_debit_account_code(p_payment_method text)
returns text
language sql
immutable
returns null on null input
set search_path = ''
as $$
  select case
    when p_payment_method = 'credit' then '1305'
    else private.cash_account_code(p_payment_method)
  end
$$;

comment on function private.sale_debit_account_code(text) is
  'Cuenta que se debita al registrar una venta: 1305 si es a crédito, caja (1105) o bancos (1110) si se liquida en el acto. La usa también el contra-asiento de anulación, invertido.';

grant execute on function private.sale_debit_account_code(text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- create_sale
--
-- Cambia el contrato de `p_due_date`: solo tiene sentido a crédito. Se mantiene
-- el parámetro en su posición para no romper a los clientes que ya lo envían.
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
  v_sale_id uuid;
  v_item jsonb;
  v_subtotal numeric(18, 2) := 0;
  v_total numeric(18, 2);
  v_invoice_number text;
  v_due_date date;
  v_credit_days integer;
  v_is_credit boolean;
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

  if p_payment_method is null
     or p_payment_method not in ('cash', 'bank_transfer', 'card', 'digital_wallet', 'credit') then
    raise exception 'Método de pago inválido' using errcode = '22023';
  end if;

  v_is_credit := p_payment_method = 'credit';

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

  if v_is_credit then
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
      if p_due_date < p_sale_date then
        raise exception 'El vencimiento no puede ser anterior a la venta' using errcode = '22023';
      end if;
      v_due_date := p_due_date;
    end if;
  else
    -- Venta de contado. El vencimiento es un dato de una obligación que aquí no
    -- existe: aceptarlo significaría guardar una fecha que no corresponde a nada.
    if p_due_date is not null then
      raise exception 'Una venta de contado no lleva fecha de vencimiento'
        using errcode = '22023';
    end if;

    -- Se verifica que la cuenta de efectivo exista ANTES de escribir la venta:
    -- si el plan de cuentas no tiene 1105 ni 1110, el asiento no puede armarse
    -- y es mejor fallar con un mensaje claro que a mitad del asiento.
    if private.resolve_cash_account(p_payment_method) is null then
      raise exception 'Cuenta base de efectivo no configurada para este método'
        using errcode = '22023';
    end if;

    v_due_date := null;
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

  -- La cartera solo existe si hay algo que cobrar. Una venta de contado que
  -- fabricara una obligación de cero días sería una mentira contable.
  if v_is_credit then
    insert into finance.receivables (organization_id, sale_id, due_date, original_amount)
    values (v_organization_id, v_sale_id, v_due_date, v_total);
  end if;

  -- Doble partida. Los dos caminos acreditan 4105 por el total; lo que cambia es
  -- la contrapartida del débito: 1305 queda en la cartera que se acaba de crear,
  -- o caja/bancos que ya recibieron el dinero.
  perform private.post_ledger_entry(
    p_business_unit_id, p_sale_date, 'sale', 'finance.sales', v_sale_id, p_description,
    jsonb_build_array(
      jsonb_build_object(
        'account_code', private.sale_debit_account_code(p_payment_method),
        'side', 'debit', 'amount', v_total
      ),
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
      'due_date', v_due_date,
      'credit', v_is_credit,
      'debit_account', private.sale_debit_account_code(p_payment_method)
    )
  );

  return v_sale_id;
end;
$$;

grant execute on function public.create_sale(uuid, uuid, date, date, text, text, jsonb) to authenticated;

comment on function public.create_sale(uuid, uuid, date, date, text, text, jsonb) is
  'Crea una venta. payment_method = ''credit'' la deja a cobrar: con credit_days en el cliente, due_date = sale_date + credit_days y un p_due_date distinto se rechaza (22023); sin plazo acordado, p_due_date es obligatorio. Cualquier otro método la liquida en el acto: sin cartera, sin vencimiento (mandarlo es 22023) y con el débito contra caja o bancos. Los términos se copian al documento: cambiarlos después no altera ventas ya creadas.';

-- ─────────────────────────────────────────────────────────────────────────────
-- void_sale
--
-- El contra-asiento invierte la contrapartida del débito original. Anular una
-- venta de contado acreditando 1305 dejaría una cartera negativa que nunca
-- existió, y el saldo del cliente quedaría con un holesco.
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

  -- Una venta de contado no tiene cartera, así que esta comprobación no aplica y
  -- el `exists` la resuelve sola: `void_sale` no necesita saber de qué tipo era.
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
      jsonb_build_object(
        'account_code', private.sale_debit_account_code(v_sale.payment_method),
        'side', 'credit', 'amount', v_sale.total
      )
    )
  );

  perform private.write_audit_log(
    'void_sale', 'finance.sales', v_sale.id,
    jsonb_build_object(
      'invoice_number', v_sale.invoice_number,
      'total', v_sale.total,
      'credit_account', private.sale_debit_account_code(v_sale.payment_method)
    ),
    null
  );
end;
$$;

grant execute on function public.void_sale(uuid) to authenticated;

comment on function public.void_sale(uuid) is
  'Anula una venta sin pagos aplicados escribiendo el contra-asiento 4190 contra la misma cuenta que se debitó al crearla: 1305 si era a crédito, caja o bancos si se liquidó en el acto. La historia permanece (ADR-0003).';