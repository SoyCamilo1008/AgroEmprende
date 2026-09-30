-- description: Gastos, inversiones, reinversiones y cuentas por pagar, cada una con su funcion de alta y su asiento.
-- depends_on: 20260928153000_create_finance_sales.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Gastos: hecho de caja (a menos que quede a crédito)
--
-- El gasto va de la mano del desembolso: SIEMPRE se contabiliza en el momento
-- del hecho (devengo), porque el costo de producción se cierra por período.
-- Si fue a crédito, la compra se contabiliza contra 2105 (cuentas por pagar) y
-- `register_payment` la paga después. El pago no es otro documento: es la
-- aplicación de efectivo contra la obligación (cadena pago → payable).
--
-- La cuenta de gasto se deriva del tipo en UN solo lugar
-- (`private.expense_account`): el tipo es del dominio de la app y la cuenta es
-- del plan NIF; acoplarlas en cada función sería la receta del asiento errado.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.expense_account(p_expense_type text)
returns text
language sql
immutable
returns null on null input
set search_path = ''
as $$
  select case p_expense_type
    when 'feed'      then '5205'
    when 'water'     then '5210'
    when 'health'    then '5220'
    when 'labor'     then '5230'
    when 'services'  then '5305'
    when 'financial' then '5390'
    else                  '5290'
  end
$$;

comment on function private.expense_account(text) is
  'Cuenta NIF de gasto para cada tipo del dominio. Fuente única para el asiento de gasto.';

create table finance.payables (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  business_unit_id uuid not null,
  origin_type text not null check (origin_type in ('expense', 'investment', 'reinvestment')),
  origin_id uuid not null,
  due_date date not null,
  original_amount numeric(18, 2) not null check (original_amount >= 0),
  paid_amount numeric(18, 2) not null default 0 check (paid_amount between 0 and original_amount),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  check ((paid_amount > 0) = (paid_at is not null)),
  foreign key (organization_id, business_unit_id)
    references core.business_units (organization_id, id) on delete cascade
);

create index payables_open on finance.payables (organization_id, due_date) where paid_amount < original_amount;

comment on table finance.payables is
  'Cuenta por pagar: el crédito del proveedor. `paid_amount` lo mueve `register_payment`, nunca el cliente.';

create table finance.expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_unit_id uuid not null,
  expense_type text not null check (
    expense_type in ('feed', 'water', 'health', 'labor', 'services', 'financial', 'other')
  ),
  expense_date date not null,
  description text check (description is null or char_length(btrim(description)) <= 400),
  amount numeric(18, 2) not null check (amount > 0),
  -- `credit` es un valor admitido a propósito: significa "devengado y aún no
  -- pagado", y es lo que `create_expense` guarda para el gasto que genera un
  -- `finance.payables`. Sin él en esta lista, un gasto a crédito no se podía
  -- registrar siquiera: la función lo aceptaba y la tabla lo rechazaba.
  payment_method text not null check (
    payment_method in ('cash', 'bank_transfer', 'card', 'digital_wallet', 'credit')
  ),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, business_unit_id)
    references core.business_units (organization_id, id) on delete cascade
);

create index expenses_period on finance.expenses (organization_id, expense_date);

comment on table finance.expenses is
  'Gasto devengado. Si fue a crédito, hay un `finance.payables` hermano con el mismo origen.';

create table finance.investments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_unit_id uuid not null,
  investment_date date not null,
  description text check (description is null or char_length(btrim(description)) <= 400),
  amount numeric(18, 2) not null check (amount > 0),
  -- Igual que en `expenses`: `create_investment` acepta `credit` para la
  -- inversión financiada, así que la columna tiene que poder guardarlo.
  payment_method text not null check (
    payment_method in ('cash', 'bank_transfer', 'card', 'digital_wallet', 'credit')
  ),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, business_unit_id)
    references core.business_units (organization_id, id) on delete cascade
);

create index investments_period on finance.investments (organization_id, investment_date);

comment on table finance.investments is
  'Inversión en activo (equipos, infraestructura). La depreciación (5320) llega con la fase de activos fijos.';

create table finance.reinvestments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  business_unit_id uuid not null,
  reinvestment_date date not null,
  description text check (description is null or char_length(btrim(description)) <= 400),
  amount numeric(18, 2) not null check (amount > 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, business_unit_id)
    references core.business_units (organization_id, id) on delete cascade
);

create index reinvestments_period on finance.reinvestments (organization_id, reinvestment_date);

comment on table finance.reinvestments is
  'Decisión contable de capital: la utilidad se compromete a inversión futura, sin mover caja (3110 → 3120).';

