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
 * Si cambias una columna ahí, cámbiala aquí: no hay generación automática que lo
 * haga por ti.
 */
import type { Customer, CustomerContact, IsoDateTime } from '@agroemprende/types';
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
