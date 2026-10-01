-- description: Vistas de lectura de la cartera del cliente y resumen por unidad de negocio, con el saldo derivado en PostgreSQL.
-- depends_on: 20260928171000_derive_partner_organization_on_insert.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- El modulo de Clientes necesita VER la cartera, no CALCULARLA
--
-- El problema que esta migracion evita
-- -----------------------------------
-- "Cuanto debe este cliente" no es un campo: es la diferencia entre lo que se le
-- vendio y lo que se le cobro, cruzando `finance.sales`, `finance.receivables`,
-- `finance.payment_allocations`, `finance.payments` y el contra-asiento que
-- marca una venta anulada (ADR-0003). Si eso se calculara en TypeScript:
--
--   1. Habria N+1: una consulta por venta para su cartera, y otra por cartera
--      para sus pagos.
--   2. El saldo se duplicaria en cada app, y Web y Mobile podrian mostrar
--      numeros distintos para el mismo cliente.
--   3. "Vencidas" y "el mas antiguo por cobrar" se decidirian en JavaScript,
--      porque `resolveReceivableStatus` y `daysOverdue` son funciones de
--      TypeScript: habria que traer TODAS las filas para ordenarlas en memoria.
--
-- Los tres problemas se resuelven con un filtro en PostgreSQL. Aqui la
-- agregacion vive en la base, que es el unico lugar donde una suma de dinero no
-- se desincroniza del libro mayor.
--
-- Lo que NO se duplica
-- --------------------
-- - No hay columna de saldo en ninguna tabla: `balance` se deriva al leer.
-- - No se inventan estados: se usan `paid_amount`/`original_amount` y la
--   condicion de `paid_at` que ya definio `20260928153000_create_finance_sales`.
-- - No se toca `finance.sales`, `finance.receivables` ni `finance.payments`:
--   las escriben las funciones SECURITY DEFINER del motor. Esto solo lee.
--
-- Un punto donde el motor financiero ya resuelve el problema
-- ----------------------------------------------------------
-- Una venta de contado NO genera fila en `finance.receivables`
-- (`20260928169000_cash_sales_settle_immediately.sql`): el dinero entro por
-- caja. Por eso la cartera sale de `receivables` y no de `sales`, y una venta
-- de contado NO aparece como pendiente por construccion, sin ningun `where` que
-- lo excluya. Si alguien cambiara esa regla, esta vista mostraria una venta de
-- contado como cartera abierta y las pruebas de base lo detectarian.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- finance.customer_receivables
--
-- Una fila por obligacion de un cliente, con el saldo ya restado y la venta y la
-- unidad de negocio a la vista.
--
-- `security_invoker = true` es lo que hace segura la vista. SIN esa opcion
-- PostgreSQL ejecuta la consulta con los privilegios del DUENO de la vista
-- (superusuario), las politicas RLS de `sales`/`receivables` NO se evaluan y la
-- vista devolveria la cartera de todas las organizaciones. Es la diferencia
-- entre un resumen y una fuga de datos entre inquilinos, y por eso la vista se
-- apoya en las mismas politicas que ya protegen las tablas.
--
-- Las columnas de la venta y de la unidad se copian para que el listado no
-- necesite una segunda consulta por fila: una consulta, no N.
--
-- Los permisos que esta vista exige al que la lee, y por que
-- --------------------------------------------------------------
-- Las filas del cliente salen de `finance.sales` y `finance.receivables`, asi que
-- hacen falta `finance.sales.read` y `finance.receivables.read`. La unidad entra
-- con `left join`: `business_units_select` exige `org.read`, y con un `join`
-- interno un rol que pudiera leer la cartera pero no la unidad perderia la fila
-- ENTERA, con su saldo. Es peor mostrar el nombre de la unidad como null que
-- borrar dinero de la pantalla.
--
-- El filtro de anulaciones toca `finance.ledger_entries`, cuya politica exige
-- `finance.read`. Hoy los tres roles que tienen `finance.receivables.read`
-- tambien tienen `finance.read`, asi que el filtro funciona para todos; si
-- alguien otorgara `finance.receivables.read` sin `finance.read`, una venta
-- anulada volveria a aparecer como cartera abierta sin ningun error. Esa
-- dependencia queda fijada por prueba en `12_customer_financial_read_model`,
-- que falla si un rol puede leer cartera y no ledger.
-- ─────────────────────────────────────────────────────────────────────────────

