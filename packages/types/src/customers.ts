/**
 * Clientes y sus contactos.
 *
 * El cliente es GLOBAL entre unidades de negocio: pertenece a la organización,
 * no a una granja. Sus ventas se reparten en las líneas de detalle, que sí
 * llevan `businessUnitId`. Ver `SaleItem` en `./finance`.
 *
 * El saldo NO se guarda aquí: se deriva de `finance.receivables`. Un saldo
 * almacenado se desincroniza en cuanto una venta se anula o un pago se imputa a
 * otra cartera, y entonces la app le cobra dos veces a alguien.
 *
 * Lo que sí se guarda son los TÉRMINOS ACORDADOS (`creditDays`). Son un dato
 * comercial que alguien decidió, y de ahí el servidor deriva el vencimiento de
 * cada venta a crédito (`create_sale`). No hay `creditLimit` en pesos: un límite
 * de cartera y un plazo de pago son cosas distintas, y guardar solo uno hace que
 * el sistema asuma un acuerdo que nadie tomó. Ver
 * `supabase/migrations/20260928167000_customers_credit_days_impact.sql`.
 */
import type { CustomerId, IsoDateTime, OrganizationId, Uuid } from './common';

/**
 * Rango de `credit_days` permitido por el CHECK de la tabla. Los mismos números
 * están en la base; aquí se repiten para que el formulario no ofrezca plazos que
 * la base va a rechazar.
 */
export const CREDIT_DAYS_MIN = 0;
export const CREDIT_DAYS_MAX = 365;

/**
 * Cliente de la organización.
 *
 * `code`, `taxId` y `creditDays` admiten `null` a propósito: `null` en
 * `creditDays` significa "no hay plazo acordado", que es una respuesta
 * válida, mientras que `0` significa "se paga hoy". No son intercambiables.
 */
export interface Customer {
  readonly id: CustomerId;
  readonly organizationId: OrganizationId;
  /** Código interno de la granja. NULL si la granja no codifica a sus clientes. */
  readonly code: string | null;
  readonly name: string;
  /** NIT/NUI: solo dígitos, 6 a 15. NULL si el cliente no está formalizado. */
  readonly taxId: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: string | null;
  /**
   * Días de crédito acordados, copiados a cada venta a crédito en el momento de
   * crearla. NULL = todavía no hay acuerdo, o se cobra de contado. Cambiarlo aquí
   * NO altera las ventas ya emitidas.
   */
  readonly creditDays: number | null;
  readonly notes: string | null;
  readonly isActive: boolean;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

/**
 * Persona de contacto del cliente: dueño de compra, bodeguista, pagador.
 *
 * Se guardan aparte del cliente para no llenarlo de campos que casi siempre
 * están vacíos. `role` es texto libre a propósito: cada granja llama distinto a
 * esas personas y forzar un catálogo sería inventar una terminología que nadie
 * pidió.
 */
export interface CustomerContact {
  readonly id: Uuid;
  readonly organizationId: OrganizationId;
  readonly customerId: CustomerId;
  readonly name: string;
  /** Cargo o relación en texto libre ("Dueño de compra", "Bodega"). */
  readonly role: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  /** Solo un contacto principal por cliente. */
  readonly isPrimary: boolean;
  readonly notes: string | null;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}