-- ─────────────────────────────────────────────────────────────────────────────
-- Código NIF de caja/bancos para un método, por fuera de la resolución por
-- organización. `resolve_cash_account` devuelve el id (para validar que la
-- cuenta exista); el asiento necesita el CÓDIGO para
-- `private.post_ledger_entry`, que resuelve la cuenta del contexto.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.cash_account_code(p_method text)
returns text
language sql
immutable
returns null on null input
set search_path = ''
as $$
  select case when p_method = 'cash' then '1105' else '1110' end
$$;

grant execute on function private.cash_account_code(text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Registrar gasto
--
-- p_payment_method 'credit' convierte el desembolso en cuenta por pagar: el
-- asiento carga la cuenta de gasto y abona 2105, y el saldo se paga después.
-- Cualquier otro método abona caja/bancos: el gasto terminó, no hay saldo.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_expense(
  p_business_unit_id uuid,
  p_expense_type text,
  p_expense_date date,
  p_payment_method text,
  p_description text,
  p_amount numeric,
  p_credit_due_date date default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := (select private.current_organization_id());
  v_expense_id uuid;
  v_is_credit boolean := coalesce(p_payment_method = 'credit', false);
begin
  if v_organization_id is null then
    raise exception 'No hay organización activa' using errcode = '22023';
  end if;

  perform private.assert_permission('finance.expenses.create');

  if not private.can_write_business_unit(p_business_unit_id) then
    raise exception 'Permiso requerido' using errcode = '42501';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto del gasto debe ser positivo' using errcode = '22023';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'bank_transfer', 'card', 'digital_wallet', 'credit') then
    raise exception 'Método de pago inválido' using errcode = '22023';
  end if;

  if v_is_credit and p_credit_due_date is null then
    raise exception 'Un gasto a crédito necesita fecha de vencimiento' using errcode = '22023';
  end if;

  if not v_is_credit and private.resolve_cash_account(p_payment_method) is null then
    raise exception 'Cuenta base de efectivo no configurada para este método' using errcode = '22023';
  end if;

  insert into finance.expenses (
    organization_id, business_unit_id, expense_type, expense_date,
    description, amount, payment_method, created_by
  )
  values (
    v_organization_id, p_business_unit_id, p_expense_type, p_expense_date,
    p_description, p_amount, p_payment_method, (select auth.uid())
  )
  returning id into v_expense_id;

  if v_is_credit then
    insert into finance.payables (
      organization_id, business_unit_id, origin_type, origin_id, due_date, original_amount
    )
    values (
      v_organization_id, p_business_unit_id, 'expense', v_expense_id,
      p_credit_due_date, p_amount
    );
  end if;

  perform private.post_ledger_entry(
    p_business_unit_id, p_expense_date, 'expense', 'finance.expenses', v_expense_id, p_description,
    jsonb_build_array(
      jsonb_build_object(
        'account_code', private.expense_account(p_expense_type), 'side', 'debit', 'amount', p_amount
      ),
      jsonb_build_object(
        'account_code', case when v_is_credit then '2105' else private.cash_account_code(p_payment_method) end,
        'side', 'credit', 'amount', p_amount
      )
    )
  );

  perform private.write_audit_log(
    'create_expense', 'finance.expenses', v_expense_id,
    null,
    jsonb_build_object(
      'expense_type', p_expense_type, 'amount', p_amount,
      'payment_method', p_payment_method, 'credit', v_is_credit
    )
  );

  return v_expense_id;
end;
$$;

grant execute on function public.create_expense(uuid, text, date, text, text, numeric, date) to authenticated;

comment on function public.create_expense(uuid, text, date, text, text, numeric, date) is
  'Registra un gasto y su asiento. A crédito: abona 2105 y crea el payable. De contado: abona caja/bancos.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Registrar inversión
--
-- La inversión capitaliza un activo: débito a 1590 (activos fijos sin
-- depreciar), crédito a caja/bancos o 2105 si quedó financiada. No se mueve a
-- 1505 todavía: la depreciación que lo traslada (5320) llega con la fase de
-- activos fijos, y en el ínterin la inversión se mantiene "viva" en 1590.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_investment(
  p_business_unit_id uuid,
  p_investment_date date,
  p_payment_method text,
  p_description text,
  p_amount numeric,
  p_credit_due_date date default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := (select private.current_organization_id());
  v_investment_id uuid;
  v_is_credit boolean := coalesce(p_payment_method = 'credit', false);
begin
  if v_organization_id is null then
    raise exception 'No hay organización activa' using errcode = '22023';
  end if;

  perform private.assert_permission('finance.investments.create');

  if not private.can_write_business_unit(p_business_unit_id) then
    raise exception 'Permiso requerido' using errcode = '42501';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto de la inversión debe ser positivo' using errcode = '22023';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'bank_transfer', 'card', 'digital_wallet', 'credit') then
    raise exception 'Método de pago inválido' using errcode = '22023';
  end if;

  if v_is_credit and p_credit_due_date is null then
    raise exception 'Una inversión a crédito necesita fecha de vencimiento' using errcode = '22023';
  end if;

  insert into finance.investments (
    organization_id, business_unit_id, investment_date,
    description, amount, payment_method, created_by
  )
  values (
    v_organization_id, p_business_unit_id, p_investment_date,
    p_description, p_amount, p_payment_method, (select auth.uid())
  )
  returning id into v_investment_id;

  if v_is_credit then
    insert into finance.payables (
      organization_id, business_unit_id, origin_type, origin_id, due_date, original_amount
    )
    values (
      v_organization_id, p_business_unit_id, 'investment', v_investment_id,
      p_credit_due_date, p_amount
    );
  end if;

  if not v_is_credit and private.resolve_cash_account(p_payment_method) is null then
    raise exception 'Cuenta base de efectivo no configurada para este método' using errcode = '22023';
  end if;

  perform private.post_ledger_entry(
    p_business_unit_id, p_investment_date, 'investment', 'finance.investments', v_investment_id, p_description,
    jsonb_build_array(
      jsonb_build_object('account_code', '1590', 'side', 'debit', 'amount', p_amount),
      jsonb_build_object(
        'account_code', case when v_is_credit then '2105' else private.cash_account_code(p_payment_method) end,
        'side', 'credit', 'amount', p_amount
      )
    )
  );

  perform private.write_audit_log(
    'create_investment', 'finance.investments', v_investment_id,
    null,
    jsonb_build_object('amount', p_amount, 'payment_method', p_payment_method, 'credit', v_is_credit)
  );

  return v_investment_id;
end;
$$;

grant execute on function public.create_investment(uuid, date, text, text, numeric, date) to authenticated;

comment on function public.create_investment(uuid, date, text, text, numeric, date) is
  'Registra una inversión de activo: débito 1590, crédito caja/bancos o 2105 si quedó a crédito.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Registrar reinversión
--
-- Es una decisión contable, no un desembolso: la utilidad se compromete a
-- proyectos. Débito 3110 (utilidad del ejercicio) contra crédito 3120 (utilidad
-- retenida). Conservador: no toca 1505/1590 porque la inversión que compre la
-- reinversión es un hecho aparte con su propia contabilización.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_reinvestment(
  p_business_unit_id uuid,
  p_reinvestment_date date,
  p_description text,
  p_amount numeric
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := (select private.current_organization_id());
  v_reinvestment_id uuid;
begin
  if v_organization_id is null then
    raise exception 'No hay organización activa' using errcode = '22023';
  end if;

  perform private.assert_permission('finance.reinvestments.create');
  if not private.can_write_business_unit(p_business_unit_id) then
    raise exception 'Permiso requerido' using errcode = '42501';
  end if;

  if p_amount <= 0 then
    raise exception 'El monto a reinvertir debe ser positivo' using errcode = '22023';
  end if;

  insert into finance.reinvestments (
    organization_id, business_unit_id, reinvestment_date, description, amount, created_by
  )
  values (
    v_organization_id, p_business_unit_id, p_reinvestment_date, p_description, p_amount,
    (select auth.uid())
  )
  returning id into v_reinvestment_id;

  perform private.post_ledger_entry(
    p_business_unit_id, p_reinvestment_date, 'reinvestment', 'finance.reinvestments',
    v_reinvestment_id, p_description,
    jsonb_build_array(
      jsonb_build_object('account_code', '3110', 'side', 'debit', 'amount', p_amount),
      jsonb_build_object('account_code', '3120', 'side', 'credit', 'amount', p_amount)
    )
  );

  perform private.write_audit_log(
    'create_reinvestment', 'finance.reinvestments', v_reinvestment_id,
    null,
    jsonb_build_object('amount', p_amount)
  );

  return v_reinvestment_id;
end;
$$;

grant execute on function public.create_reinvestment(uuid, date, text, numeric) to authenticated;

comment on function public.create_reinvestment(uuid, date, text, numeric) is
  'Compromete utilidad a inversión: 3110 → 3120, sin mover caja.';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS y permisos
--
-- Mismo patrón que ventas y libro mayor: tablas de solo lectura por RLS,
-- escritura únicamente por las funciones SECURITY DEFINER.
-- ─────────────────────────────────────────────────────────────────────────────

alter table finance.payables enable row level security;
alter table finance.expenses enable row level security;
alter table finance.investments enable row level security;
alter table finance.reinvestments enable row level security;

create policy payables_select on finance.payables
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.expenses.read'))
  );

create policy expenses_select on finance.expenses
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.expenses.read'))
  );

create policy investments_select on finance.investments
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.investments.read'))
  );

create policy reinvestments_select on finance.reinvestments
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.reinvestments.read'))
  );

revoke all on finance.payables, finance.expenses, finance.investments, finance.reinvestments from anon, authenticated;

grant select on finance.payables, finance.expenses, finance.investments, finance.reinvestments to authenticated;

grant execute on function private.expense_account(text) to anon, authenticated;