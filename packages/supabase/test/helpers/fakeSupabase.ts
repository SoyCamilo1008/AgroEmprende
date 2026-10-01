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
  op: 'select' | 'insert' | 'update';
  readonly table: string;
  readonly schema: string;
  /** Columnas enviadas en un `insert`/`update`; `null` en un `select`. */
  columns: Record<string, unknown> | null;
  filters: Array<[string, unknown]>;
  orFilters: string[];
  orders: Array<[string, boolean]>;
  range: [number, number] | null;
  single: 'single' | 'maybeSingle' | 'none';
  withCount: boolean;
  selectColumns: string | null;
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
      orFilters: [],
      orders: [],
      range: null,
      single: 'none',
      withCount: false,
      selectColumns: null,
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
