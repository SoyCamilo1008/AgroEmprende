-- description: Pagos entrantes y salientes, con asignacion FIFO a cartera o cuentas por pagar y saldo a favor (2210/1310).
-- depends_on: 20260928160000_create_finance_expenses.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Pagos: el hecho de caja
--
-- Un pago es TODO el efectivo que se mueve, no solo "lo que aplica a una
-- venta". Se aplica a la deuda que más vence primero (FIFO por `due_date`); lo
-- que sobra es saldo a favor del cliente (2210) o anticipo al proveedor (1310),
-- nunca una deuda negativa (ADR-0003).
--
-- Cadena de hechos: venta (obligación) → pago (hecho de caja) → asignación
-- (relación entre ambos). `paid_amount` en receivables/payables es la
-- proyección legible de ese asiento, no una cifra paralela.
-- ─────────────────────────────────────────────────────────────────────────────

create table finance.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  payment_id uuid not null,
  -- La deuda aplicada: cartera (receivable) o cuenta por pagar (payable). El id
  -- es polimórfico a propósito: "qué deuda" se documenta en el asiento del pago.
  allocation_type text not null check (allocation_type in ('receivable', 'payable')),
  allocation_id uuid not null,
  amount numeric(18, 2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (payment_id, allocation_type, allocation_id)
);

-- La deuda que un pago saldó: el reporte de "por qué quedó pagada la venta"
-- entra por aquí.
create index payment_allocations_debt on finance.payment_allocations (organization_id, allocation_type, allocation_id);

comment on table finance.payment_allocations is
  'Relación pago → deuda. Inmutable: corregir una mala asignación es un contra-pago, no editar (igual que el libro mayor).';

create table finance.payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  business_unit_id uuid not null,
  payment_date date not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  method text not null check (
    method in ('cash', 'bank_transfer', 'card', 'digital_wallet')
  ),
  amount numeric(18, 2) not null check (amount > 0),
  -- Lo que sobró después de aplicar: saldo a favor. Nunca negativo y siempre
  -- armónico con las asignaciones: el pago total es asignado + sobrante.
  unapplied_amount numeric(18, 2) not null default 0 check (unapplied_amount between 0 and amount),
  -- (el CHECK de coherencia de la suma vive al final: referencia la tabla de
  -- asignaciones, que ya existe)
  description text check (description is null or char_length(btrim(description)) <= 400),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Destino de la FK compuesta de las asignaciones (mismo patrón de accounts).
  unique (organization_id, id),
  foreign key (organization_id, business_unit_id)
    references core.business_units (organization_id, id) on delete cascade
);

-- El total del pago es exactamente la suma de sus asignaciones más el sobrante.
--
-- NO puede ser un `check` de tabla: PostgreSQL rechaza las subconsultas dentro de
-- un CHECK (`cannot use subquery in check constraint`), y este invariante necesita
-- leer `payment_allocations`. Se declara como trigger de restricción DIFERIDO, el
-- mismo patrón que el balance del libro mayor: la suma solo tiene sentido al
-- cerrar la transacción, porque las asignaciones llegan de una en una.
create or replace function private.assert_payment_allocations_coherent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- Una sola función cubre DOS tablas y no llaman igual a la clave: en
  -- `payments` es `id` y en `payment_allocations` es `payment_id`.
  --
  -- No se puede discriminar con `old.payment_id` / `new.payment_id` a secas,
  -- porque al disparar desde `payments` esos campos no existen. Y tampoco
  --Serving con un `case` que elija la columna: PL/pgSQL resuelve las referencias
  -- a campos del registro al PLANIFICAR la expresión, no al evaluarla, así que
  -- la rama muerta también revienta con
  -- `record "old" has no field "payment_id"`. Se comprueba en PGlite.
  --
  -- La salida es no nombrar ningún campo: `to_jsonb` del registro completo y se
  -- busca la clave que corresponda a la tabla. Una clave inexistente devuelve
  -- NULL en vez de abortar la sentencia.
  v_row jsonb;
  v_key text;
  v_payment_id uuid;
  v_amount numeric(18, 2);
  v_unapplied numeric(18, 2);
  v_allocated numeric(18, 2);
