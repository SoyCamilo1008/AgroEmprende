-- description: Crea el esquema finance, el libro mayor de doble partida y las funciones privadas que lo escriben.
-- depends_on: 20260928140000_enforce_organization_ownership.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Esquema finance
--
-- ADR-0003: venta, pago, gasto e inversión son hechos distintos y todos
-- terminan en un libro mayor de doble partida. El esquema llega ahora, con la
-- Fase 3, que es la que llena `core.accounts` prometido en su comentario.
--
-- `private` no se expone (docs/database/migrations.md, regla 6). `finance` sí
-- va a `[api].schemas` (config.toml) para que el cliente lea con RLS; ninguna
-- escritura nace de un `insert()` del cliente.
-- ─────────────────────────────────────────────────────────────────────────────

create schema finance;

comment on schema finance is
  'Libro mayor, ventas, cartera, pagos, gastos e inversiones. Las escrituras pasan por funciones SECURITY DEFINER; RLS gobierna la lectura.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Cuenta nueva de activo circulante: anticipos de clientes
--
-- Un pago que excede la deuda no produce un saldo negativo (ADR-0003): el
-- excedente es un saldo a favor del cliente, que en doble partida es un pasivo
-- (2210 "Anticipos de clientes"). La plantilla global se actualiza para las
-- organizaciones futuras y las existentes se replican en su plan de cuentas,
-- como hace el alta de la organización con la plantilla entera.
-- ─────────────────────────────────────────────────────────────────────────────

insert into core.account_templates (code, name, type, parent_template_code, description)
values ('2210', 'Anticipos de clientes', 'liability', null,
        'Exceso pagado por un cliente: saldo a favor, nunca un negativo (ADR-0003)')
on conflict (code) do nothing;

insert into core.accounts (organization_id, code, name, type, is_system)
select o.id, '2210', 'Anticipos de clientes', 'liability', true
from core.organizations o
on conflict (organization_id, code) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Resolución de cuentas del sistema
--
-- El asiento referencia cuentas POR CÓDIGO NIF: el plan de cuentas es por
-- organización, así que el id se resuelve dentro del contexto. Si una granja
-- inactivó o borró una cuenta base, el fallo es ruidoso y dice qué falta, no
-- "el asiento no se escribió por una FK".
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.get_account(p_code text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.id
  from core.accounts a
  where a.organization_id = (select private.current_organization_id())
    and a.code = p_code
    and a.is_active
$$;

comment on function private.get_account(text) is
  'Resuelve el id de una cuenta del plan de cuentas de la organización activa por su código NIF, o NULL.';

-- El pago entra por caja o por bancos según el medio. En la v1 no hay tarjeta
-- que se concilie contra POS: todo lo no efectivo es bancos. La conversión
-- medio → cuenta vive aquí, en un solo lugar.
create or replace function private.resolve_cash_account(p_method text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.get_account(
    case when p_method = 'cash' then '1105' else '1110' end
  )
$$;

comment on function private.resolve_cash_account(text) is
  'Cuenta de caja (1105) o bancos (1110) según el método de pago. Una sola fuente para el asiento.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Libro mayor
--
-- Dos tablas: la cabecera del asiento (qué documento lo originó) y las líneas
-- (qué cuentas se mueven y hacia dónde). Las líneas son INMUTABLES: sin UPDATE
-- ni DELETE en ninguna capa. Una venta anulada no borra su asiento: escribe una
-- contra-parte con `entry_type = 'reversal'` (ADR-0003).
--
-- No hay columna de saldo en ninguna cuenta: el saldo es
-- `sum(debit) - sum(credit)` y se calcula al leer. Guardarlo sería un saldo que
-- algún día no cuadra.
-- ─────────────────────────────────────────────────────────────────────────────

create table finance.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations (id) on delete cascade,
  business_unit_id uuid not null,
  -- Fecha de negocio (ADR-0012): el día en que el hecho económico ocurre, no
  -- el instante en que se registró.
  entry_date date not null,
  entry_type text not null check (
    entry_type in ('sale', 'payment', 'expense', 'investment', 'reinvestment', 'reversal')
  ),
  -- El documento que generó la línea: 'finance.sales', 'finance.expenses'...
  source_type text not null check (char_length(btrim(source_type)) between 2 and 80),
  source_id uuid not null,
  description text check (description is null or char_length(btrim(description)) <= 400),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- La unidad es la frontera contable (ADR-0004): un asiento nunca mezcla
  -- unidades, y la FK compuesta impide colgarlo de una unidad de otra granja.
  foreign key (organization_id, business_unit_id)
    references core.business_units (organization_id, id) on delete cascade
);

-- Balances por período: el reporte pregunta por rango de fecha, siempre dentro
-- de la organización.
create index ledger_entries_org_date on finance.ledger_entries (organization_id, entry_date);
-- Reconstruir la historia de un documento: reversas y auditorías.
create index ledger_entries_source on finance.ledger_entries (organization_id, source_type, source_id);

comment on table finance.ledger_entries is
  'Cabecera de asiento. Inmutable: un error se corrige con una contra-parte, no editando la historia.';

create table finance.ledger_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  entry_id uuid not null references finance.ledger_entries (id) on delete cascade,
  account_id uuid not null,
  debit numeric(18, 2) not null default 0 check (debit >= 0),
  credit numeric(18, 2) not null default 0 check (credit >= 0),
  created_at timestamptz not null default now(),
  -- Una línea mueve UNA cuenta hacia UN lado: débito o crédito, no los dos a la
  -- vez. La forma "débito y crédito en la misma línea" es cómo nacen los
  -- asientos que no cuadran.
  check ((debit > 0) <> (credit > 0)),
  -- La cuenta es del plan de cuentas DE ESTA organización; con una FK por `id`
  -- sola, una línea podía apuntar a la cuenta de otra granja y ser ilegible
  -- pero no inválida (docs/architecture/rls.md).
  foreign key (organization_id, account_id)
    references core.accounts (organization_id, id) on delete no action
);

