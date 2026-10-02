/**
 * Frontera tipada entre las filas de Postgres y el dominio.
 *
 * Por qué existe este archivo
 * ---------------------------
 * El repositorio no puede asumir tipos generados: `database.types.ts` se genera
 * con la CLI de Supabase, que exige Docker, y este proyecto se verifica en CI
 * sin él. Sin esos tipos, el cliente de supabase-js devuelve `any` en cada
 * respuesta.
 *
 * La regla de la casa prohíbe `any`, y el peor resultado posible no es un error
 * de compilación sino un `undefined` silencioso en producción: si una columna
 * se renombra o cambia de tipo, el mapeo debe FALLAR y decirlo, no devolver
 * `undefined` como si fuera un dato.
 *
 * Por eso cada lectura pasa por un coercor que valida y, si no encuentra lo que
 * espera, lanza `DomainError('database')`. Un drift de esquema se convierte así en
 * un error visible en lugar de una pantalla con datos a medias.
 *
 * Estas filas son el reflejo de:
 *   - supabase/migrations/20260928120000_create_core_partners.sql
 *   - supabase/migrations/20260928167000_customers_credit_days_impact.sql
 *   - supabase/migrations/20260928172000_customer_financial_read_model.sql
 *   - supabase/migrations/20260928173000_customer_sales_history.sql
 * Si cambias una columna ahí, cámbiala aquí: no hay generación automática que lo
 * haga por ti.
 */
import type {
  BusinessUnitRef,
  Customer,
  CustomerContact,
  CustomerFinancialSummaryRow,
  CustomerPayment,
  CustomerReceivable,
  CustomerSale,
  IsoDate,
  IsoDateTime,
} from '@agroemprende/types';
import { daysOverdue, pesosToMoney, resolveReceivableStatus } from '@agroemprende/calculations';
import { domainError, type DomainErrorOptions } from './errors';

/** Error de esquema: la fila no tiene la forma que el código espera. */
const schemaDrift = (table: string, column: string, options: DomainErrorOptions = {}): Error =>
  domainError(
    'database',
    `La fila de ${table} no tiene la forma esperada en la columna "${column}". ` +
      'Si acabas de cambiar el esquema, actualiza packages/supabase/src/rows.ts.',
    options,
  );

export const readRecord = (value: unknown, table: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw schemaDrift(table, '(fila)', { details: value });
  }
  return value as Record<string, unknown>;
};

const readString = (row: Record<string, unknown>, table: string, column: string): string => {
  const value = row[column];
  if (typeof value !== 'string') {
    throw schemaDrift(table, column, { details: value });
  }
  return value;
};

const readIsoDateTime = (
  row: Record<string, unknown>,
  table: string,
  column: string,
): IsoDateTime => {
  const value = readString(row, table, column);
  if (Number.isNaN(Date.parse(value))) {
    throw schemaDrift(table, column, { details: value });
  }
  return value as IsoDateTime;
};

/**
 * Un instante que puede no existir: `finance.receivables.paid_at` es NULL mientras
 * la deuda tenga saldo, aunque haya abonos parciales.
 *
 * El fallback es `?? null` y no `|| ''` por lo mismo que en `creditDays`: ausente
 * significa "todavia no se liquidó", y una cadena vacia se covertiria en una fecha
 * que no existe en el momento de pintar.
 */
const readNullableIsoDateTime = (
  row: Record<string, unknown>,
  table: string,
  column: string,
): IsoDateTime | null => {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return readIsoDateTime(row, table, column);
};

/**
 * Los NULLABLES del esquema se leen como `null`, nunca como `undefined` y nunca
 * como cadena vacía: `creditDays: null` ("no hay plazo acordado") y
 * `creditDays: 0` ("se cobra hoy") significan cosas distintas y el dominio las
 * distingue. Por eso el fallback es `?? null` y no `|| ''`.
 */
const readNullableString = (
  row: Record<string, unknown>,
  table: string,
  column: string,
): string | null => {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw schemaDrift(table, column, { details: value });
  }
  return value;
};