begin
  -- `OLD` no está asignado en un INSERT ni en un UPDATE, y desreferenciarlo
  -- aborta con `record "old" is not assigned yet` en vez de comprobar nada.
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
  else
    v_row := to_jsonb(new);
  end if;

  v_key := case when tg_table_name = 'payments' then 'id' else 'payment_id' end;
  v_payment_id := (v_row ->> v_key)::uuid;
  select p.amount, p.unapplied_amount
  into v_amount, v_unapplied
  from finance.payments p
  where p.id = v_payment_id;

  -- El pago desaparece en la misma transacción (borrado en cascada de su
  -- organización): no hay nada que armonizar.
  if not found then
    return null;
  end if;

  select coalesce(sum(a.amount), 0)
  into v_allocated
  from finance.payment_allocations a
  where a.payment_id = v_payment_id;

  if v_amount <> v_unapplied + v_allocated then
    raise exception
      'El pago % no es coherente: total %, sobrante %, asignaciones %',
      v_payment_id, v_amount, v_unapplied, v_allocated
      using errcode = '22023';
  end if;

  return null;
end;
$$;

  -- Se dispara desde las DOS tablas: cambiar el sobrante rompe la suma igual que
  -- agregar una asignación. Diferido para que la cuenta cierre al final.
  --
  -- Y diferido significa que el error sale al final de la transacción, no al
  -- insertar: por eso un fallo aquí se lee como si nada tuviera que ver con el
  -- pago que lo disparó.
create constraint trigger payments_allocations_coherent
  after insert or update or delete on finance.payments
  deferrable initially deferred
  for each row execute function private.assert_payment_allocations_coherent();

create constraint trigger payment_allocations_coherent
  after insert or update or delete on finance.payment_allocations
  deferrable initially deferred
  for each row execute function private.assert_payment_allocations_coherent();

comment on constraint payments_allocations_coherent on finance.payments is
  'Al cerrar la transacción, el total del pago es la suma de sus asignaciones más el sobrante.';

create index payments_period on finance.payments (organization_id, payment_date, direction);

comment on table finance.payments is
  'Hecho de caja. `unapplied_amount` es el exceso no asignado; el total aplicado suma exacto con las asignaciones.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Aplicar una parte de un pago a una deuda