create index ledger_lines_entry on finance.ledger_lines (entry_id);
-- Saldo de una cuenta por organización: las consultas de balance agrupan aquí
-- y se unen a `ledger_entries` (que ya indexa entry_date) para el filtro de
-- rango de fechas.
create index ledger_lines_account on finance.ledger_lines (organization_id, account_id);

comment on table finance.ledger_lines is
  'Línea de asiento: una cuenta, un lado, un importe. Nunca se actualiza ni se borra.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariante de doble partida
--
-- Cada asiento DEBE cuadrar: sum(débitos) = sum(créditos). Se comprueba dos
-- veces: la función `post_ledger_entry` valida antes de escribir (mensaje
-- claro) y este trigger de restricción DIFERIDO garantiza la invariante aunque
-- alguien escriba líneas por otra vía. Diferido porque las líneas de un asiento
-- llegan de una en una y la cuenta solo cuadra al cierre de la transacción.
--
-- Cubre UPDATE y DELETE aunque hoy nada los ejecute (las líneas son inmutables y
-- ningún permiso las concede): la invariante se defiende también de la función
-- futura que alguien escriba para deshacer algo.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.assert_ledger_entry_balances()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- Por `TG_OP`, no por `coalesce(new.entry_id, old.entry_id)`: en PL/pgSQL `NEW`
  -- NO está asignado en un DELETE, y desreferenciarlo aborta la sentencia con
  -- `record "new" is not assigned yet` en vez de comprobar el balance. El trigger
  -- cubre DELETE precisamente para que borrar una línea no deje un asiento
  -- descuadrado en silencio, así que esa rama tiene que funcionar.
  v_entry_id uuid := case when tg_op = 'DELETE' then old.entry_id else new.entry_id end;
  v_debits numeric(18, 2);
  v_credits numeric(18, 2);
begin
  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
  into v_debits, v_credits
  from finance.ledger_lines l
  where l.entry_id = v_entry_id;

  if v_debits <> v_credits then
    raise exception 'El asiento % no está en balance: débitos %, créditos %',
      v_entry_id, v_debits, v_credits
      using errcode = '22023';
  end if;

  return null;
end;
$$;

create constraint trigger ledger_lines_balance_invariant
  after insert or update or delete on finance.ledger_lines
  deferrable initially deferred
  for each row execute function private.assert_ledger_entry_balances();

comment on constraint ledger_lines_balance_invariant on finance.ledger_lines is
  'Al cerrar la transacción, todo asiento queda en balance: la suma de débitos es exactamente la de créditos.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Escritura de asientos
