/**
 * Repositorio de la lectura financiera del cliente: cartera, historial y resumen.
 *
 * Donde esta la frontera
 * ---------------------
 * Es el UNICO lugar donde Web y Mobile preguntan "que debe este cliente". Las
 * pantallas no arman consultas ni derivan saldos: piden datos.
 *
 * Las cuatro reglas que este archivo respeta
 * -----------------------------------------
 * 1. RLS manda. Ninguna consulta filtra por `organization_id` a mano. Las lecturas
 *    van a vistas con `security_invoker = true` y a una funcion `security invoker`,
 *    asi que las politicas de `sales`, `receivables`, `payments` y `ledger_entries`
 *    se evaluan con los permisos de quien pregunta. Un `.eq('organization_id', ...)`
 *    "por seguridad" daria la falsa impresion de que el filtro es la defensa.
 * 2. `today` la pasa la aplicacion, siempre. Es la fecha de NEGOCIO contra la que
 *    se decide que esta vencida (ADR-0012). Si se usara `current_date` en
 *    PostgreSQL o `new Date()` aqui, el mismo cliente saldria "al dia" en una
 *    granja y "vencido" en otra segun el reloj de cada servidor.
 * 3. El saldo no se calcula aqui. `balance`, `outstanding` y los conteos salen de
 *    `finance.customer_receivables` y de `finance.customer_financial_summary`, que
 *    los derivan de las tablas del libro mayor (ADR-0003). Este archivo mapea filas
 *    y convierte PESOS a CENTAVOS; no reimprime la aritmetica.
 * 4. `businessUnitId` filtra el dato, NO autoriza. Es la respuesta a "muéstrame solo
 *    PONEDORAS", no a "muéstrame solo lo que puedo ver". Quien puede ver es RLS.
 *
 * Lo que NO hace
 * --------------
 * No registra ventas, pagos ni anulaciones: eso es escritura y ya tiene sus
 * repositorios. Aqui solo se lee, y lo que se lee es DERIVADO. Si una pantalla
 * necesita modificar una deuda, la cartera no es su herramienta.
 */
import type {
  CustomerFinancialSummary,
  CustomerFinanceListOptions,
  CustomerFinancePage,
  CustomerId,
  CustomerPayment,
  CustomerReceivable,
  CustomerSale,
  IsoDate,
} from '@agroemprende/types';
import { isoDateSchema } from '@agroemprende/validation';
import type { SupabaseClient } from '@supabase/supabase-js';
import { domainError, translatePostgrestError } from '../errors';
import {
  mapCustomerPaymentRowToDomain,
  mapCustomerReceivableRowToDomain,
  mapCustomerSaleRowToDomain,
  mapCustomerSummaryRowToDomain,
} from '../rows';

/** Vistas y funcion de solo lectura del bloque financiero. */
const RECEIVABLES = 'customer_receivables';
const PAYMENTS = 'customer_payments';
const SALES = 'customer_sales';
const SUMMARY = 'customer_financial_summary';

/** Tamano de pagina por defecto, igual que el de clientes. */
export const DEFAULT_CUSTOMER_FINANCE_PAGE_SIZE = 50;

/**
 * Tope de una pagina. `supabase/config.toml` fija `max_rows = 1000`: pedir mas no
 * da mas datos, solo hace mas lenta la consulta y gasta memoria para una lista que
 * nadie recorre.
 */
export const MAX_CUSTOMER_FINANCE_PAGE_SIZE = 1000;

/** Columnas por las que se permite ordenar. Lista cerrada: no se pasa libre. */
export const RECEIVABLE_SORT_COLUMNS = ['due_date', 'balance', 'invoice_number'] as const;
export type ReceivableSortColumn = (typeof RECEIVABLE_SORT_COLUMNS)[number];

const isReceivableSortColumn = (value: unknown): value is ReceivableSortColumn =>
  typeof value === 'string' && (RECEIVABLE_SORT_COLUMNS as readonly string[]).includes(value);

/**
 * Resuelve la columna de orden contra la lista cerrada.
 *
 * El tipo `ReceivableSortColumn` desaparece al compilar, asi que un valor que venga
 * de JavaScript o de una query string llega igual. Sin esta comprobacion acabaria
 * dentro del `order=` de PostgREST sin revisar, que es donde se inyectan filtros.
 * Ante un valor no permitido se usa `due_date`: la cartera se ordena por lo que vence
 * primero, y una consulta manipulada no es un detalle de orden.
 */
