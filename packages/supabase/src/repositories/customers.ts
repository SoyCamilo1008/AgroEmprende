/**
 * Repositorio de Clientes y sus contactos.
 *
 * Donde esta la frontera
 * ---------------------
 * Este archivo es el UNICO lugar donde Web y Mobile hablan con
 * `core.customers` y `core.customer_contacts`. Las pantallas no construyen
 * consultas: piden datos. Si dos apps necesitaran la misma consulta, se
 * duplicaria aqui, no en cada pantalla.
 *
 * Las tres reglas que este archivo respeta
 * ----------------------------------------
 * 1. RLS manda. El repositorio nunca filtra por `organization_id` a mano: la
 *    politica decide que filas ve el usuario. Anadir un
 *    `.eq('organization_id', ...)` "por seguridad" daria la falsa impresion de
 *    que el filtro es la defensa, cuando la defensa es RLS y ese filtro solo
 *    estorba (y con la cabecera `x-organization-id` equivocada romperia el
 *    acceso legitimo).
 * 2. La organizacion se deriva del contexto, no del formulario. Ni `create` ni
 *    `createContact` aceptan `organizationId`: lo pone PostgreSQL desde
 *    `private.current_organization_id()`. Ver la migracion
 *    `20260928171000_derive_partner_organization_on_insert.sql`.
 * 3. La validacion de entrada es la de `@agroemprende/validation`, no una copia.
 *    Este archivo no reimplementa reglas: valida y despues traduce a snake_case.
 */
import type { Customer, CustomerContact } from '@agroemprende/types';
import { customerContactSchema, customerSchema } from '@agroemprende/validation';
import type { SupabaseClient } from '@supabase/supabase-js';
import { domainError, translatePostgrestError } from '../errors';
import {
  mapCustomerContactRowToDomain,
  mapCustomerRowToDomain,
  readContactCount,
  readRecord,
} from '../rows';

const CUSTOMERS = 'customers';
const CONTACTS = 'customer_contacts';

/** Tamano de pagina por defecto: 50 cabe en una pantalla sin scroll infinito. */
export const DEFAULT_CUSTOMER_PAGE_SIZE = 50;

/**
 * Tope de una pagina. `supabase/config.toml` fija `max_rows = 1000`, asi que
 * pedir mas no da mas datos: solo hace mas lenta la consulta y gasta memoria
 * para terminar mostrando una lista que nadie va a recorrer.
 */
export const MAX_CUSTOMER_PAGE_SIZE = 1000;

/** Columnas por las que se permite ordenar. Lista cerrada: no se pasa libre. */
export const CUSTOMER_SORT_COLUMNS = [
  'name',
  'code',
  'created_at',
  'updated_at',
  'credit_days',
] as const;

export type CustomerSortColumn = (typeof CUSTOMER_SORT_COLUMNS)[number];

const isCustomerSortColumn = (value: unknown): value is CustomerSortColumn =>
  typeof value === 'string' && (CUSTOMER_SORT_COLUMNS as readonly string[]).includes(value);

/**
 * Resuelve la columna de orden contra la lista cerrada.
 *
 * El tipo `CustomerSortColumn` desaparece al compilar, así que un valor que venga
 * de JavaScript o de una query string llega igual. Sin esta comprobación, ese
 * valor acabaría dentro del `order=` de PostgREST sin revisar, que es donde se
 * inyectan filtros. Ante un valor no permitido se usa `name`: una lista ordenada
 * por otra cosa es un detalle, y una consulta manipulada no lo es.
 */
const resolveSortColumn = (value: unknown): CustomerSortColumn =>
  isCustomerSortColumn(value) ? value : 'name';