--
-- La única puerta. Recibe las líneas como JSON porque el llamador (la función
-- de negocio) ya las calculó; esta función no inventa ni redondea nada.
-- SECURITY DEFINER + search_path vacío + referencias calificadas: un asiento
-- no se puede escribir "por debajo" de una función de negocio.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function private.post_ledger_entry(
  p_business_unit_id uuid,
  p_entry_date date,
  p_entry_type text,
  p_source_type text,
  p_source_id uuid,
  p_description text,
  p_lines jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_organization_id uuid := (select private.current_organization_id());
  v_entry_id uuid;
  v_line jsonb;
  v_account_id uuid;
  v_side text;
  v_amount numeric(18, 2);
  v_debits numeric(18, 2) := 0;
  v_credits numeric(18, 2) := 0;
begin
  if v_user_id is null then
    raise exception 'Se requiere una sesión activa' using errcode = '28000';
  end if;

  if v_organization_id is null then
    raise exception 'No hay organización activa' using errcode = '22023';
  end if;

  -- Alcance de la unidad: un asiento se escribe SOLO en una unidad sobre la que
  -- el llamador pueda operar. Las funciones de negocio ya lo validaron; esta
  -- verificación cierra la puerta para quien llame a post_ledger_entry directo.
  if not private.can_write_business_unit(p_business_unit_id) then
    raise exception 'Permiso requerido' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Un asiento necesita al menos una línea' using errcode = '22023';
  end if;

  insert into finance.ledger_entries (
    organization_id, business_unit_id, entry_date, entry_type,
    source_type, source_id, description, created_by
  )
  values (
    v_organization_id, p_business_unit_id, p_entry_date, p_entry_type,
    p_source_type, p_source_id, p_description, v_user_id
  )
  returning id into v_entry_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_side := v_line ->> 'side';
    v_amount := (v_line ->> 'amount')::numeric(18, 2);
    v_account_id := private.get_account(v_line ->> 'account_code');

    if v_account_id is null then
      raise exception 'Cuenta base no encontrada en el plan de cuentas: %',
        v_line ->> 'account_code' using errcode = '22023';
    end if;

    if v_side = 'debit' then
      if v_amount <= 0 then
        raise exception 'El débito debe ser positivo' using errcode = '22023';
      end if;
      v_debits := v_debits + v_amount;
    elsif v_side = 'credit' then
      if v_amount <= 0 then
        raise exception 'El crédito debe ser positivo' using errcode = '22023';
      end if;
      v_credits := v_credits + v_amount;
    else
      raise exception 'Lado inválido de asiento: % (use debit o credit)', v_side
        using errcode = '22023';
    end if;

    insert into finance.ledger_lines (organization_id, entry_id, account_id, debit, credit)
    values (
      v_organization_id, v_entry_id, v_account_id,
      case when v_side = 'debit' then v_amount else 0 end,
      case when v_side = 'credit' then v_amount else 0 end
    );
  end loop;

  if v_debits <> v_credits then
    raise exception 'Asiento fuera de balance: débitos % vs créditos %',
      v_debits, v_credits using errcode = '22023';
  end if;

  return v_entry_id;
end;
$$;

comment on function private.post_ledger_entry(uuid, date, text, text, uuid, text, jsonb) is
  'Escribe un asiento balanceado en el libro mayor. Solo la usan las funciones de negocio SECURITY DEFINER.';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
--
-- Lectura sí, escritura NO: los asientos los escribe la base, no el cliente.
-- (select private.has_permission('finance.read')) en el paréntesis: una llamada
-- a función en una política se evalúa una vez por consulta (docs/architecture/rls.md).
-- ─────────────────────────────────────────────────────────────────────────────

alter table finance.ledger_entries enable row level security;
alter table finance.ledger_lines enable row level security;

create policy ledger_entries_select on finance.ledger_entries
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.read'))
  );

create policy ledger_lines_select on finance.ledger_lines
  for select
  using (
    organization_id = (select private.current_organization_id())
    and (select private.has_permission('finance.read'))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos SQL
-- ─────────────────────────────────────────────────────────────────────────────

grant usage on schema finance to anon, authenticated;

revoke all on finance.ledger_entries, finance.ledger_lines from anon, authenticated;

grant select on finance.ledger_entries, finance.ledger_lines to authenticated;

grant execute on function private.get_account(text) to anon, authenticated;
grant execute on function private.resolve_cash_account(text) to anon, authenticated;
grant execute on function private.post_ledger_entry(uuid, date, text, text, uuid, text, jsonb) to authenticated;