const readNullableInteger = (
  row: Record<string, unknown>,
  table: string,
  column: string,
): number | null => {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw schemaDrift(table, column, { details: value });
  }
  return value;
};

const readBoolean = (row: Record<string, unknown>, table: string, column: string): boolean => {
  const value = row[column];
  if (typeof value !== 'boolean') {
    throw schemaDrift(table, column, { details: value });
  }
  return value;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const readUuid = (row: Record<string, unknown>, table: string, column: string): string => {
  const value = readString(row, table, column);
  if (!UUID_PATTERN.test(value)) {
    throw schemaDrift(table, column, { details: value });
  }
  return value;
};

/** `core.customers` tal como la devuelve PostgREST. */
export interface CustomerRow {
  readonly id: string;
  readonly organization_id: string;
  readonly code: string | null;
  readonly name: string;
  readonly tax_id: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: string | null;
  readonly credit_days: number | null;
  readonly notes: string | null;
  readonly is_active: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

/** `core.customer_contacts` tal como la devuelve PostgREST. */
export interface CustomerContactRow {
  readonly id: string;
  readonly organization_id: string;
  readonly customer_id: string;
  readonly name: string;
  readonly role: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly is_primary: boolean;
  readonly notes: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const CUSTOMERS_TABLE = 'core.customers';
const CONTACTS_TABLE = 'core.customer_contacts';

export const mapCustomerRowToDomain = (value: unknown): Customer => {
  const row = readRecord(value, CUSTOMERS_TABLE);
  return {
    id: readUuid(row, CUSTOMERS_TABLE, 'id') as Customer['id'],
    organizationId: readUuid(row, CUSTOMERS_TABLE, 'organization_id') as Customer['organizationId'],
    code: readNullableString(row, CUSTOMERS_TABLE, 'code'),
    name: readString(row, CUSTOMERS_TABLE, 'name'),
    taxId: readNullableString(row, CUSTOMERS_TABLE, 'tax_id'),
    email: readNullableString(row, CUSTOMERS_TABLE, 'email'),
    phone: readNullableString(row, CUSTOMERS_TABLE, 'phone'),
    address: readNullableString(row, CUSTOMERS_TABLE, 'address'),
    creditDays: readNullableInteger(row, CUSTOMERS_TABLE, 'credit_days'),
    notes: readNullableString(row, CUSTOMERS_TABLE, 'notes'),
    isActive: readBoolean(row, CUSTOMERS_TABLE, 'is_active'),
    createdAt: readIsoDateTime(row, CUSTOMERS_TABLE, 'created_at'),
    updatedAt: readIsoDateTime(row, CUSTOMERS_TABLE, 'updated_at'),
  };
};

export const mapCustomerContactRowToDomain = (value: unknown): CustomerContact => {
  const row = readRecord(value, CONTACTS_TABLE);
  return {
    id: readUuid(row, CONTACTS_TABLE, 'id'),
    organizationId: readUuid(
      row,
      CONTACTS_TABLE,
      'organization_id',
    ) as CustomerContact['organizationId'],
    customerId: readUuid(row, CONTACTS_TABLE, 'customer_id') as CustomerContact['customerId'],
    name: readString(row, CONTACTS_TABLE, 'name'),
    role: readNullableString(row, CONTACTS_TABLE, 'role'),
    email: readNullableString(row, CONTACTS_TABLE, 'email'),
    phone: readNullableString(row, CONTACTS_TABLE, 'phone'),
    isPrimary: readBoolean(row, CONTACTS_TABLE, 'is_primary'),
    notes: readNullableString(row, CONTACTS_TABLE, 'notes'),
    createdAt: readIsoDateTime(row, CONTACTS_TABLE, 'created_at'),
    updatedAt: readIsoDateTime(row, CONTACTS_TABLE, 'updated_at'),
  };
};

/**
 * Conteo de contactos que devuelve el agregado embebido
 * `customer_contacts(count)` de PostgREST: una lista de un elemento con `count`.
 * Si el embed no viene (filtros sin la relación), se interpreta como cero
 * contactos en lugar de inventar un número.
 */
export const readContactCount = (embedded: unknown): number => {
  if (!Array.isArray(embedded)) return 0;
  const first = embedded[0];
  if (typeof first !== 'object' || first === null) return 0;
  const count = (first as Record<string, unknown>)['count'];
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return 0;
  return count;
};

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas financieras
//
// Estas filas vienen de VISTAS (`finance.customer_receivables`,
// `finance.customer_payments`, `finance.customer_sales`) y de la FUNCION
// `finance.customer_financial_summary`, todas en la migracion `20260928172000` y
// `20260928173000`.
//
// El mapa de columna es el mismo en las cuatro, asi que los coercores comparten los
// lectores de `rows.ts` a proposito: si una columna cambia, falla el drift en un
// sitio y todos los lectores se enteran, en vez de que cada uno tenga su copia.
//
// La UNICA diferencia con el bloque de clientes es el importe: PostgreSQL devuelve
// `NUMERIC(18,2)` en pesos y el dominio habla en centavos (ADR-0006). Aqui se
// convierte, una vez, con `pesosToMoney`. Un saldo mostrado sin convertir seria cien
// veces mas pequeno, y el error no se veria: se veria un numero plausible.
// ─────────────────────────────────────────────────────────────────────────────

const RECEIVABLES_VIEW = 'finance.customer_receivables';
const PAYMENTS_VIEW = 'finance.customer_payments';
const SALES_VIEW = 'finance.customer_sales';
const SUMMARY_FUNCTION = 'finance.customer_financial_summary';

const readNumber = (row: Record<string, unknown>, table: string, column: string): number => {
  const value = row[column];
  // PostgREST devuelve los `numeric` de PostgreSQL como TEXTO en el driver JSON,
  // no como number: `numeric` no cabe en un double sin perder precisión y el
  // transporte no lo convierte. Por eso se acepta el string y se parsea, en vez de
  // asumir un number que puede no venir.
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw schemaDrift(table, column, { details: value });
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw schemaDrift(table, column, { details: value });
    return parsed;
  }
  throw schemaDrift(table, column, { details: value });
};

/** `NUMERIC(18,2)` de PostgreSQL -> `Money` en centavos. */
const readMoney = (row: Record<string, unknown>, table: string, column: string) =>
  pesosToMoney(readNumber(row, table, column));

/**
 * Fecha de negocio (`date` de PostgreSQL), que PostgREST devuelve como
 * `YYYY-MM-DD`. Sin hora ni zona: un `Date` aqui seria un instante y coreria un
 * dia al cruzarse de zona (ADR-0012).
 */
const readIsoDate = (row: Record<string, unknown>, table: string, column: string): IsoDate => {
  const value = row[column];
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw schemaDrift(table, column, { details: value });
  }
  return value;
};

const readNullableIsoDate = (
  row: Record<string, unknown>,
  table: string,
  column: string,
): IsoDate | null => {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return readIsoDate(row, table, column);
};

/**
 * Referencia a la unidad de negocio de una fila.
 *
 * `null` cuando `business_unit_id` es NULL, y eso NO significa "sin unidad": las
 * vistas hacen `left join core.business_units` a proposito. Si el usuario no puede
 * leer unidades (`core.business_units` exige `org.read`), las cifras siguen
 * viéndose y lo que falta es la ETIQUETA. Devolver las cifras sin etiqueta es
 * mejor que devolverlas con una unidad equivocada, y mejor que no devolver nada.
 */
const readBusinessUnitRef = (
  row: Record<string, unknown>,
  table: string,
): BusinessUnitRef | null => {
  const id = row['business_unit_id'];
  if (id === null || id === undefined) return null;
  const unitId = readUuid(row, table, 'business_unit_id');
  const code = readNullableString(row, table, 'business_unit_code');
  const name = readNullableString(row, table, 'business_unit_name');
  // Sin codigo ni nombre la referencia no identifica nada: se trata como ausente.
  if (code === null || name === null) return null;
  return { id: unitId as BusinessUnitRef['id'], code, name };
};

/** Una fila de `finance.customer_receivables`. */
export const mapCustomerReceivableRowToDomain = (
  value: unknown,
  today: IsoDate,
): CustomerReceivable => {
  const row = readRecord(value, RECEIVABLES_VIEW);
  const balance = readMoney(row, RECEIVABLES_VIEW, 'balance');
  const paidAmount = readMoney(row, RECEIVABLES_VIEW, 'paid_amount');
  const dueDate = readIsoDate(row, RECEIVABLES_VIEW, 'due_date');

  // El estado y los dias de atraso los decide `resolveReceivableStatus` y
  // `daysOverdue`, las MISMAS funciones que usan las demas pantallas. Se calculan
  // aqui, en la frontera, y no en el componente: dos copias de esta regla divergen
  // el dia que alguien las toca en una sola de las dos, y el movil acaba
  // contradiciendo a la web sobre la misma fila.
  //
  // `today` la pasa la aplicacion (ADR-0012). Si aqui se usara `new Date()`, el
  // "vencidas" dependeria de la zona horaria del navegador.
  const resolved = resolveReceivableStatus({ balance, paidAmount, dueDate, today });

  return {
    id: readUuid(row, RECEIVABLES_VIEW, 'receivable_id') as CustomerReceivable['id'],
    customerId: readUuid(row, RECEIVABLES_VIEW, 'customer_id') as CustomerReceivable['customerId'],
    saleId: readUuid(row, RECEIVABLES_VIEW, 'sale_id') as CustomerReceivable['saleId'],
    businessUnit: readBusinessUnitRef(row, RECEIVABLES_VIEW),
    invoiceNumber: readString(row, RECEIVABLES_VIEW, 'invoice_number'),
    saleDate: readIsoDate(row, RECEIVABLES_VIEW, 'sale_date'),
    dueDate,
    paymentMethod: readString(
      row,
      RECEIVABLES_VIEW,
      'payment_method',
    ) as CustomerReceivable['paymentMethod'],
    originalAmount: readMoney(row, RECEIVABLES_VIEW, 'original_amount'),
    paidAmount,
    balance,
    paidAt: readNullableIsoDateTime(row, RECEIVABLES_VIEW, 'paid_at'),
    status: resolved.status,
    statusLabel: resolved.label,
    daysOverdue: daysOverdue(dueDate, today),
    createdAt: readIsoDateTime(row, RECEIVABLES_VIEW, 'created_at'),
  };
};

/** Una fila de `finance.customer_payments`. */
export const mapCustomerPaymentRowToDomain = (value: unknown): CustomerPayment => {
  const row = readRecord(value, PAYMENTS_VIEW);
  return {
    id: readUuid(row, PAYMENTS_VIEW, 'payment_id') as CustomerPayment['id'],
    customerId: readUuid(row, PAYMENTS_VIEW, 'customer_id') as CustomerPayment['customerId'],
    paymentDate: readIsoDate(row, PAYMENTS_VIEW, 'payment_date'),
    method: readString(row, PAYMENTS_VIEW, 'payment_method') as CustomerPayment['method'],
    amount: readMoney(row, PAYMENTS_VIEW, 'payment_amount'),
    unappliedAmount: readMoney(row, PAYMENTS_VIEW, 'unapplied_amount'),
    appliedAmount: readMoney(row, PAYMENTS_VIEW, 'applied_amount'),
    description: readNullableString(row, PAYMENTS_VIEW, 'description'),
    receivableId: readUuid(row, PAYMENTS_VIEW, 'receivable_id') as CustomerPayment['receivableId'],
    saleId: readUuid(row, PAYMENTS_VIEW, 'sale_id') as CustomerPayment['saleId'],
    businessUnit: readBusinessUnitRef(row, PAYMENTS_VIEW),
    invoiceNumber: readString(row, PAYMENTS_VIEW, 'invoice_number'),
    dueDate: readIsoDate(row, PAYMENTS_VIEW, 'due_date'),
    createdAt: readIsoDateTime(row, PAYMENTS_VIEW, 'created_at'),
  };
};

/** Una fila de `finance.customer_sales`. */
export const mapCustomerSaleRowToDomain = (value: unknown): CustomerSale => {
  const row = readRecord(value, SALES_VIEW);
  return {
    id: readUuid(row, SALES_VIEW, 'sale_id') as CustomerSale['id'],
    customerId: readUuid(row, SALES_VIEW, 'customer_id') as CustomerSale['customerId'],
    businessUnit: readBusinessUnitRef(row, SALES_VIEW),
    invoiceNumber: readString(row, SALES_VIEW, 'invoice_number'),
    saleDate: readIsoDate(row, SALES_VIEW, 'sale_date'),
    dueDate: readNullableIsoDate(row, SALES_VIEW, 'due_date'),
    paymentMethod: readString(row, SALES_VIEW, 'payment_method') as CustomerSale['paymentMethod'],
    subtotal: readMoney(row, SALES_VIEW, 'subtotal'),
    tax: readMoney(row, SALES_VIEW, 'tax'),
    total: readMoney(row, SALES_VIEW, 'total'),
    description: readNullableString(row, SALES_VIEW, 'description'),
    isVoided: readBoolean(row, SALES_VIEW, 'is_voided'),
    createdAt: readIsoDateTime(row, SALES_VIEW, 'created_at'),
  };
};

/**
 * Una fila de `finance.customer_financial_summary`.
 *
 * `organization_id` NO se lee ni se devuelve: el contexto de organizacion ya lo
 *vigila RLS, y un repositorio que lo guarda en el modelo es un repositorio que
 * algun dia lo usaria para filtrar, que es exactamente lo que no debe hacer
 * (ver la nota 1 de `repositories/customers.ts`).
 */
export const mapCustomerSummaryRowToDomain = (value: unknown): CustomerFinancialSummaryRow => {
  const row = readRecord(value, SUMMARY_FUNCTION);
  const consolidated = readBoolean(row, SUMMARY_FUNCTION, 'is_consolidated');

  // `business_unit` sale del mismo lector que en las otras filas. En la fila
  // consolidada el id es NULL y la etiqueta tambien: `is_consolidated` es lo que
  // dice "estas son todas las unidades", nunca "esta unidad no tiene nombre".
  return {
    businessUnit: readBusinessUnitRef(row, SUMMARY_FUNCTION),
    isConsolidated: consolidated,
    salesCount: readNumber(row, SUMMARY_FUNCTION, 'sales_count'),
    cashSalesCount: readNumber(row, SUMMARY_FUNCTION, 'cash_sales_count'),
    creditSalesCount: readNumber(row, SUMMARY_FUNCTION, 'credit_sales_count'),
    receivableCount: readNumber(row, SUMMARY_FUNCTION, 'receivable_count'),
    openCount: readNumber(row, SUMMARY_FUNCTION, 'open_count'),
    partialCount: readNumber(row, SUMMARY_FUNCTION, 'partial_count'),
    overdueCount: readNumber(row, SUMMARY_FUNCTION, 'overdue_count'),
    paidCount: readNumber(row, SUMMARY_FUNCTION, 'paid_count'),
    totalSold: readMoney(row, SUMMARY_FUNCTION, 'total_sold'),
    cashSalesTotal: readMoney(row, SUMMARY_FUNCTION, 'cash_sales_total'),
    creditBilled: readMoney(row, SUMMARY_FUNCTION, 'credit_billed'),
    totalPaid: readMoney(row, SUMMARY_FUNCTION, 'total_paid'),
    outstanding: readMoney(row, SUMMARY_FUNCTION, 'outstanding'),
    overdueOutstanding: readMoney(row, SUMMARY_FUNCTION, 'overdue_outstanding'),
    oldestOpenDueDate: readNullableIsoDate(row, SUMMARY_FUNCTION, 'oldest_open_due_date'),
  };
};
