/**
 * @agroemprende/supabase
 *
 * Fábricas de cliente Supabase y la capa de acceso a datos de Clientes.
 * Centralizar el acceso a la base de datos permite cambiar de proveedor (o de
 * versión de SDK) en un solo lugar, en vez de dispersar `createClient` por todas
 * las pantallas.
 *
 * El cliente de SERVIDOR no vive aquí a propósito: depende de `next/headers` y
 * un paquete compartido no debe atarse a un framework concreto. El adaptador de
 * Next.js está en `apps/web/src/lib/supabase/server.ts`.
 *
 * La capa de datos (`./repositories/customers`) recibe el `SupabaseClient` de la
 * app en vez de crear el suyo: ese cliente ya trae la sesión y la cabecera
 * `x-organization-id`, que es el contexto de organización del que dependen las
 * políticas de RLS.
 */
export { parseSupabasePublicEnv, type SupabasePublicEnv } from './env';
export { createClient as createBrowserClient } from './browser';
export { createClient as createMobileClient } from './mobile';
export {
  DomainError,
  domainError,
  isDomainError,
  translatePostgrestError,
  type DomainErrorKind,
  type DomainErrorOptions,
  type PostgrestErrorLike,
} from './errors';
export {
  createCustomerRepository,
  CustomerRepository,
  CUSTOMER_SORT_COLUMNS,
  DEFAULT_CUSTOMER_PAGE_SIZE,
  MAX_CUSTOMER_PAGE_SIZE,
  buildSearchPattern,
  type CustomerListOptions,
  type CustomerPage,
  type CustomerSortColumn,
  type CustomerSummary,
} from './repositories/customers';
export {
  createCustomerFinanceRepository,
  CustomerFinanceRepository,
  DEFAULT_CUSTOMER_FINANCE_PAGE_SIZE,
  MAX_CUSTOMER_FINANCE_PAGE_SIZE,
  RECEIVABLE_SORT_COLUMNS,
  type CustomerReceivablesOptions,
  type ReceivableSortColumn,
} from './repositories/customer-finance';
