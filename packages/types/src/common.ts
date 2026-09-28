/**
 * Tipos primitivos del dominio.
 *
 * Decisión: las fechas de negocio (producción, venta, pago) son `IsoDate` en
 * formato `YYYY-MM-DD`, NUNCA `Date`. Un `Date` en JavaScript representa un
 * instante y depende de la zona horaria del navegador: usarlo para "el día en
 * que se vendió" produce corrimientos de un día. Ver docs/decisions/ADR-0012.
 */

/** Identificador UUID con marca de dominio (evita mezclar ids de tablas). */
export type Branded<T, B extends string> = T & { readonly __brand: B };

export type Uuid = string;
export type OrganizationId = Uuid;
export type BusinessUnitId = Uuid;
export type CustomerId = Uuid;
export type SupplierId = Uuid;
export type UserId = Uuid;
export type ProductId = Uuid;
export type SaleId = Uuid;
export type PaymentId = Uuid;
export type ReceivableId = Uuid;
export type FlockId = Uuid;
export type PigId = Uuid;
export type PigCycleId = Uuid;
export type InventoryLotId = Uuid;
export type JournalEntryId = Uuid;

/** Fecha de negocio en formato `YYYY-MM-DD`, interpretada en la zona del negocio. */
export type IsoDate = string;

/** Instante en ISO-8601 UTC (`2026-09-27T14:03:00.000Z`). */
export type IsoDateTime = string;

/** Códigos ISO 4217. v1 solo maneja COP. */
export type CurrencyCode = 'COP';

/**
 * Resultado de una operación de lectura que puede no tener dato suficiente.
 *
 * Principio §70: si falta un dato, el sistema lo pide o lo marca pendiente.
 * NUNCA lo inventa. Por eso los cálculos no reciben `default` sino este tipo.
 */
export type InsufficientData<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly missing: readonly string[] };

export const ok = <T>(value: T): InsufficientData<T> => ({ ok: true, value });
export const missing = (...fields: string[]): InsufficientData<never> => ({
  ok: false,
  missing: fields,
});
