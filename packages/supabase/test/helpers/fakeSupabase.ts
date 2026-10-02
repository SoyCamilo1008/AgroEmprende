/**
 * Falso de cliente Supabase para probar el repositorio sin base de datos.
 *
 * Por qué existe y por qué NO reemplaza a pgTAP
 * ---------------------------------------------
 * Este doble registra qué consulta se construyó y devuelve filas fijas. Con él se
 * prueba la parte que es código NUESTRO: el mapeo de columnas, el texto del
 * filtro de búsqueda, el parche parcial y la traducción de errores.
 *
 * NO puede probar nada de lo que hace PostgreSQL. Que una organización no vea los
 * clientes de la otra, que un observador no escriba, que un INSERT sin
 * `organization_id` aterrice en la organización activa y que un DELETE no exista
 * son propiedades de RLS, de las políticas y de los triggers: dependen de que el
 * servidor ejecute la consulta. Eso lo mide
 * `supabase/tests/11_customers_data_access.test.sql` contra PostgreSQL real, en el
 * job `migrations` del CI.
 *
 * Un test con este doble que "probara" aislamiento no probaría nada: el doble
 * devolvería exactamente lo que se le dijo que devolviera.
 */
import type { Customer } from '@agroemprende/types';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Una consulta registrada.
 *
 * Los campos son mutables a propósito: el doble los va llenando a medida que se
 * encadena la consulta, igual que hace el builder real. El array de filtros se
 * expone como `readonly` para que el TEST no pueda alterarlo y falsear su propia
 * aserción.
 */
export interface RecordedCall {
  op: 'select' | 'insert' | 'update' | 'rpc';
  readonly table: string;
  readonly schema: string;
  /** Columnas enviadas en un `insert`/`update`; `null` en un `select`. */
  columns: Record<string, unknown> | null;
  filters: Array<[string, unknown]>;
  /** Filtros de rango y de comparacion, con su operador, para poder afirmar sobre el. */
  comparisons: Array<[string, string, unknown]>;
  orFilters: string[];
  orders: Array<[string, boolean]>;
  range: [number, number] | null;
  single: 'single' | 'maybeSingle' | 'none';
  withCount: boolean;
  selectColumns: string | null;
  /** Nombre de la funcion en un `rpc`; `null` en cualquier otra operacion. */
  rpcName: string | null;
  /** Parametros enviados a la funcion en un `rpc`; `null` en cualquier otra. */
  rpcParams: Record<string, unknown> | null;
}

/** Respuesta que el doble devuelve para la siguiente consulta. */
export interface StubbedResponse {
  readonly data?: unknown;
  readonly error?: { code?: string; message?: string; details?: string; hint?: string } | null;
  readonly count?: number | null;
}

const CUSTOMER_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  organization_id: '22222222-2222-4222-8222-222222222222',
  code: 'CLI-01',
  name: 'Clientes del Sur S.A.S.',
  tax_id: '900123456',
  email: 'pagos@clientesdelsur.com',
  phone: '3101234567',
  address: 'Carrera 10 # 20-30',
  credit_days: 30,
  notes: 'Paga los viernes',
  is_active: true,
  created_at: '2026-09-28T10:00:00.000Z',
  updated_at: '2026-09-28T10:00:00.000Z',
};

const CONTACT_ROW = {
  id: '33333333-3333-4333-8333-333333333333',
  organization_id: '22222222-2222-4222-8222-222222222222',
  customer_id: CUSTOMER_ROW.id,
  name: 'María López',
  role: 'Dueño de compra',
  email: 'maria@clientesdelsur.com',
  phone: '3117654321',
  is_primary: true,
  notes: null,
  created_at: '2026-09-28T10:05:00.000Z',
  updated_at: '2026-09-28T10:05:00.000Z',
};

export const customerRow = (overrides: Record<string, unknown> = {}) => ({
  ...CUSTOMER_ROW,
  ...overrides,
});

export const contactRow = (overrides: Record<string, unknown> = {}) => ({
  ...CONTACT_ROW,
  ...overrides,
});

export const customerDomain = (overrides: Partial<Customer> = {}): Customer => ({
  id: CUSTOMER_ROW.id as Customer['id'],
  organizationId: CUSTOMER_ROW.organization_id as Customer['organizationId'],
  code: CUSTOMER_ROW.code,
  name: CUSTOMER_ROW.name,
  taxId: CUSTOMER_ROW.tax_id,
  email: CUSTOMER_ROW.email,
  phone: CUSTOMER_ROW.phone,
  address: CUSTOMER_ROW.address,
  creditDays: CUSTOMER_ROW.credit_days,
  notes: CUSTOMER_ROW.notes,
  isActive: CUSTOMER_ROW.is_active,
  createdAt: CUSTOMER_ROW.created_at as Customer['createdAt'],
  updatedAt: CUSTOMER_ROW.updated_at as Customer['updatedAt'],
  ...overrides,
});