--
-- Privada y llamada SOLO dentro de `register_payment`: el asiento, la
-- asignación y la proyección se escriben juntos o no se escriben. Reduce el
-- sobrante del pago a medida que se aplica, para que el CHECK de coherencia y
-- el asiento final vean la misma realidad.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.allocate_payment(
  p_organization_id uuid,
  p_payment_id uuid,
  p_allocation_type text,
  p_debt_id uuid,
  p_amount numeric
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into finance.payment_allocations (organization_id, payment_id, allocation_type, allocation_id, amount)
  values (p_organization_id, p_payment_id, p_allocation_type, p_debt_id, p_amount);

  update finance.payments
  set unapplied_amount = unapplied_amount - p_amount
  where id = p_payment_id and organization_id = p_organization_id;

  if p_allocation_type = 'receivable' then
    update finance.receivables
    set paid_amount = paid_amount + p_amount,
        paid_at = now()
    where organization_id = p_organization_id and id = p_debt_id;
  else
    update finance.payables
    set paid_amount = paid_amount + p_amount,
        paid_at = now()
    where organization_id = p_organization_id and id = p_debt_id;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Registrar pago
--
-- p_assignments: JSON opcional para control fino
--   inbound  -> [{ "type": "receivable", "id": "<uuid-de-la-deuda>" }, ...]
--   outbound -> [{ "type": "payable",    "id": "<uuid-de-la-deuda>" }, ...]
-- Sin asignaciones, se aplica FIFO por vencimiento de la deuda abierta. El
-- pago entrante entra por caja/bancos contra 1305 (aplicado) + 2210 (sobra);
-- el saliente, 2105 + 1310 contra caja/bancos. UNA transacción.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.register_payment(
  p_business_unit_id uuid,
  p_payment_date date,
  p_direction text,
  p_method text,
  p_amount numeric,
  p_description text default null,
  p_assignments jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := (select private.current_organization_id());
  v_payment_id uuid;
  v_remaining numeric(18, 2);
  v_debt record;
  v_assignment jsonb;
  v_applied numeric(18, 2);
begin
  if v_organization_id is null then
    raise exception 'No hay organización activa' using errcode = '22023';
  end if;

  perform private.assert_permission('finance.payments.create');

  if not private.can_write_business_unit(p_business_unit_id) then
    raise exception 'Permiso requerido' using errcode = '42501';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto del pago debe ser positivo' using errcode = '22023';
  end if;

  if p_direction is null or p_direction not in ('inbound', 'outbound') then
    raise exception 'Dirección de pago inválida' using errcode = '22023';
  end if;

  if p_method is null or p_method not in ('cash', 'bank_transfer', 'card', 'digital_wallet') then
    raise exception 'Método de pago inválido' using errcode = '22023';
  end if;

  if p_assignments is not null and jsonb_typeof(p_assignments) <> 'array' then
    raise exception 'Las asignaciones deben ser un arreglo' using errcode = '22023';
  end if;

  v_remaining := p_amount;

  -- El pago nace con todo el monto "sin aplicar"; cada asignación lo consume.
  insert into finance.payments (
    organization_id, business_unit_id, payment_date, direction, method,
    amount, unapplied_amount, description, created_by
  )
  values (
    v_organization_id, p_business_unit_id, p_payment_date, p_direction, p_method,
    p_amount, p_amount, p_description, (select auth.uid())
  )
  returning id into v_payment_id;

  if p_assignments is not null then
    for v_assignment in select * from jsonb_array_elements(p_assignments) loop
      -- El CASE va entre parentesis a proposito. Sin ellos, PL/pgSQL lee
      -- `if a <> case when ... end then` y se come el `then` del CASE como si
      -- cerrara el IF: el IF queda sin cerrar y la migracion muere con
      -- `syntax error at end of input` sin senalar esta linea.
      if (v_assignment ->> 'type') <> (
        case when p_direction = 'inbound' then 'receivable' else 'payable' end
      ) then
        raise exception 'Tipo de asignación inválido para un pago %: %',
          p_direction, v_assignment ->> 'type' using errcode = '22023';
      end if;

      if p_direction = 'inbound' then
        select * into v_debt
        from finance.receivables
        where organization_id = v_organization_id
          and id = (v_assignment ->> 'id')::uuid
          and paid_amount < original_amount;
      else
        select * into v_debt
        from finance.payables
        where organization_id = v_organization_id
          and id = (v_assignment ->> 'id')::uuid
          and paid_amount < original_amount;
      end if;

      if v_debt is null then
        raise exception 'Deuda no encontrada o ya saldada' using errcode = '22023';
      end if;

      v_applied := least(v_remaining, v_debt.original_amount - v_debt.paid_amount);
      if v_applied <= 0 then
        raise exception 'El pago ya se agotó antes de la asignación' using errcode = '22023';
      end if;

      perform private.allocate_payment(
        v_organization_id, v_payment_id, v_assignment ->> 'type', v_debt.id, v_applied
      );
      v_remaining := v_remaining - v_applied;
    end loop;
  else
    -- FIFO por vencimiento de la deuda abierta. Cada iteración lee el estado
    -- actualizado de la fila (misma transacción): nunca se aplica a la misma
    -- deuda más allá del saldo que le quedaba.
    if p_direction = 'inbound' then
      for v_debt in
        select * from finance.receivables
        where organization_id = v_organization_id
          and paid_amount < original_amount
        order by due_date, id
      loop
        exit when v_remaining = 0;
        v_applied := least(v_remaining, v_debt.original_amount - v_debt.paid_amount);
        perform private.allocate_payment(
          v_organization_id, v_payment_id, 'receivable', v_debt.id, v_applied
        );
        v_remaining := v_remaining - v_applied;
      end loop;
    else
      for v_debt in
        select * from finance.payables
        where organization_id = v_organization_id
          and paid_amount < original_amount
        order by due_date, id
      loop
        exit when v_remaining = 0;
        v_applied := least(v_remaining, v_debt.original_amount - v_debt.paid_amount);
        perform private.allocate_payment(
          v_organization_id, v_payment_id, 'payable', v_debt.id, v_applied
        );
        v_remaining := v_remaining - v_applied;
      end loop;
    end if;
  end if;

  if v_remaining >= p_amount then
    raise exception 'No hay deuda abierta a la que aplicar el pago' using errcode = '22023';
  end if;

  -- Contra-partida del pago. El array se arma con `case` para que el tramo que no
  -- aplica no se escriba, y `post_ledger_entry` descarta esos NULL. Ojo: aquí el
  -- comentario que decía que `jsonb_build_array` los omitía era falso, los mete
  -- como `null` de JSON, y un pago que aplicara todo fallaba con
  -- «Cuenta base no encontrada: <NULL>». Si un día esto se mueve, esa es la trampa.
  if p_direction = 'inbound' then
    perform private.post_ledger_entry(
      p_business_unit_id, p_payment_date, 'payment', 'finance.payments', v_payment_id, p_description,
      jsonb_build_array(
        jsonb_build_object(
          'account_code', private.cash_account_code(p_method), 'side', 'debit', 'amount', p_amount
        ),
        case when v_remaining < p_amount then
          jsonb_build_object('account_code', '1305', 'side', 'credit', 'amount', p_amount - v_remaining)
        end,
        case when v_remaining > 0 then
          jsonb_build_object('account_code', '2210', 'side', 'credit', 'amount', v_remaining)
        end
      )
    );
  else
    perform private.post_ledger_entry(
      p_business_unit_id, p_payment_date, 'payment', 'finance.payments', v_payment_id, p_description,
      jsonb_build_array(
        case when v_remaining < p_amount then
          jsonb_build_object('account_code', '2105', 'side', 'debit', 'amount', p_amount - v_remaining)
        end,
        case when v_remaining > 0 then
          jsonb_build_object('account_code', '1310', 'side', 'debit', 'amount', v_remaining)
        end,
        jsonb_build_object(
          'account_code', private.cash_account_code(p_method), 'side', 'credit', 'amount', p_amount
        )
      )
    );
  end if;

  perform private.write_audit_log(
    'register_payment', 'finance.payments', v_payment_id,
    null,
    jsonb_build_object(
      'direction', p_direction, 'method', p_method, 'amount', p_amount,
      'unapplied', v_remaining, 'payment_date', p_payment_date
    )
  );

  return v_payment_id;
end;
$$;

grant execute on function public.register_payment(uuid, date, text, text, numeric, text, jsonb) to authenticated;

comment on function public.register_payment(uuid, date, text, text, numeric, text, jsonb) is
  'Registra un pago: asigna a la deuda más antigua (o a las indicadas), contabiliza caja/bancos y deja el exceso como saldo a favor.';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS y permisos
-- ─────────────────────────────────────────────────────────────────────────────

alter table finance.payments enable row level security;
alter table finance.payment_allocations enable row level security;

create policy payments_select on finance.payments
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.payments.read'))
  );

create policy payment_allocations_select on finance.payment_allocations
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.payments.read'))
  );

revoke all on finance.payments, finance.payment_allocations from anon, authenticated;

grant select on finance.payments, finance.payment_allocations to authenticated;