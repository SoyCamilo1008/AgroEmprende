/**
 * Pruebas del repositorio de cartera, historial y resumen del cliente.
 *
 * Que se prueba aqui, y que NO
 * ----------------------------
 * Aqui se prueba lo que es CODIGO NUESTRO: que columnas se piden, que filtros se
 * mandan, como se convierte un `numeric` de PostgreSQL a `Money`, y que un dato
 * ausente o con la forma equivocada FALLA en vez de pasar como `undefined`.
 *
 * No se prueba que RLS filtre por organizacion, que `anon` no lea, ni que el ledger
 *derive las cifras: son propiedades de PostgreSQL, y las mide
 * `supabase/tests/12_customer_financial_read_model.test.sql` y
 * `supabase/tests/13_customer_sales_history.test.sql` contra una base real, en el
 * job de migraciones del CI. Un test con este doble que "probara" aislamiento no
 * probaria nada: el doble devolveria exactamente lo que se le dijo.
 *
 * La separacion importa tambien por lo contrario: si una prueba de este archivo
 * comprobara que "el saldo es 16000", estaria affirmando algo que decide la vista, y
 * el dia que cambie el SQL el test pasaria mientras la pantalla mintiera.
 */
import { describe, expect, it } from 'vitest';
import { isDomainError } from '../src/errors';
import { CustomerFinanceRepository } from '../src/repositories/customer-finance';
import {
  consolidatedSummaryRow,
  createFakeSupabase,
  paymentRow,
  receivableRow,
  saleRow,
  summaryRow,
  type RecordedCall,
} from './helpers/fakeSupabase';

const TODAY = '2026-06-10';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const BUSINESS_UNIT_ID = '44444444-4444-4444-8444-444444444444';

/** El filtro de una columna con su operador, para afirmar sobre el. */
const comparison = (call: RecordedCall, column: string, operator: string, value: unknown) =>
  call.comparisons.find(([c, op, v]) => c === column && op === operator && v === value);

/** Los valores de una columna, en el orden en que se mandaron. */
const valuesOf = (call: RecordedCall, column: string) =>
  call.filters.filter(([c]) => c === column).map(([, v]) => v);

const repo = (...responses: Parameters<typeof createFakeSupabase>) => {
  const fake = createFakeSupabase(...responses);
  return { fake, repository: new CustomerFinanceRepository(fake.client) };
};