/**
 * Cadena de consulta. Cada método devuelve `this` para que la consulta se arme
 * igual que en el código real; el último (`.single()`, `.maybeSingle()` o el
 * `await` directo) consume una respuesta de la cola.
 */
class Chain {
  readonly call: RecordedCall;
  readonly #responses: StubbedResponse[];

  constructor(schema: string, table: string, responses: StubbedResponse[]) {
    this.call = {
      op: 'select',
      table,
      schema,
      columns: null,
      filters: [],
      comparisons: [],
      orFilters: [],
      orders: [],
      range: null,
      single: 'none',
      withCount: false,
      selectColumns: null,
      rpcName: null,
      rpcParams: null,
    };
    this.#responses = responses;
  }

  select(columns: string, options?: { count?: string }): this {
    this.call.selectColumns = columns;
    this.call.withCount = options?.count === 'exact';
    return this;
  }

  insert(columns: Record<string, unknown>): this {
    this.call.op = 'insert';
    this.call.columns = columns;
    return this;
  }

  update(columns: Record<string, unknown>): this {
    this.call.op = 'update';
    this.call.columns = columns;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.call.filters.push([column, value]);
    return this;
  }

  // Las comparaciones se registran aparte de `filters` porque un test que solo mira
  // `filters` no podria afirmar "no filtres solo por cliente, filtra tambien por
  // saldo positivo", que es justo lo que distingue una cartera real de una lista de
  // todo. Mezclarlas en el mismo array hacia que el operador se perdiera.
  #compare(operator: string, column: string, value: unknown): this {
    this.call.comparisons.push([column, operator, value]);
    return this;
  }

  gt(column: string, value: unknown): this {
    return this.#compare('gt', column, value);
  }

  gte(column: string, value: unknown): this {
    return this.#compare('gte', column, value);
  }

  lt(column: string, value: unknown): this {
    return this.#compare('lt', column, value);
  }

  lte(column: string, value: unknown): this {
    return this.#compare('lte', column, value);
  }

  or(filter: string): this {
    this.call.orFilters.push(filter);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.call.orders.push([column, options?.ascending ?? true]);
    return this;
  }

  range(from: number, to: number): this {
    this.call.range = [from, to];
    return this;
  }

  single(): Promise<ResolvedResponse> {
    this.call.single = 'single';
    return this.#take();
  }

  maybeSingle(): Promise<ResolvedResponse> {
    this.call.single = 'maybeSingle';
    return this.#take();
  }

  // Un builder de supabase-js es un thenable: por eso un `select()` sin
  // `.single()` se resuelve con `await` directamente.
  then<TResult1 = ResolvedResponse, TResult2 = never>(
    onFulfilled?: ((value: ResolvedResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#take().then(onFulfilled, onRejected);
  }

  #take(): Promise<ResolvedResponse> {
    // `shift` devuelve `undefined` si la cola está vacía: se usa `?? {}` porque
    // `noUncheckedIndexedAccess` y porque una consulta sin respuesta encolada
    // debe resolverse como "no vino nada", que es lo que hace PostgREST.
    const next = this.#responses.shift() ?? {};
    return Promise.resolve({
      data: next.data ?? null,
      error: next.error ?? null,
      count: next.count ?? null,
    });
  }
}

export interface ResolvedResponse {
  readonly data: unknown;
  readonly error: { code?: string; message?: string; details?: string; hint?: string } | null;
  readonly count: number | null;
}

export interface FakeSupabase {
  readonly client: SupabaseClient;
  /** Todas las consultas que se construyeron, en orden. */
  readonly calls: readonly RecordedCall[];
  /** La última consulta construida. */
  lastCall(): RecordedCall;
  /** Encola respuestas para las siguientes consultas. */
  enqueue(...responses: StubbedResponse[]): void;
}

/**
 * Construye un cliente falso. El tipo que se devuelve es `SupabaseClient` porque
 * eso es lo que consume el repositorio; el `as unknown` ocurre UNA vez, aquí, y
 * nunca dentro del código de dominio.
 */
