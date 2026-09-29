/**
 * Ventas, pagos, cartera, gastos, inversiones y libro mayor (Fase 3).
 *
 * ADR-0003: venta (obligación comercial), pago (hecho de caja) y asiento
 * (libro mayor) son hechos distintos que la base registra A LA VEZ en una sola
 * transacción. Una venta guardada está contabilizada; no existe el "borrador".
 *
 * No se persiste NINGÚN estado ni saldo: "anulada", "cobrada", "pendiente" y el
 * saldo se DERIVAN del libro mayor (contra-asientos) y de las proyecciones
 * legibles (`paidAmount`, `unappliedAmount`) que solo mueven las funciones
 * SECURITY DEFINER de la base. Este módulo describe esas filas, no cálculos:
 * los cálculos viven en `@agroemprende/calculations` (misma regla de
 * redondeo), como manda el principio "ningún cálculo financiero en la pantalla".
 */
import type {
  BusinessUnitId,
  CustomerId,
  IsoDate,
  IsoDateTime,
  PaymentId,
  ReceivableId,
  SaleId,
  Uuid,
} from './common';
import type { Money, Quantity } from './money';

/** Cómo entra/sale el efectivo. Todo lo no efectivo se concilia en bancos (1110). */
export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'digital_wallet'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const RECEIVABLE_STATUSES = [
  'open',
  'partial',
  'paid',
  'overdue',
  'written_off',
  'void',
] as const;
export type ReceivableStatus = (typeof RECEIVABLE_STATUSES)[number];

export const PAYMENT_STATUSES = ['PAGADA', 'PARCIAL', 'PENDIENTE', 'VENCIDA'] as const;
/** Estados que ve el usuario final. El interno (`ReceivableStatus`) es más fino. */
export type UserFacingPaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Línea de una venta. El catálogo de productos aún no existe: línea lleva nombre libre. */
export interface SaleItem {
  readonly id: Uuid;
  readonly saleId: SaleId;
  readonly productName: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
}

/** Documento de venta. No se guarda estado: "postada" es que la fila existe. */
export interface Sale {
  readonly id: SaleId;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly invoiceNumber: string;
  readonly customerId: CustomerId;
  readonly saleDate: IsoDate;
  readonly dueDate: IsoDate;
  readonly paymentMethod: PaymentMethod;
  readonly subtotal: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly description: string | null;
  readonly createdBy: Uuid | null;
  readonly createdAt: IsoDateTime;
}

/** Cartera: lo que un cliente debe y cuánto lleva pagado (igual que el libro mayor). */
export interface Receivable {
  readonly id: ReceivableId;
  readonly organizationId: Uuid;
  readonly saleId: SaleId;
  readonly dueDate: IsoDate;
  readonly originalAmount: Money;
  readonly paidAmount: Money;
  readonly paidAt: IsoDateTime | null;
  readonly createdAt: IsoDateTime;
}

/** Hecho de caja. El exceso (`unappliedAmount`) es saldo a favor, nunca deuda negativa. */
export interface Payment {
  readonly id: PaymentId;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly paymentDate: IsoDate;
  readonly direction: 'inbound' | 'outbound';
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly unappliedAmount: Money;
  readonly description: string | null;
  readonly createdBy: Uuid | null;
  readonly createdAt: IsoDateTime;
}

/** Relación pago → deuda. Inmutable: corregir una asignación es un contra-pago. */
export interface PaymentAllocation {
  readonly id: Uuid;
  readonly paymentId: PaymentId;
  readonly allocationType: 'receivable' | 'payable';
  readonly allocationId: Uuid;
  readonly amount: Money;
  readonly createdAt: IsoDateTime;
}

/**
 * Asignación pedida por el cliente en `register_payment` (control fino).
 * Sin asignaciones, la base aplica FIFO por vencimiento de la deuda abierta.
 */
export interface PaymentAssignment {
  readonly type: 'receivable' | 'payable';
  readonly id: Uuid;
}

/** Cuenta por pagar: el crédito del proveedor que `register_payment` cancela. */
export interface Payable {
  readonly id: Uuid;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly originType: 'expense' | 'investment' | 'reinvestment';
  readonly originId: Uuid;
  readonly dueDate: IsoDate;
  readonly originalAmount: Money;
  readonly paidAmount: Money;
  readonly paidAt: IsoDateTime | null;
  readonly createdAt: IsoDateTime;
}

export const EXPENSE_TYPES = [
  'feed',
  'water',
  'health',
  'labor',
  'services',
  'financial',
  'other',
] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];

/** Gasto devengado. La cuenta NIF se deriva del tipo en `private.expense_account`. */
export interface Expense {
  readonly id: Uuid;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly expenseType: ExpenseType;
  readonly expenseDate: IsoDate;
  readonly description: string | null;
  readonly amount: Money;
  readonly paymentMethod: PaymentMethod;
  readonly createdBy: Uuid | null;
  readonly createdAt: IsoDateTime;
}

/** Inversión de activo (equipos, infraestructura): capitaliza en 1590. */
export interface Investment {
  readonly id: Uuid;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly investmentDate: IsoDate;
  readonly description: string | null;
  readonly amount: Money;
  readonly paymentMethod: PaymentMethod;
  readonly createdBy: Uuid | null;
  readonly createdAt: IsoDateTime;
}

/** Reinversión: decisión contable de capital, sin mover caja (3110 → 3120). */
export interface Reinvestment {
  readonly id: Uuid;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly reinvestmentDate: IsoDate;
  readonly description: string | null;
  readonly amount: Money;
  readonly createdBy: Uuid | null;
  readonly createdAt: IsoDateTime;
}

/** Cabecera de asiento del libro mayor. Inmutable. */
export interface LedgerEntry {
  readonly id: Uuid;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly entryDate: IsoDate;
  readonly entryType: 'sale' | 'payment' | 'expense' | 'investment' | 'reinvestment' | 'reversal';
  readonly sourceType: string;
  readonly sourceId: Uuid;
  readonly description: string | null;
  readonly createdBy: Uuid | null;
  readonly createdAt: IsoDateTime;
}

/** Línea de asiento: una cuenta, un lado, un importe. Nunca se actualiza ni se borra. */
export interface LedgerLine {
  readonly id: Uuid;
  readonly entryId: Uuid;
  readonly accountId: Uuid;
  readonly debit: Money;
  readonly credit: Money;
  readonly createdAt: IsoDateTime;
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