describe('CustomerFinanceRepository', () => {
  describe('getSummary', () => {
    it('llama a la funcion del resumen pasando la fecha de negocio de la app', async () => {
      const { fake, repository } = repo({ data: [summaryRow(), consolidatedSummaryRow()] });

      await repository.getSummary(CUSTOMER_ID, TODAY);

      const call = fake.lastCall();
      expect(call.schema).toBe('finance');
      expect(call.op).toBe('rpc');
      expect(call.rpcName).toBe('customer_financial_summary');
      // La fecha viaja como parametro, no como filtro: si la base decidiera con
      // `current_date`, el mismo cliente saldria al dia en un servidor y vencido en
      // otro (ADR-0012).
      expect(call.rpcParams).toEqual({ p_customer_id: CUSTOMER_ID, p_today: TODAY });
    });

    it('separa la fila consolidada de las de cada unidad', async () => {
      const { repository } = repo({ data: [summaryRow(), consolidatedSummaryRow()] });

      const summary = await repository.getSummary(CUSTOMER_ID, TODAY);

      expect(summary.rows).toHaveLength(2);
      expect(summary.consolidated?.isConsolidated).toBe(true);
      // La consolidada se busca por `isConsolidated`, no por `businessUnit === null`:
      // "sin unidad" y "todas las unidades" no son lo mismo.
      expect(summary.consolidated?.businessUnit).toBeNull();
      expect(summary.rows[0]?.businessUnit).toEqual({
        id: BUSINESS_UNIT_ID,
        code: 'PONEDORAS',
        name: 'Ponederas',
      });
    });

    it('convierte los importes de pesos a centavos', async () => {
      const { repository } = repo({ data: [summaryRow(), consolidatedSummaryRow()] });

      const summary = await repository.getSummary(CUSTOMER_ID, TODAY);
      const row = summary.rows[0];

      // 16000 pesos son 1.600.000 centavos. Si la conversion no ocurriera, el saldo
      // se veria 100 veces mas pequeno y seguiria siendo un numero plausible.
      expect(row?.outstanding).toBe(1_600_000);
      expect(row?.totalSold).toBe(3_000_000);
      expect(row?.totalPaid).toBe(400_000);
      expect(row?.overdueOutstanding).toBe(1_600_000);
      expect(row?.oldestOpenDueDate).toBe('2026-05-01');
    });

    it('devuelve una fila consolidada en cero para un cliente sin historial', async () => {
      const { repository } = repo({
        data: [
          // Sin historial la vista devuelve los conteos en cero y
          // `min(due_date) FILTER (...)` en `NULL`: no hay nada que minimizar. Por eso
          // el `coalesce` de los importes y NO el de la fecha.
          consolidatedSummaryRow({
            sales_count: 0,
            receivable_count: 0,
            open_count: 0,
            overdue_count: 0,
            total_sold: '0.00',
            outstanding: '0.00',
            total_paid: '0.00',
            oldest_open_due_date: null,
          }),
        ],
      });

      const summary = await repository.getSummary(CUSTOMER_ID, TODAY);

      expect(summary.rows).toHaveLength(1);
      expect(summary.consolidated?.outstanding).toBe(0);
      // Sin deuda abierta no hay una fecha mas antigua que buscar, y `null` lo dice.
      expect(summary.consolidated?.oldestOpenDueDate).toBeNull();
    });

    it('avisa cuando la base devuelve filas pero ninguna consolidada', async () => {
      const { repository } = repo({ data: [summaryRow()] });

      await expect(repository.getSummary(CUSTOMER_ID, TODAY)).rejects.toMatchObject({
        kind: 'database',
      });
    });

    it('rechaza una fecha de negocio que no es YYYY-MM-DD', async () => {
      const { fake, repository } = repo({ data: [] });

      await expect(
        repository.getSummary(CUSTOMER_ID, '2026-06-10T00:00:00.000Z'),
      ).rejects.toMatchObject({ kind: 'validation' });
      // No se consultó nada: una fecha mala se para en la puerta, no se manda a
      // PostgreSQL a descobrir que no casa con ninguna fecha de vencimiento.
      expect(fake.calls).toHaveLength(0);
    });

    it('traduce el error de PostgREST', async () => {
      const { repository } = repo({ error: { code: '42501', message: 'sin permiso' } });

      await expect(repository.getSummary(CUSTOMER_ID, TODAY)).rejects.toMatchObject({
        kind: 'authorization',
      });
    });
  });

  describe('listReceivables', () => {
    it('filtra por cliente y pide solo lo que tiene saldo', async () => {
      const { fake, repository } = repo({ data: [receivableRow()], count: 1 });

      await repository.listReceivables(CUSTOMER_ID, { today: TODAY });

      const call = fake.lastCall();
      expect(call.schema).toBe('finance');
      expect(call.table).toBe('customer_receivables');
      expect(valuesOf(call, 'customer_id')).toEqual([CUSTOMER_ID]);
      // `balance > 0` va en SQL. Traer la cartera entera y descartar en el movil lo
      // pagado seria descargar por el cable justo lo que se pidio no descargar.
      expect(comparison(call, 'balance', 'gt', 0)).toBeDefined();
    });

    it('deriva estado, etiqueta y dias de atraso con la fecha de la app', async () => {
      const { repository } = repo({
        data: [receivableRow({ due_date: '2026-05-01', paid_amount: '4000.00' })],
      });

      const page = await repository.listReceivables(CUSTOMER_ID, { today: TODAY });
      const item = page.items[0];

      // Vencio el 2026-05-01 y hoy es 2026-06-10: 40 dias.
      expect(item?.status).toBe('overdue');
      expect(item?.statusLabel).toBe('VENCIDA');
      expect(item?.daysOverdue).toBe(40);
      // El saldo llega en pesos y sale en centavos.
      expect(item?.balance).toBe(1_600_000);
      expect(item?.paidAmount).toBe(400_000);
      expect(item?.originalAmount).toBe(2_000_000);
    });

    it('distingue una obligacion parcial de una vencida y de una liquidada', async () => {
      const { repository } = repo({
        data: [
          // Parcial, sin vencer.
          receivableRow({
            receivable_id: 'a1111111-1111-4111-8111-111111111111',
            due_date: '2026-06-30',
            paid_amount: '1000.00',
            balance: '19000.00',
          }),
          // Vencida y liquidada: `balance = 0` gana a la fecha, esta PAGADA.
          receivableRow({
            receivable_id: 'a2222222-2222-4222-8222-222222222222',
            due_date: '2026-04-01',
            paid_amount: '20000.00',
            balance: '0.00',
            paid_at: '2026-05-02T15:04:05.000Z',
          }),
        ],
      });

      const page = await repository.listReceivables(CUSTOMER_ID, { today: TODAY });

      expect(page.items[0]?.status).toBe('partial');
      expect(page.items[0]?.statusLabel).toBe('PARCIAL');
      expect(page.items[0]?.daysOverdue).toBe(0);
      expect(page.items[1]?.status).toBe('paid');
      expect(page.items[1]?.statusLabel).toBe('PAGADA');
      expect(page.items[1]?.paidAt).toBe('2026-05-02T15:04:05.000Z');
    });

    it('filtra las vencidas con `due_date < today`, no con `<=`', async () => {
      const { fake, repository } = repo({ data: [] });

      await repository.listOverdueReceivables(CUSTOMER_ID, { today: TODAY });

      const call = fake.lastCall();
      // `<` y no `<=`: lo que vence HOY todavia tiene el dia, y contarlo como
      // vencido seria protestar un dia antes de tiempo.
      expect(comparison(call, 'due_date', 'lt', TODAY)).toBeDefined();
      expect(comparison(call, 'due_date', 'lte', TODAY)).toBeUndefined();
    });

    it('filtra por unidad de negocio, que es un filtro de datos y no de permiso', async () => {
      const { fake, repository } = repo({ data: [] });

      await repository.listOpenReceivables(CUSTOMER_ID, {
        today: TODAY,
        businessUnitId: BUSINESS_UNIT_ID,
      });

      // Filtrar por unidad NO autoriza: quien puede ver es RLS. Por eso la consulta
      // no lleva `organization_id`, que es contexto y no dato.
      expect(valuesOf(fake.lastCall(), 'business_unit_id')).toEqual([BUSINESS_UNIT_ID]);
      expect(valuesOf(fake.lastCall(), 'organization_id')).toEqual([]);
    });

    it('ordena por vencimiento, que es lo que vence primero', async () => {
      const { fake, repository } = repo({ data: [] });

      await repository.listReceivables(CUSTOMER_ID, { today: TODAY });

      expect(fake.lastCall().orders).toEqual([['due_date', true]]);
    });

    it('cae a `due_date` si le piden una columna que no existe en la lista cerrada', async () => {
      const { fake, repository } = repo({ data: [] });

      // Sin lista cerrada, un valor que venga de una query string llegaria dentro
      // del `order=` de PostgREST sin revisar, que es donde se inyectan filtros.
      await repository.listReceivables(CUSTOMER_ID, {
        today: TODAY,
        sortBy: 'balance; drop table core.customers' as never,
      });

      expect(fake.lastCall().orders).toEqual([['due_date', true]]);
    });

    it('pagina y devuelve el total real de filas', async () => {
      const { fake, repository } = repo({ data: [receivableRow()], count: 137 });

      const page = await repository.listReceivables(CUSTOMER_ID, {
        today: TODAY,
        limit: 10,
        offset: 20,
      });

      expect(page.total).toBe(137);
      expect(page.limit).toBe(10);
      expect(page.offset).toBe(20);
      expect(fake.lastCall().range).toEqual([20, 29]);
    });

    it('no trae las liquidadas, porque la cartera es lo que se debe', async () => {
      const { fake, repository } = repo({
        data: [
          receivableRow({
            balance: '0.00',
            paid_amount: '20000.00',
            paid_at: '2026-05-02T00:00:00.000Z',
          }),
        ],
      });

      await repository.listReceivables(CUSTOMER_ID, { today: TODAY });

      // El filtro va en la consulta, no en el mapeo: si una liquidada llegara y se
      // descartara al mapear, el `total` de PostgREST la contaria y la suma de la
      // lista no cuadraria con el total de arriba.
      expect(comparison(fake.lastCall(), 'balance', 'gt', 0)).toBeDefined();
    });

    it('un rango invertido da una lista vacia, no un error', async () => {
      const { fake, repository } = repo({ data: [] });

      const page = await repository.listSales(CUSTOMER_ID, {
        today: TODAY,
        dateFrom: '2026-06-30',
        dateTo: '2026-01-01',
      });

      // Del 30 de junio al 1 de enero no hay nada que ver. Romper el selector de
      // fechas cuando el usuario se equivoca es peor que mostrarle un cero.
      expect(page.items).toEqual([]);
      // Se consulta igual: `gte`/`lte` incompatibles no casan con ninguna fila y la
      // base responde con un cero limpio, sin que haya que adivinarlo en el movil.
      expect(comparison(fake.lastCall(), 'sale_date', 'gte', '2026-06-30')).toBeDefined();
      expect(comparison(fake.lastCall(), 'sale_date', 'lte', '2026-01-01')).toBeDefined();
    });

    it('acota un limit absurdo en vez de obeyecerlo', async () => {
      const { repository } = repo({ data: [] });

      const page = await repository.listReceivables(CUSTOMER_ID, { today: TODAY, limit: 100_000 });

      // `max_rows = 1000`: pedir mas no da mas datos, solo hace mas lenta la consulta.
      expect(page.limit).toBe(1000);
    });
  });

  describe('listSales', () => {
    it('trae el historial con la marca de anulacion, de mas reciente a mas antigua', async () => {
      const { fake, repository } = repo({ data: [saleRow()] });

      await repository.listSales(CUSTOMER_ID, { today: TODAY });

      const call = fake.lastCall();
      expect(call.table).toBe('customer_sales');
      expect(valuesOf(call, 'customer_id')).toEqual([CUSTOMER_ID]);
      expect(call.orders).toEqual([['sale_date', false]]);
      // Por defecto NO se filtran las anuladas: la contabilidad es append-only y el
      // historial tiene que contar que se emitio y luego se reverso.
      expect(valuesOf(call, 'is_voided')).toEqual([]);
    });

    it('trae las anuladas en el historial y las marca, no las borra', async () => {
      const { repository } = repo({ data: [saleRow({ is_voided: true })] });

      const page = await repository.listSales(CUSTOMER_ID, { today: TODAY });

      expect(page.items[0]?.isVoided).toBe(true);
      expect(page.items[0]?.total).toBe(2_000_000);
      expect(page.items[0]?.invoiceNumber).toBe('FV-0001');
    });

    it('excluye las anuladas solo cuando se lo piden', async () => {
      const { fake, repository } = repo({ data: [] });

      await repository.listSales(CUSTOMER_ID, { today: TODAY, includeVoided: false });

      expect(valuesOf(fake.lastCall(), 'is_voided')).toEqual([false]);
    });

    it('acepta ventas de contado, que no tienen vencimiento', async () => {
      const { repository } = repo({
        data: [saleRow({ due_date: null, payment_method: 'cash', total: '10000.00' })],
      });

      const page = await repository.listSales(CUSTOMER_ID, { today: TODAY });

      // `null` y no una fecha inventada: no hay cartera, y sin vencimiento se pierde
      // la antiguedad.
      expect(page.items[0]?.dueDate).toBeNull();
      expect(page.items[0]?.total).toBe(1_000_000);
      expect(page.items[0]?.paymentMethod).toBe('cash');
    });

    it('el rango de fechas es inclusivo en los dos extremos', async () => {
      const { fake, repository } = repo({ data: [] });

      await repository.listSales(CUSTOMER_ID, {
        today: TODAY,
        dateFrom: '2026-01-01',
        dateTo: '2026-06-30',
      });

      const call = fake.lastCall();
      // `gte`/`lte`, no `gt`/`lt`: un selector de fechas que se comiera el ultimo
      // dia daria una lista mas corta sin que nadie sospeche que falta informacion.
      expect(comparison(call, 'sale_date', 'gte', '2026-01-01')).toBeDefined();
      expect(comparison(call, 'sale_date', 'lte', '2026-06-30')).toBeDefined();
    });

    it('rechaza un rango con una fecha que no existe', async () => {
      const { fake, repository } = repo({ data: [] });

      await expect(
        repository.listSales(CUSTOMER_ID, { today: TODAY, dateFrom: 'ayer' }),
      ).rejects.toMatchObject({ kind: 'validation' });
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe('listPayments', () => {
    it('filtra por la unidad de la venta, no por la del pago', async () => {
      const { fake, repository } = repo({ data: [] });

      await repository.listPayments(CUSTOMER_ID, {
        today: TODAY,
        businessUnitId: BUSINESS_UNIT_ID,
      });

      const call = fake.lastCall();
      expect(call.table).toBe('customer_payments');
      // `register_payment` aplica los abonos por vencimiento a lo largo de toda la
      // organizacion: un abono hecho en PONEDORAS puede saldar una deuda de CERDOS.
      // La cartera que se filtra es la de la VENTA, que es la que expone la vista.
      expect(valuesOf(call, 'business_unit_id')).toEqual([BUSINESS_UNIT_ID]);
    });

    it('distingue el abono aplicado del saldo a favor', async () => {
      const { repository } = repo({
        data: [
          paymentRow({
            payment_amount: '5000.00',
            applied_amount: '4000.00',
            unapplied_amount: '1000.00',
          }),
        ],
      });

      const page = await repository.listPayments(CUSTOMER_ID, { today: TODAY });
      const item = page.items[0];

      expect(item?.amount).toBe(500_000);
      expect(item?.appliedAmount).toBe(400_000);
      // El exceso es saldo a favor, NUNCA deuda negativa: se informa aparte.
      expect(item?.unappliedAmount).toBe(100_000);
      expect(item?.paymentDate).toBe('2026-04-15');
    });

    it('filtra el rango por la fecha de negocio del pago', async () => {
      const { fake, repository } = repo({ data: [] });

      await repository.listPayments(CUSTOMER_ID, { today: TODAY, dateFrom: '2026-04-01' });

      const call = fake.lastCall();
      // Por `payment_date` y no por `created_at`: el dueño pregunta "cuando pagó",
      // no "cuando se registró el pago" (ADR-0012).
      expect(comparison(call, 'payment_date', 'gte', '2026-04-01')).toBeDefined();
      expect(call.orders).toEqual([['payment_date', false]]);
    });
  });

  describe('cuando la base no trae la forma esperada', () => {
    it('falla si un importe llega como algo que no es un numero', async () => {
      const { repository } = repo({ data: [receivableRow({ balance: 'mucho' })] });

      // Un drift de esquema debe ser un error visible, no un `NaN` disfrazado de
      // saldo que llega a la pantalla.
      await expect(repository.listReceivables(CUSTOMER_ID, { today: TODAY })).rejects.toSatisfy(
        (error: unknown) => isDomainError(error) && error.kind === 'database',
      );
    });

    it('falla si la unidad llega sin codigo ni nombre', async () => {
      const { repository } = repo({
        data: [receivableRow({ business_unit_code: null, business_unit_name: null })],
      });

      const page = await repository.listReceivables(CUSTOMER_ID, { today: TODAY });

      // Las cifras siguen viéndose y lo que falta es la ETIQUETA: una fila de dinero
      // que desaparece por no poder leer su nombre es peor que un nombre ausente.
      expect(page.items[0]?.businessUnit).toBeNull();
      expect(page.items[0]?.balance).toBe(1_600_000);
    });

    it('falla si el vencimiento no es una fecha de negocio', async () => {
      const { repository } = repo({ data: [receivableRow({ due_date: '2026-05-01T00:00:00Z' })] });

      await expect(repository.listReceivables(CUSTOMER_ID, { today: TODAY })).rejects.toSatisfy(
        (error: unknown) => isDomainError(error) && error.kind === 'database',
      );
    });

    it('devuelve una pagina vacia, no un error, si la base no devuelve filas', async () => {
      const { repository } = repo({ data: null });

      const page = await repository.listReceivables(CUSTOMER_ID, { today: TODAY });

      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });
  });
});
