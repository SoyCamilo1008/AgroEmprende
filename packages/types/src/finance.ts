/**
 * Ventas, pagos y cuentas por cobrar.
 *
 * Principio §33: una venta NO es dinero recibido. Son dos hechos distintos:
 *  - `Sale`     →obligación comercial: genera ingreso y cuenta por cobrar.
 *  - `Payment`  → hecho de caja: reduce la cuenta por cobrar.
 *
 * Las dos cosas se registran en el libro mayor (docs/decisions/ADR-0003), por
 * eso el "ingreso" se contabiliza UNA sola vez.
 */
import type {
  BusinessUnitId,
  CustomerId,
  IsoDate,
  PaymentId,
  ReceivableId,
  SaleId,
  Uuid,
} from './common';
import type { MeasureUnit } from './units';
import type { Money, Quantity } from './money';

export const SALE_STATUSES = ['draft', 'posted', 'void'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const PAYMENT_METHODS = [
  'cash',
  'transfer',
  'nequi',
  'daviplata',
  'pse',
  'debit_card',
  'credit_card',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['PAGADA', 'PARCIAL', 'PENDIENTE', 'VENCIDA'] as const;
/** Estados que ve el usuario final. El interno (`ReceivableStatus`) es más fino. */
export type UserFacingPaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const RECEIVABLE_STATUSES = [
  'open',
  'partial',
  'paid',
  'overdue',
  'written_off',
  'void',
] as const;
export type ReceivableStatus = (typeof RECEIVABLE_STATUSES)[number];

export interface SaleItem {
  readonly id: Uuid;
  readonly saleId: SaleId;
  readonly productId: Uuid;
  readonly description: string;
  readonly quantity: Quantity;
  readonly unitOfMeasure: MeasureUnit;
  /** Precio unitario en la unidad de la línea. Editable en cada venta. */
  readonly unitPrice: Money;
  readonly lineTotal: Money;
  readonly businessUnitId: BusinessUnitId;
}

export interface Sale {
  readonly id: SaleId;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly customerId: CustomerId;
  readonly saleDate: IsoDate;
  readonly documentNumber: string | null;
  readonly status: SaleStatus;
  readonly subtotal: Money;
  readonly discount: Money;
  readonly total: Money;
  /** Suma de pagos aplicados. Nunca se recalcula "a ojo": lo mantiene el motor. */
  readonly paidAmount: Money;
  readonly balance: Money;
  readonly items: readonly SaleItem[];
  readonly notes: string | null;
}

export interface Payment {
  readonly id: PaymentId;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly customerId: CustomerId | null;
  readonly paymentDate: IsoDate;
  readonly amount: Money;
  readonly method: PaymentMethod;
  readonly direction: 'inbound' | 'outbound';
  /** Clave de idempotencia: impide registrar dos veces el mismo pago. */
  readonly idempotencyKey: string;
  readonly voidedAt: string | null;
  readonly notes: string | null;
}

export interface Receivable {
  readonly id: ReceivableId;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly customerId: CustomerId;
  readonly saleId: SaleId | null;
  readonly originalAmount: Money;
  readonly paidAmount: Money;
  readonly balance: Money;
  readonly issueDate: IsoDate;
  readonly dueDate: IsoDate;
  readonly status: ReceivableStatus;
}

/** Saldo de un cliente, con el desglose por unidad (nunca mezclado). */
export interface CustomerBalance {
  readonly customerId: CustomerId;
  readonly customerName: string;
  readonly total: Money;
  readonly byBusinessUnit: readonly {
    readonly businessUnitId: BusinessUnitId;
    readonly businessUnitCode: string;
    readonly balance: Money;
  }[];
}