export const createFakeSupabase = (...responses: StubbedResponse[]): FakeSupabase => {
  const calls: RecordedCall[] = [];
  const queue: StubbedResponse[] = [...responses];

  const schema = (schemaName: string) => ({
    from: (table: string): Chain => {
      const chain = new Chain(schemaName, table, queue);
      calls.push(chain.call);
      return chain;
    },
    // `rpc` se registra como una llamada mas, con su nombre y sus parametros, para
    // que un test pueda afirmar que la funcion del resumen se invoco con la fecha de
    // negocio que le paso la aplicacion y no con la del servidor. Un doble que
    // aceptara cualquier parametro en silencio no distinguiria las dos cosas, que es
    // justo lo que esta prueba.
    rpc: (fnName: string, params: Record<string, unknown>): Chain => {
      const chain = new Chain(schemaName, `(${fnName})`, queue);
      chain.call.op = 'rpc';
      chain.call.rpcName = fnName;
      chain.call.rpcParams = params;
      calls.push(chain.call);
      return chain;
    },
  });

  return {
    client: { schema } as unknown as SupabaseClient,
    calls,
    lastCall: () => {
      const last = calls[calls.length - 1];
      if (last === undefined) throw new Error('No se construyó ninguna consulta');
      return last;
    },
    enqueue: (...next: StubbedResponse[]) => {
      queue.push(...next);
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Filas de las vistas financieras
//
// Reflejan el SQL de las migraciones `20260928172000` y `20260928173000`.
//
// Un detalle que estos tests hacen explicito: los `numeric` de PostgreSQL viajan
// como TEXTO por PostgREST, no como number. `numeric` no cabe en un double sin
// perder precisión y el transporte no lo convierte. Las filas de aqui los traen
// como string a proposito: si el repositorio los asumiera number, estos tests
// fallarian, que es lo que tiene que pasar con una base real.
// ─────────────────────────────────────────────────────────────────────────────

const BUSINESS_UNIT = {
  business_unit_id: '44444444-4444-4444-8444-444444444444',
  business_unit_code: 'PONEDORAS',
  business_unit_name: 'Ponederas',
};

const RECEIVABLE_ROW = {
  organization_id: '22222222-2222-4222-8222-222222222222',
  receivable_id: '55555555-5555-4555-8555-555555555555',
  sale_id: '66666666-6666-4666-8666-666666666666',
  customer_id: CUSTOMER_ROW.id,
  ...BUSINESS_UNIT,
  invoice_number: 'FV-0001',
  sale_date: '2026-04-01',
  due_date: '2026-05-01',
  payment_method: 'credit',
  // En PESOS, no en centavos: la conversion ocurre en el repositorio.
  original_amount: '20000.00',
  paid_amount: '4000.00',
  balance: '16000.00',
  paid_at: null,
  created_at: '2026-04-01T14:00:00.000Z',
};

const SALE_ROW = {
  organization_id: '22222222-2222-4222-8222-222222222222',
  sale_id: '66666666-6666-4666-8666-666666666666',
  customer_id: CUSTOMER_ROW.id,
  ...BUSINESS_UNIT,
  invoice_number: 'FV-0001',
  sale_date: '2026-04-01',
  due_date: '2026-05-01',
  payment_method: 'credit',
  subtotal: '20000.00',
  tax: '0.00',
  total: '20000.00',
  description: 'Venta a credito',
  created_by: null,
  created_at: '2026-04-01T14:00:00.000Z',
  is_voided: false,
};

const PAYMENT_ROW = {
  organization_id: '22222222-2222-4222-8222-222222222222',
  payment_id: '77777777-7777-4777-8777-777777777777',
  customer_id: CUSTOMER_ROW.id,
  payment_date: '2026-04-15',
  payment_method: 'cash',
  payment_amount: '4000.00',
  unapplied_amount: '0.00',
  description: 'Abono parcial',
  applied_amount: '4000.00',
  receivable_id: RECEIVABLE_ROW.receivable_id,
  sale_id: RECEIVABLE_ROW.sale_id,
  ...BUSINESS_UNIT,
  invoice_number: 'FV-0001',
  due_date: '2026-05-01',
  created_at: '2026-04-15T10:00:00.000Z',
};

const SUMMARY_ROW = {
  organization_id: '22222222-2222-4222-8222-222222222222',
  business_unit_id: BUSINESS_UNIT.business_unit_id,
  business_unit_code: 'PONEDORAS',
  business_unit_name: 'Ponederas',
  is_consolidated: false,
  sales_count: 2,
  cash_sales_count: 1,
  credit_sales_count: 1,
  receivable_count: 1,
  open_count: 1,
  partial_count: 1,
  overdue_count: 1,
  paid_count: 0,
  total_sold: '30000.00',
  cash_sales_total: '10000.00',
  credit_billed: '20000.00',
  total_paid: '4000.00',
  outstanding: '16000.00',
  overdue_outstanding: '16000.00',
  oldest_open_due_date: '2026-05-01',
};

const CONSOLIDATED_SUMMARY_ROW = {
  ...SUMMARY_ROW,
  business_unit_id: null,
  business_unit_code: null,
  business_unit_name: null,
  is_consolidated: true,
};

export const receivableRow = (overrides: Record<string, unknown> = {}) => ({
  ...RECEIVABLE_ROW,
  ...overrides,
});

export const saleRow = (overrides: Record<string, unknown> = {}) => ({
  ...SALE_ROW,
  ...overrides,
});

export const paymentRow = (overrides: Record<string, unknown> = {}) => ({
  ...PAYMENT_ROW,
  ...overrides,
});

export const summaryRow = (overrides: Record<string, unknown> = {}) => ({
  ...SUMMARY_ROW,
  ...overrides,
});

export const consolidatedSummaryRow = (overrides: Record<string, unknown> = {}) => ({
  ...CONSOLIDATED_SUMMARY_ROW,
  ...overrides,
});