const resolveSortColumn = (value: unknown): ReceivableSortColumn =>
  isReceivableSortColumn(value) ? value : 'due_date';

/** Opciones de la cartera: las abiertas, y opcionalmente solo las vencidas. */
export interface CustomerReceivablesOptions extends CustomerFinanceListOptions {
  readonly sortBy?: ReceivableSortColumn | undefined;
  readonly sortDir?: 'asc' | 'desc' | undefined;
  /**
   * `false` = solo las que ya pasaron su vencimiento a la fecha de negocio.
   *
   * El filtro va en SQL (`balance > 0 AND due_date < today`) y no en JavaScript: la
   * base ya sabe cuales son, traerlas todas para descartar la mitad en el movil
   * seria descargar por el cable lo que se pidio no descargar.
   */
  readonly overdueOnly?: boolean | undefined;
}

const normalizePage = (
  limit: number | undefined,
  offset: number | undefined,
): { limit: number; offset: number } => {
  const requestedLimit = limit ?? DEFAULT_CUSTOMER_FINANCE_PAGE_SIZE;
  const safeLimit = Number.isFinite(requestedLimit)
    ? Math.trunc(requestedLimit)
    : DEFAULT_CUSTOMER_FINANCE_PAGE_SIZE;
  const clampedLimit = Math.min(Math.max(safeLimit, 1), MAX_CUSTOMER_FINANCE_PAGE_SIZE);
  const requestedOffset = offset ?? 0;
  const safeOffset = Number.isFinite(requestedOffset) ? Math.trunc(requestedOffset) : 0;
  return { limit: clampedLimit, offset: Math.max(safeOffset, 0) };
};

/**
 * Valida la fecha de negocio.
 *
 * `today` es el parametro mas importante de este archivo y por eso se valida en la
 * puerta en vez de confiar en el tipo: `IsoDate` es `string`, asi que un `new Date()`
 * que alguien serialice a mano llegaria como `2026-06-10T00:00:00.000Z` y haria que
 * `due_date < today` fallara comparando una fecha con un instante. Sin este chequeo
 * el resumen dira "cero vencidas" con toda la calma del mundo.
 */
const parseToday = (value: unknown): IsoDate => {
  const parsed = isoDateSchema.safeParse(value);
  if (!parsed.success) {
    throw domainError('validation', 'La fecha de negocio no es válida', {
      details: parsed.error.issues,
    });
  }
  return parsed.data;
};

/**
 * Valida el rango de fechas si viene, con la misma regla que `today`.
 *
 * Un rango invertido no se rechaza: `dateFrom` posterior a `dateTo` se manda a la
 * base tal cual y no casa con ninguna fila, asi que la pantalla muestra una lista
 * vacia. Es la respuesta correcta a "quiero ver del 30 de junio al 1 de enero": no
 * hay datos, y una pantalla que se rompe al cambiar dos fechas de un selector es
 * peor que una lista vacia. La regla es la MISMA de `today` para que no exista una
 * fecha que una pantalla acepte y otra no.
 */
const parseOptionalDate = (value: unknown, field: string): IsoDate | undefined => {
  if (value === undefined || value === null) return undefined;
  const parsed = isoDateSchema.safeParse(value);
  if (!parsed.success) {
    throw domainError('validation', `El filtro "${field}" no es una fecha válida`, {
      details: parsed.error.issues,
    });
  }
  return parsed.data;
};

/**
 * Repositorio de la lectura financiera del cliente.
 *
 * Se construye con el `SupabaseClient` de la app, no con uno propio: ese cliente ya
 * trae la sesion (cookies en web, almacenamiento seguro en movil) y es el que envia
 * la cabecera `x-organization-id`, que es el contexto del que dependen las politicas.
 */