export interface CustomerListOptions {
  /**
   * Texto libre. Busca en `name`, `code`, `phone` y `tax_id`.
   * Vacio o con solo espacios se ignora: una busqueda vacia debe listar, no
   * filtrar por un patron que casaria con todo.
   */
  readonly search?: string | undefined;
  /** `undefined` = ambos. `false` = solo inactivos, que es como se listan los archivados. */
  readonly isActive?: boolean | undefined;
  readonly sortBy?: CustomerSortColumn | undefined;
  readonly sortDir?: 'asc' | 'desc' | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * Una pagina de clientes con el total de filas que coinciden.
 *
 * `total` viene de `count: 'exact'`. Sin el, la app no puede pintar "1-50 de
 * 340" ni saber si hay siguiente pagina, y acaba inventando ese dato.
 */
export interface CustomerPage {
  readonly items: readonly Customer[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Resumen de cliente. NO incluye saldo.
 *
 * El saldo se deriva de `finance.receivables` cruzando `finance.sales`, y cada
 * venta anulada se reconoce por su contra-asiento en `finance.ledger_entries`
 * (ADR-0003). Reimplementar eso aqui produciria un saldo que no cuadra con el
 * motor financiero en cuanto una venta se anule. Ese calculo va en el bloque de
 * finanzas, no aqui.
 */
export interface CustomerSummary {
  readonly customer: Customer;
  readonly contactCount: number;
}

/**
 * Caracteres con significado en la sintaxis de filtros de PostgREST.
 *
 * Un `.or()` construye una cadena de filtros donde `,` separa condiciones y
 * `.` separa columna de operador. Si el texto del usuario trae una coma, el
 * filtro deja de ser "buscar esto" y pasa a ser "buscar esto, O cumplir esta
 * otra condicion que el usuario no escribio".
 */
const POSTGREST_RESERVED = /[,."\\()]/g;

/** Comodines de `LIKE`/`ILIKE`. */
const LIKE_WILDCARDS = /[%_]/g;

/**
 * Prepara el texto de busqueda para el `or=` de PostgREST.
 *
 * Los caracteres reservados se ELIMINAN en vez de escaparse con barra: el
 * `or=` viaja plano en la query string, sin JSON que lo proteja, y su sintaxis
 * de escape cambia entre versiones de PostgREST. Borrarlos no puede producir un
 * filtro distinto del que el usuario pidio, que es lo que importa aqui.
 *
 * Los comodines `%` y `_` tambien se borran: sin esto, buscar "100%" traeria
 * cualquier cliente que contenga "100", y "a_b" buscaria "a", cualquier cosa,
 * "b".
 *
 * Un nombre de cliente no necesita comas, parentesis, comillas ni barras. El
 * que si las tiene, las pierde de la busqueda, no de los datos.
 */
export const buildSearchPattern = (raw: string): string => {
  // El trim va AQUÍ y no en el llamador, porque `buildSearchPattern` se exporta:
  // buscar "  sur  " debe ser lo mismo que buscar "sur", y si el recorte quedara
  // en el repositorio, quien llame a la función directamente no lo tendría.
  const cleaned = raw.trim().replace(POSTGREST_RESERVED, '').replace(LIKE_WILDCARDS, '');
  // Un término que quedaba vacío tras limpiar (por ejemplo "%%" o ",,,") se
  // devuelve como cadena vacía: el llamador lo trata como "sin búsqueda" y
  // lista, en vez de mandar un `or=().ilike.%%` que PostgreSQL rechaza.
  return cleaned === '' ? '' : `%${cleaned}%`;
};

const normalizePage = (
  limit: number | undefined,
  offset: number | undefined,
): { limit: number; offset: number } => {
  const requestedLimit = limit ?? DEFAULT_CUSTOMER_PAGE_SIZE;
  const safeLimit = Number.isFinite(requestedLimit)
    ? Math.trunc(requestedLimit)
    : DEFAULT_CUSTOMER_PAGE_SIZE;
  const clampedLimit = Math.min(Math.max(safeLimit, 1), MAX_CUSTOMER_PAGE_SIZE);
  const requestedOffset = offset ?? 0;
  const safeOffset = Number.isFinite(requestedOffset) ? Math.trunc(requestedOffset) : 0;
  return { limit: clampedLimit, offset: Math.max(safeOffset, 0) };
};

/**
 * Campos de `core.customers` que se pueden escribir, con el nombre de su columna.
 * La traduccion camelCase -> snake_case vive aqui y en ningun otro sitio.
 */
const CUSTOMER_COLUMN_BY_FIELD = {
  name: 'name',
  code: 'code',
  taxId: 'tax_id',
  email: 'email',
  phone: 'phone',
  address: 'address',
  creditDays: 'credit_days',
  notes: 'notes',
  isActive: 'is_active',
} as const;

const CONTACT_COLUMN_BY_FIELD = {
  name: 'name',
  role: 'role',
  email: 'email',
  phone: 'phone',
  isPrimary: 'is_primary',
  notes: 'notes',
} as const;

/**
 * Convierte un objeto camelCase en columnas snake_case.
 *
 * `undefined` se OMITE y `null` se envia. La diferencia importa: si el
 * formulario manda `creditDays: undefined` porque el campo quedo vacio y eso se
 * tradujera a `credit_days: null`, se borraria el plazo acordado. Si lo manda
 * `null` a proposito, si se borra. Por eso la comprobacion es `=== undefined`
 * y no un truthy.
 *
 * Las claves que no estan en el mapa se descartan: un `organizationId` que
 * alguien pase de mas no llega a la base.
 */
const toColumns = <M extends Readonly<Record<string, string>>>(
  input: Readonly<Record<string, unknown>>,
  mapping: M,
): Record<string, unknown> => {
  const columns: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const column = (mapping as Readonly<Record<string, string>>)[field];
    if (column === undefined) continue;
    columns[column] = value;
  }
  return columns;
};

/**
 * Deja solo las columnas cuyo campo venía en el objeto original del llamador.
 *
 * `columns` es lo que devolvió el schema ya normalizado y `source` lo que el
 * formulario envió. Se cruzan porque el schema puede añadir claves que nadie
 * pidió: con `.default()` dentro, rellena los ausentes, y mandarlos sería
 * escribir campos que el usuario no tocó.
 *
 * Un campo presente con valor `undefined` tampoco se escribe: `toColumns` ya lo
 * omite, y una clave que solo existe porque el formulario la inicializó a
 * `undefined` no es una petición de borrado.
 */
const onlyKeysFrom = (
  columns: Readonly<Record<string, unknown>>,
  source: unknown,
): Record<string, unknown> => {
  if (typeof source !== 'object' || source === null) return {};
  const requested = new Set(Object.keys(source as Record<string, unknown>));

  const filtered: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(columns)) {
    const field = COLUMN_TO_FIELD.get(column);
    // Una columna sin campo conocido no se puede rastrear hasta una clave del
    // formulario, así que no se envía.
    if (field === undefined) continue;
    if (!requested.has(field)) continue;
    filtered[column] = value;
  }
  return filtered;
};

const FIELD_TO_COLUMN: Readonly<Record<string, string>> = {
  ...CUSTOMER_COLUMN_BY_FIELD,
  ...CONTACT_COLUMN_BY_FIELD,
};

/** Mapa columna -> campo, para rastrear qué campo del formulario pidió qué columna. */
const COLUMN_TO_FIELD: ReadonlyMap<string, string> = new Map(
  Object.entries(FIELD_TO_COLUMN).map(([field, column]) => [column, field]),
);

/**
 * Repositorio de clientes.
 *
 * Se construye con un `SupabaseClient` de la app, no con uno propio: el cliente
 * ya trae la sesion (cookies en web, almacenamiento seguro en movil) y es el
 * que envia la cabecera `x-organization-id`. Crear otro cliente aqui perderia
 * la sesion y el contexto de organizacion.
 */
export class CustomerRepository {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.#client = client;
  }