create view finance.customer_receivables
with (security_invoker = true)
as
select
  r.organization_id,
  r.id as receivable_id,
  r.sale_id,
  s.customer_id,
  s.business_unit_id,
  bu.code as business_unit_code,
  bu.name as business_unit_name,
  s.invoice_number,
  s.sale_date,
  r.due_date,
  s.payment_method,
  r.original_amount,
  r.paid_amount,
  -- El saldo NUNCA es negativo: el CHECK de `receivables` ya impide que
  -- `paid_amount` pase de `original_amount`, y `greatest` es la red de seguridad
  -- para que un importe raro no produzca una cartera negativa en la pantalla.
  -- ADR-0003: el exceso de un pago es saldo a favor (2210), no deuda negativa.
  greatest(r.original_amount - r.paid_amount, 0) as balance,
  r.paid_at,
  s.created_at
from finance.receivables r
join finance.sales s
  on s.organization_id = r.organization_id
 and s.id = r.sale_id
left join core.business_units bu
  on bu.organization_id = s.organization_id
 and bu.id = s.business_unit_id
where not exists (
    -- Una venta anulada no se debe: su contra-asiento (ADR-0003) la revierte en
    -- el libro mayor, y `void_sale` ademas impide anular una venta que ya tenga
    -- pagos. Sin este filtro su cartera apareceria como pendiente de algo que ya
    -- no ocurrio. El contra-asiento es la fuente, no una columna de estado.
    select 1
    from finance.ledger_entries le
    where le.organization_id = s.organization_id
      and le.source_type = 'finance.sales'
      and le.source_id = s.id
      and le.entry_type = 'reversal'
  );

comment on view finance.customer_receivables is
  'Cartera de un cliente: una fila por obligacion de finance.receivables, con su venta y unidad de negocio. Excluye ventas anuladas (contra-asiento reversal, ADR-0003). `balance` se deriva al leer; RLS de las tablas subyacentes sigue aplicando (security_invoker).';