export class CustomerFinanceRepository {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.#client = client;
  }

  /** Las lecturas viven en el esquema `finance`. El tipo del builder se infiere. */
  get #finance(): ReturnType<SupabaseClient['schema']> {
    return this.#client.schema('finance');
  }

  /**
   * Resumen del cliente: una fila por unidad y la consolidada, en UNA consulta.
   *
   * `p_today` viaja como parametro de la funcion, no como filtro, porque la funcion
   * lo necesita para decide que esta vencido y porque asi el planificador puede
   * contarlo en PostgreSQL en vez de traer cada obligacion para sumarla aqui.
   *
   * Un cliente sin ventas devuelve UNA fila consolidada en cero, no cero filas: la
   * interfaz no tiene que distinguir "no debe nada" de "no se pudo consultar".
   */
  async getSummary(customerId: CustomerId, today: IsoDate): Promise<CustomerFinancialSummary> {
    const businessToday = parseToday(today);

    try {
      const { data, error } = await this.#finance.rpc(SUMMARY, {
        p_customer_id: customerId,
        p_today: businessToday,
      });
      if (error !== null) throw error;

      const rows = (Array.isArray(data) ? data : []).map((row) =>
        mapCustomerSummaryRowToDomain(row),
      );
      // La consolidada se busca por `isConsolidated`, no por `businessUnit === null`:
      // "sin unidad" y "todas las unidades" son cosas distintas y confundirlas
      // hace que la app rotule "todas" con el id de una granja real.
      const consolidated = rows.find((row) => row.isConsolidated) ?? null;

      // Una respuesta sin fila consolidada no es un cliente sin deuda: es una base
      // que cambio el contrato. Se avisa en vez de devolver un resumen con la mitad
      // de los numeros, que es como un saldo se vuelve un misterio.
      if (consolidated === null && rows.length > 0) {
        throw domainError('database', 'El resumen del cliente vino sin su fila consolidada');
      }

      return { rows, consolidated };
    } catch (error) {
      throw translatePostgrestError(error);
    }
  }

  /**
   * Cartera del cliente: sus obligaciones ABIERTAS y su saldo.
   *
   * Solo lo que tiene saldo. Una obligacion liquidada no es cartera: no se debe, no
   * aparece en "me debe" y arrastrarla a la lista solo haria que el cliente "debe
   * menos" de lo que el total de la lista sugiere. El rastro de que esa venta se
   * saldó, y cuando, esta en `listSales` y `listPayments`, que son el historial.
   *
   * Para las vencidas se pasa `overdueOnly` o se llama a `listOverdueReceivables`.
   */
  async listReceivables(
    customerId: CustomerId,
    options: CustomerReceivablesOptions,
  ): Promise<CustomerFinancePage<CustomerReceivable>> {
    const today = parseToday(options.today);
    const { limit, offset } = normalizePage(options.limit, options.offset);

    try {
      let query = this.#finance
        .from(RECEIVABLES)
        .select('*', { count: 'exact' })
        .eq('customer_id', customerId)
        // `balance > 0` en SQL, no filtrando en JavaScript: la vista ya sabe
        // cuales tienen saldo, y traer todas para descartar en el movil es
        // descargar por el cable justo lo que se pidio no descargar.
        .gt('balance', 0)
        .order(resolveSortColumn(options.sortBy), {
          ascending: (options.sortDir ?? 'asc') === 'asc',
        })
        .range(offset, offset + limit - 1);

      if (options.businessUnitId !== undefined) {
        query = query.eq('business_unit_id', options.businessUnitId);
      }
      // Vencida a la fecha de negocio: `due_date < today`, que es la misma
      // comparacion que usa la funcion del resumen. Con `<=` una obligacion que
      // vence HOY contaria como vencida, y el que debe hoy todavia tiene el dia.
      if (options.overdueOnly === true) {
        query = query.lt('due_date', today);
      }

      const { data, error, count } = await query;
      if (error !== null) throw error;

      const items = (Array.isArray(data) ? data : []).map((row) =>
        mapCustomerReceivableRowToDomain(row, today),
      );
      return {
        items,
        total: typeof count === 'number' ? count : items.length,
        limit,
        offset,
      };
    } catch (error) {
      throw translatePostgrestError(error);
    }
  }

  /**
   * Historial de ventas del cliente, de la mas reciente a la mas antigua.
   */
  async listSales(
    customerId: CustomerId,
    options: CustomerFinanceListOptions & {
      /**
       * `true` (por defecto) trae tambien las ventas anuladas.
       *
       * La contabilidad es append-only (ADR-0003): la venta no desaparece al
       * anularse, y el historial de un cliente tiene que contar que se emitio y
       * luego se reverso. Quien solo quiera lo que suma al total lo filtra por
       * `isVoided` al presentar y no antes en la base: excluir las anuladas es una
       * decision de pantalla, y si viviera en la consulta un reporte que las
       * necesite no podria obtenerlas.
       */
      readonly includeVoided?: boolean | undefined;
    },
  ): Promise<CustomerFinancePage<CustomerSale>> {
    parseToday(options.today);
    const { limit, offset } = normalizePage(options.limit, options.offset);
    const dateFrom = parseOptionalDate(options.dateFrom, 'dateFrom');
    const dateTo = parseOptionalDate(options.dateTo, 'dateTo');

    try {
      let query = this.#finance
        .from(SALES)
        .select('*', { count: 'exact' })
        .eq('customer_id', customerId)
        .order('sale_date', { ascending: false })
        .range(offset, offset + limit - 1);

      if (options.businessUnitId !== undefined) {
        query = query.eq('business_unit_id', options.businessUnitId);
      }
      // `gte`/`lte`, no `gt`/`lt`: un filtro de rango que se comiera el ultimo dia
      // seria el peor fallo posible de un selector de fechas, porque el usuario ve
      // una lista mas corta y no tiene por que sospechar que falta informacion.
      if (dateFrom !== undefined) query = query.gte('sale_date', dateFrom);
      if (dateTo !== undefined) query = query.lte('sale_date', dateTo);
      if (options.includeVoided === false) {
        query = query.eq('is_voided', false);
      }

      const { data, error, count } = await query;
      if (error !== null) throw error;

      const items = (Array.isArray(data) ? data : []).map(mapCustomerSaleRowToDomain);
      return {
        items,
        total: typeof count === 'number' ? count : items.length,
        limit,
        offset,
      };
    } catch (error) {
      throw translatePostgrestError(error);
    }
  }

  /** Abonos aplicados a la cartera del cliente, del mas reciente al mas antiguo. */
  async listPayments(
    customerId: CustomerId,
    options: CustomerFinanceListOptions,
  ): Promise<CustomerFinancePage<CustomerPayment>> {
    parseToday(options.today);
    const { limit, offset } = normalizePage(options.limit, options.offset);
    const dateFrom = parseOptionalDate(options.dateFrom, 'dateFrom');
    const dateTo = parseOptionalDate(options.dateTo, 'dateTo');

    try {
      let query = this.#finance
        .from(PAYMENTS)
        .select('*', { count: 'exact' })
        .eq('customer_id', customerId)
        .order('payment_date', { ascending: false })
        .range(offset, offset + limit - 1);

      // El filtro de unidad va sobre la UNIDAD DE LA VENTA, que es la que expone
      // la vista, no sobre la del pago: un abono registrado en PONEDORAS puede
      // saldar una deuda de CERDOS, y la cartera que se quiere filtrar es la de
      // CERDOS.
      if (options.businessUnitId !== undefined) {
        query = query.eq('business_unit_id', options.businessUnitId);
      }
      if (dateFrom !== undefined) query = query.gte('payment_date', dateFrom);
      if (dateTo !== undefined) query = query.lte('payment_date', dateTo);

      const { data, error, count } = await query;
      if (error !== null) throw error;

      const items = (Array.isArray(data) ? data : []).map(mapCustomerPaymentRowToDomain);
      return {
        items,
        total: typeof count === 'number' ? count : items.length,
        limit,
        offset,
      };
    } catch (error) {
      throw translatePostgrestError(error);
    }
  }

  /**
   * Atajos que nombran la intencion de la pantalla.
   *
   * No ahorran consultas: delegan en `listReceivables` con un filtro distinto. Se
   * documentan porque `listReceivables({ overdueOnly: true })` obliga a quien lee a
   * recordar que `overdueOnly` existe, y "cartera vencida" es una pregunta de
   * negocio que merece un nombre propio.
   */
  async listOpenReceivables(
    customerId: CustomerId,
    options: CustomerReceivablesOptions,
  ): Promise<CustomerFinancePage<CustomerReceivable>> {
    return this.listReceivables(customerId, options);
  }

  async listOverdueReceivables(
    customerId: CustomerId,
    options: CustomerReceivablesOptions,
  ): Promise<CustomerFinancePage<CustomerReceivable>> {
    return this.listReceivables(customerId, { ...options, overdueOnly: true });
  }
}

export const createCustomerFinanceRepository = (
  client: SupabaseClient,
): CustomerFinanceRepository => new CustomerFinanceRepository(client);