  /**
   * Las tablas viven en el esquema `core`, no en `public`. El tipo del cliente
   * de esquema se infiere: `PostgrestClient` no se exporta desde
   * `@supabase/supabase-js` y el `any` de sus builders (por no haber
   * `database.types.ts` generado) no se puede nombrar sin escribir `any`.
   */
  get #core(): ReturnType<SupabaseClient['schema']> {
    return this.#client.schema('core');
  }

  /**
   * Valida la entrada con el schema compartido y devuelve las columnas a escribir.
   *
   * Se escriben SOLO los campos que el llamador mandó, tanto en un alta como en una
   * actualización. `.partial()` no sirve para saberlo: en Zod 4 sigue aplicando el
   * `.default()` interior de cada campo, así que
   * `customerSchema.partial().parse({ name: 'X' })` devuelve
   * `{ name: 'X', creditDays: null, isActive: true }`. Con eso, cambiar solo el
   * nombre de un cliente borraría su plazo de crédito acordado y reactivaría uno
   * que el dueño desactivó.
   *
   * Los defaults son de la BASE, no del formulario: `core.customers.is_active` es
   * `not null default true` y `credit_days` es nullable sin default. Duplicarlos
   * en el INSERT solo crea un segundo sitio donde se puedan contradecir; si mañana
   * el default de la tabla cambia, el INSERT no debería seguir mandando el viejo.
   */
  #parseCustomerInput(input: unknown, partial: boolean): Record<string, unknown> {
    const schema = partial ? customerSchema.partial() : customerSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw domainError('validation', 'Los datos del cliente no son válidos', {
        details: parsed.error.issues,
      });
    }
    const normalized = parsed.data as Readonly<Record<string, unknown>>;
    return onlyKeysFrom(toColumns(normalized, CUSTOMER_COLUMN_BY_FIELD), input);
  }

  #parseContactInput(input: unknown, partial: boolean): Record<string, unknown> {
    const schema = partial ? customerContactSchema.partial() : customerContactSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw domainError('validation', 'Los datos del contacto no son válidos', {
        details: parsed.error.issues,
      });
    }
    const normalized = parsed.data as Readonly<Record<string, unknown>>;
    return onlyKeysFrom(toColumns(normalized, CONTACT_COLUMN_BY_FIELD), input);
  }

  /**
   * Lista clientes con busqueda, filtro de estado y paginacion.
   *
   * El orden por defecto es `name` ascendente porque es lo que espera alguien
   * abriendo un listado, no un `id` que no significa nada. No se anade
   * desempate por `id`: `name` no es unico y Postgres puede devolver las paginas
   * en orden distinto entre llamadas, lo que hace que un cliente salte de pagina
   * al recargar. Resolver eso exige un indice unico de orden, que no existe y no
   * se inventa aqui.
   */
  async list(options: CustomerListOptions = {}): Promise<CustomerPage> {
    const { limit, offset } = normalizePage(options.limit, options.offset);
    // El patrón se decide antes de construir la consulta, no después: un término
    // que solo tenía comodines se limpia a vacío y NO debe llegar al `.or()`.
    const pattern = buildSearchPattern(options.search ?? '');

    try {
      let query = this.#core
        .from(CUSTOMERS)
        .select('*', { count: 'exact' })
        .order(resolveSortColumn(options.sortBy), {
          ascending: (options.sortDir ?? 'asc') === 'asc',
        })
        .range(offset, offset + limit - 1);

      if (options.isActive !== undefined) {
        query = query.eq('is_active', options.isActive);
      }

      if (pattern !== '') {
        query = query.or(
          `name.ilike.${pattern},code.ilike.${pattern},phone.ilike.${pattern},tax_id.ilike.${pattern}`,
        );
      }

      const { data, error, count } = await query;
      if (error !== null) throw error;

      const items = (Array.isArray(data) ? data : []).map(mapCustomerRowToDomain);
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
   * Un cliente por id.
   *
   * Devuelve `null` cuando RLS no deja ver la fila. NO se distingue "no existe"
   * de "es de otra organizacion": esa distincion seria confirmar que el cliente
   * existe, que es justo la fuga que RLS evita.
   */
  async getById(id: string): Promise<Customer | null> {
    try {
      const { data, error } = await this.#core
        .from(CUSTOMERS)
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error !== null) throw error;
      if (data === null) return null;
      return mapCustomerRowToDomain(data);
    } catch (error) {
      throw translatePostgrestError(error);
    }
  }

  /**
   * Alta de cliente.
   *
   * `organization_id` NO se envia: la trigger `derive_partner_organization` lo
   * toma de `private.current_organization_id()`, que es el mismo contexto que
   * usan las politicas. Asi el repositorio no puede crear un cliente en otra
   * organizacion ni por error ni porque un formulario se lo mande.
   */
  async create(input: unknown): Promise<Customer> {
    const columns = this.#parseCustomerInput(input, false);

    try {
      const { data, error } = await this.#core.from(CUSTOMERS).insert(columns).select('*').single();
      if (error !== null) throw error;
      return mapCustomerRowToDomain(data);
    } catch (error) {
      throw translatePostgrestError(error);
    }
  }

  /**
   * Actualizacion parcial.
   *
   * Solo se escriben los campos presentes en el patch. Un formulario que manda
   * el cliente entero, con los campos opcionales vacios, no debe borrar el NIT de
   * un cliente que ya estaba formalizado.
   */
  async update(id: string, input: unknown): Promise<Customer> {
    const columns = this.#parseCustomerInput(input, true);

    if (Object.keys(columns).length === 0) {
      // Nada que escribir. Se devuelve el cliente tal cual en vez de enviar un
      // UPDATE vacio, que ademas generaria una entrada de auditoria con la
      // fecha de "ahora" y sin ningun cambio real detras.
      const existing = await this.getById(id);
      if (existing === null) throw domainError('not_found', 'El cliente no existe');
      return existing;
    }

    try {
      const { data, error } = await this.#core
        .from(CUSTOMERS)
        .update(columns)
        .eq('id', id)
        .select('*')
        .maybeSingle();
      if (error !== null) throw error;
      // RLS filtra en USING: una actualizacion sobre una fila ajena no falla,
      // no actualiza nada y devuelve cero filas. Sin este chequeo, el repositorio
      // devolveria un `undefined` disfrazado de cliente.
      if (data === null) throw domainError('not_found', 'El cliente no existe');
      return mapCustomerRowToDomain(data);
    } catch (error) {
      throw translatePostgrestError(error);
    }
  }

  /**
   * Desactiva un cliente sin borrarlo.
   *
   * No hay `DELETE` en `core.customers` a proposito: sus ventas, pagos y
   * contactos lo referencian, y un borrado se lleva la historia. Desactivar deja
   * el historial intacto y saca al cliente de las listas activas.
   */
  async deactivate(id: string): Promise<Customer> {
    return this.update(id, { isActive: false });
  }

  async activate(id: string): Promise<Customer> {
    return this.update(id, { isActive: true });
  }

  /**
   * Contactos de un cliente, el principal primero.
   *
   * `is_primary DESC` porque el contacto principal es al que se llama primero.
   */
  async listContacts(customerId: string): Promise<readonly CustomerContact[]> {
    try {
      const { data, error } = await this.#core
        .from(CONTACTS)
        .select('*')
        .eq('customer_id', customerId)
        .order('is_primary', { ascending: false })
        .order('name', { ascending: true });

      if (error !== null) throw error;
      return (Array.isArray(data) ? data : []).map(mapCustomerContactRowToDomain);
    } catch (error) {
      throw translatePostgrestError(error);
    }
  }

  /**
   * Alta de contacto.
   *
   * Tampoco acepta `organizationId`: la trigger lo deriva del contexto, y la
   * politica de insert comprueba ademas que el `customer_id` pertenezca a la
   * organizacion activa. Un contacto no se puede colgar de un cliente ajeno.
   */
  async createContact(input: unknown): Promise<CustomerContact> {
    // Se valida el objeto ENTERO, con su `customerId`, contra el schema completo.
    // Validar el resto por separado fallaría siempre: `customerId` es obligatorio
    // en el schema y ya se había sacado del objeto.
    const parsed = customerContactSchema.safeParse(input);
    if (!parsed.success) {
      throw domainError('validation', 'Los datos del contacto no son válidos', {
        details: parsed.error.issues,
      });
    }

    // `customerId` no está en `CONTACT_COLUMN_BY_FIELD`, así que `toColumns` ya lo
    // descarta; se vuelve a poner como `customer_id` que sí es una columna real.
    const columns = onlyKeysFrom(toColumns(parsed.data, CONTACT_COLUMN_BY_FIELD), input);
    columns['customer_id'] = parsed.data.customerId;

    try {
      const { data, error } = await this.#core.from(CONTACTS).insert(columns).select('*').single();
      if (error !== null) throw error;
      return mapCustomerContactRowToDomain(data);
    } catch (error) {
      throw translatePostgrestError(error);
    }
  }

  /**
   * Actualizacion parcial de un contacto.
   *
   * NO existe desactivar ni borrar contactos: `core.customer_contacts` no tiene
   * `is_active` ni politica de `DELETE`. Anadir cualquiera de las dos cosas aqui
   * seria inventar un modelo que la base no respalda; el que las necesite tiene
   * que decidirlo sobre el esquema, no sobre el cliente.
   *
   * `customerId` se ignora aunque venga: cambiar de cliente un contacto es
   * moverlo de organizacion en la practica, y eso no lo decide un formulario.
   */
  async updateContact(id: string, input: unknown): Promise<CustomerContact> {
    const columns = this.#parseContactInput(input, true);

    if (Object.keys(columns).length === 0) {
      throw domainError('validation', 'No hay nada que actualizar en el contacto');
    }

    try {
      const { data, error } = await this.#core
        .from(CONTACTS)
        .update(columns)
        .eq('id', id)
        .select('*')
        .maybeSingle();
      if (error !== null) throw error;
      if (data === null) throw domainError('not_found', 'El contacto no existe');
      return mapCustomerContactRowToDomain(data);
    } catch (error) {
      throw translatePostgrestError(error);
    }
  }

  /**
   * Cliente con su conteo de contactos.
   *
   * El conteo viene del agregado embebido `customer_contacts(count)`, que lo
   * calcula PostgreSQL en la misma consulta. Pedir los contactos aparte y
   * contarlos en JavaScript seria una segunda consulta por cliente.
   *
   * El saldo NO va aqui: ver la nota de `CustomerSummary`.
   */
  async getSummary(id: string): Promise<CustomerSummary | null> {
    try {
      const { data, error } = await this.#core
        .from(CUSTOMERS)
        .select('*, customer_contacts(count)')
        .eq('id', id)
        .maybeSingle();

      if (error !== null) throw error;
      if (data === null) return null;

      const row = readRecord(data, 'core.customers');
      return {
        customer: mapCustomerRowToDomain(row),
        contactCount: readContactCount(row['customer_contacts']),
      };
    } catch (error) {
      throw translatePostgrestError(error);
    }
  }
}

export const createCustomerRepository = (client: SupabaseClient): CustomerRepository =>
  new CustomerRepository(client);