-- El indice que esta consulta necesita, y POR QUE va en la tabla y no en la vista.
--
-- La consulta principal es "obligaciones de este cliente, mas antiguas primero", y
-- el filtro de cliente entra por `finance.sales.customer_id`, que no tiene indice
-- propio: los de ventas son por organizacion y fecha. El indice parcial
-- `receivables_open` ayuda a `receivables`, pero no a encontrar la venta.
--
-- La tentacion es indexar la vista, y PostgreSQL la rechaza:
-- `cannot create index on relation ... (SQLSTATE 42809) / This operation is not
-- supported for views`. Los indices solo se crean sobre vistas MATERIALIZADAS. Asi
-- que el indice se pone en `sales`, que es la tabla que realmente se lee, y la
-- vista se apoya en el como cualquier otra consulta. Un indice sobre una vista no
-- serviria de nada ademas: no se usa cuando el planificador incrusta la vista en
-- un join, que es justo lo que hace aqui.
create index sales_customer on finance.sales (organization_id, customer_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- finance.customer_payments
--
-- Los abonos que el cliente ha hecho, con la obligacion que cada uno saldo y la
-- UNIDAD DE NEGOCIO de la VENTA, no la del pago.
--
-- Por que la unidad de la venta y no la del pago: `register_payment` recibe
-- `p_business_unit_id` del llamador y reparte el importe con FIFO por `due_date`
-- de TODA la organizacion, sin filtro de unidad ni de cliente. Un pago hecho
-- desde la unidad B puede saldar la cartera de una venta de la unidad A. Si el
-- saldo se atribuyera a la unidad del PAGO, el saldo de un cliente apareceria en
-- el negocio equivocado justo cuando se paga desde otro. La obligacion pertenece
-- a la venta, y es la venta la que define que negocio espera ese dinero.
--
-- `paid_amount` en `receivables` es el saldo; esta vista es la que explica POR
-- QUE quedo asi: que abono entro, cuando y por cuanto.
--
-- Un pago puede tocar varias obligaciones y varias unidades: por eso `amount`
-- es lo aplicado a ESA obligacion, no el total del pago. `payment_amount` deja
-- ver el tamano real para que el sobrante a favor (2210) siga siendo visible.
--
-- `direction` no se filtra: `register_payment` rechaza con 22023 asignar un tipo
-- de deuda que no corresponda, asi que `allocation_type = 'receivable'` ya
-- implica `direction = 'inbound'`. Es un invariante de la funcion, no una
-- coincidencia.
-- ─────────────────────────────────────────────────────────────────────────────

create view finance.customer_payments
with (security_invoker = true)
as
select
  a.organization_id,
  s.customer_id,
  p.id as payment_id,
  p.payment_date,
  p.method,
  p.amount as payment_amount,
  p.unapplied_amount,
  p.description,
  -- Lo que este pago realmente aplico a la obligacion del cliente.
  a.amount as applied_amount,
  r.id as receivable_id,
  r.sale_id,
  s.business_unit_id,
  bu.code as business_unit_code,
  bu.name as business_unit_name,
  s.invoice_number,
  r.due_date,
  p.created_at
from finance.payment_allocations a
join finance.payments p
  on p.organization_id = a.organization_id
 and p.id = a.payment_id
join finance.receivables r
  on r.organization_id = a.organization_id
 and r.id = a.allocation_id
join finance.sales s
  on s.organization_id = r.organization_id
 and s.id = r.sale_id
left join core.business_units bu
  on bu.organization_id = s.organization_id
 and bu.id = s.business_unit_id
where a.allocation_type = 'receivable'
  and not exists (
    select 1
    from finance.ledger_entries le
    where le.organization_id = s.organization_id
      and le.source_type = 'finance.sales'
      and le.source_id = s.id
      and le.entry_type = 'reversal'
  );

comment on view finance.customer_payments is
  'Abonos de un cliente: una fila por pago aplicado a una obligacion suya. La unidad de negocio es la de la VENTA (la que espera el dinero), no la del pago, que puede venir de otra unidad.';

-- Sin indice propio: esta vista tambien filtra por `sales.customer_id`, asi que la
-- apoya en `sales_customer`, y el orden por fecha en `payments_period`
-- (`organization_id, payment_date, direction`), que ya existe. Indexar vistas no
-- es una opcion (vease el comentario de `sales_customer` mas arriba).

-- ─────────────────────────────────────────────────────────────────────────────
-- finance.customer_financial_summary
--
-- Por que una FUNCION y no una vista mas: "vencidas" y "antiguedad de la deuda"
-- dependen de HOY, y HOY lo decide la app, no la base (ADR-0012). Una vista no
-- recibe parametros, asi que para contarlas habria que usar `current_date` (la
-- fecha del SERVIDOR, que no es la fecha de negocio) o traer la cartera entera
-- al cliente y filtrarla alli, que es justamente lo que no se quiere. La funcion
-- recibe `p_today` explicito.
--
-- Consolida POR UNIDAD DE NEGOCIO, nunca mezclando granjas (ADR-0004): devuelve
-- una fila por unidad mas una fila `is_consolidated = true` con la suma, para que
-- la interfaz pueda mostrar el total del cliente SIN esconder de que negocio es.
-- El total es la suma de las filas de unidades, no un agregado aparte.
--
-- SECURITY INVOKER explicito: hereda el RLS de `finance.sales`,
-- `finance.customer_receivables` y `core.business_units` tal cual. Con
-- `security definer` esta funcion devolveria la cartera de la organizacion
-- equivocada sin ningun error visible.
--
-- Que incluye y que no, para que los numeros no se malinterpreten
-- ---------------------------------------------------------------
-- - `total_sold` son TODAS las ventas no anuladas, de contado y de credito.
-- - `total_paid` es lo cobrado CONTRA ventas a credito. Una venta de contado se
--   liquida en el acto y nunca genera `receivables`, asi que no tiene donde
--   registrar un cobro: contarla otra vez aqui seria inventar un segundo pago.
-- - Las ventas anuladas no cuentan en ninguna cifra: su contra-asiento ya las
--   revirtió en el libro (ADR-0003).
-- - `open_count`, `partial_count` y `overdue_count` NO son categorias
--   disjuntas: una obligacion a medio pagar y vencida cuenta en las tres. Por eso
--   `open_count` es "todavia debe algo" (incluye las parciales) y `paid_count` es
--   su complemento. Sumarlos entre si contaria dinero dos veces.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function finance.customer_financial_summary(
  p_customer_id uuid,
  p_today date
)
returns table (
  organization_id uuid,
  business_unit_id uuid,
  business_unit_code text,
  business_unit_name text,
  is_consolidated boolean,
  sales_count bigint,
  cash_sales_count bigint,
  credit_sales_count bigint,
  receivable_count bigint,
  open_count bigint,
  partial_count bigint,
  overdue_count bigint,
  paid_count bigint,
  total_sold numeric(18, 2),
  cash_sales_total numeric(18, 2),
  credit_billed numeric(18, 2),
  total_paid numeric(18, 2),
  outstanding numeric(18, 2),
  overdue_outstanding numeric(18, 2),
  oldest_open_due_date date
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- `p_today` decide cuantas obligaciones estan vencidas. Sin ella
  -- `due_date < null` es NULL, el filtro no trae nada, y el resumen afirmaria
  -- "0 vencidas" con la misma calma que si el cliente estuviera al dia. Es un
  -- error de quien llama, no del dato, asi que se responde con un error claro
  -- en vez de un numero conveniente.
  if p_today is null then
    raise exception 'Se requiere la fecha de negocio para resumir la cartera'
      using errcode = '22023';
  end if;

  return query
with customer_sales as (
  select
    s.business_unit_id,
    s.payment_method,
    s.total
  from finance.sales s
  where s.customer_id = p_customer_id
    and not exists (
      select 1
      from finance.ledger_entries le
      where le.organization_id = s.organization_id
        and le.source_type = 'finance.sales'
        and le.source_id = s.id
        and le.entry_type = 'reversal'
    )
),
sales_agg as (
  select
    cs.business_unit_id,
    count(*) as sales_count,
    count(*) filter (where cs.payment_method <> 'credit') as cash_sales_count,
    count(*) filter (where cs.payment_method = 'credit') as credit_sales_count,
    sum(cs.total) as total_sold,
    sum(cs.total) filter (where cs.payment_method <> 'credit') as cash_sales_total
  from customer_sales cs
  group by cs.business_unit_id
),
receivables_agg as (
  select
    cr.business_unit_id,
    count(*) as receivable_count,
    count(*) filter (where cr.balance > 0) as open_count,
    count(*) filter (where cr.balance > 0 and cr.paid_amount > 0) as partial_count,
    count(*) filter (where cr.balance > 0 and cr.due_date < p_today) as overdue_count,
    count(*) filter (where cr.balance = 0) as paid_count,
    sum(cr.original_amount) as credit_billed,
    sum(cr.paid_amount) as total_paid,
    sum(cr.balance) as outstanding,
    sum(cr.balance) filter (where cr.balance > 0 and cr.due_date < p_today)
      as overdue_outstanding,
    min(cr.due_date) filter (where cr.balance > 0) as oldest_open_due_date
  from finance.customer_receivables cr
  where cr.customer_id = p_customer_id
  group by cr.business_unit_id
),
per_unit as (
  -- El `left join` parte de las ventas porque toda obligacion de credito nace de
  -- una venta no anulada, y el filtro de anulaciones es el mismo en los dos
  -- lados: cada obligacion visible tiene su venta visible y su unidad tambien.
  select
    sa.business_unit_id,
    sa.sales_count,
    sa.cash_sales_count,
    sa.credit_sales_count,
    sa.total_sold,
    sa.cash_sales_total,
    coalesce(ra.receivable_count, 0) as receivable_count,
    coalesce(ra.open_count, 0) as open_count,
    coalesce(ra.partial_count, 0) as partial_count,
    coalesce(ra.overdue_count, 0) as overdue_count,
    coalesce(ra.paid_count, 0) as paid_count,
    coalesce(ra.credit_billed, 0) as credit_billed,
    coalesce(ra.total_paid, 0) as total_paid,
    coalesce(ra.outstanding, 0) as outstanding,
    coalesce(ra.overdue_outstanding, 0) as overdue_outstanding,
    ra.oldest_open_due_date
  from sales_agg sa
  left join receivables_agg ra on ra.business_unit_id = sa.business_unit_id
),
summary as (
  -- `grouping sets` da las filas por unidad y la consolidada en UNA sola pasada.
  -- `grouping(...) = 1` marca la fila consolidada; es el unico modo de saber si
  -- un `business_unit_id` null es "sin unidad" o "todas las unidades".
  select
    (select private.current_organization_id()) as organization_id,
    case when grouping(pu.business_unit_id) = 1 then null else pu.business_unit_id end
      as business_unit_id,
    case when grouping(pu.business_unit_id) = 1 then null else bu.code end
      as business_unit_code,
    case when grouping(pu.business_unit_id) = 1 then null else bu.name end
      as business_unit_name,
    grouping(pu.business_unit_id) = 1 as is_consolidated,
    -- `sum()` de un bigint devuelve numeric; los conteos se devuelven enteros.
    --
    -- El `coalesce` no es cosmetico. Un cliente sin ventas deja `per_unit` vacio, y
    -- `group by ()` sobre una entrada vacia produce UNA fila, no cero: es el
    -- conjunto de agrupacion constante, y `sum()` de nada es NULL. Sin el
    -- `coalesce` ese cliente recibia un resumen con el saldo en NULL, que obliga a
    -- la interfaz a inventar un caso que no existe. Cero es la respuesta honesta a
    -- "no debe nada", y el `()` de `grouping sets` ya garantiza que la fila
    -- consolidada exista siempre: por eso no hace falta una fila de ceros aparte.
    coalesce(sum(pu.sales_count), 0)::bigint as sales_count,
    coalesce(sum(pu.cash_sales_count), 0)::bigint as cash_sales_count,
    coalesce(sum(pu.credit_sales_count), 0)::bigint as credit_sales_count,
    coalesce(sum(pu.receivable_count), 0)::bigint as receivable_count,
    coalesce(sum(pu.open_count), 0)::bigint as open_count,
    coalesce(sum(pu.partial_count), 0)::bigint as partial_count,
    coalesce(sum(pu.overdue_count), 0)::bigint as overdue_count,
    coalesce(sum(pu.paid_count), 0)::bigint as paid_count,
    coalesce(sum(pu.total_sold), 0)::numeric(18, 2) as total_sold,
    coalesce(sum(pu.cash_sales_total), 0)::numeric(18, 2) as cash_sales_total,
    coalesce(sum(pu.credit_billed), 0)::numeric(18, 2) as credit_billed,
    coalesce(sum(pu.total_paid), 0)::numeric(18, 2) as total_paid,
    coalesce(sum(pu.outstanding), 0)::numeric(18, 2) as outstanding,
    coalesce(sum(pu.overdue_outstanding), 0)::numeric(18, 2) as overdue_outstanding,
    -- Sin `coalesce` a proposito: si no hay deuda abierta no hay una fecha mas
    -- antigua que buscar, y `null` dice eso. Cero seria una fecha de mentira.
    min(pu.oldest_open_due_date) as oldest_open_due_date
  from per_unit pu
  left join core.business_units bu
    on bu.organization_id = (select private.current_organization_id())
   and bu.id = pu.business_unit_id
  group by grouping sets ((pu.business_unit_id, bu.code, bu.name), ())
)
-- Un cliente sin historial devuelve su fila consolidada en cero (gracias al
-- `coalesce` de arriba): la interfaz no tiene que distinguir "sin datos" de
-- "no se consulto".
select * from summary;
end;
$$;

comment on function finance.customer_financial_summary(uuid, date) is
  'Resumen financiero de un cliente: una fila por unidad de negocio y una fila consolidada (is_consolidated). Las cifras se derivan en PostgreSQL. p_today es la fecha de NEGOCIO que decide la app (ADR-0012), nunca current_date. total_paid es lo cobrado contra ventas a credito: las ventas de contado se liquidan en el acto y no generan cartera.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos
--
-- `revoke` antes de `grant`: un `grant` futuro sobre el esquema no debe ampliar
-- lo que este rol puede hacer aqui por accidente. `anon` no lee la cartera de
-- nadie; se queda sin `execute` y sin `select`.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on finance.customer_receivables, finance.customer_payments from anon, authenticated;

grant select on finance.customer_receivables to authenticated;
grant select on finance.customer_payments to authenticated;

revoke all on function finance.customer_financial_summary(uuid, date) from anon, authenticated;

grant execute on function finance.customer_financial_summary(uuid, date) to authenticated;
