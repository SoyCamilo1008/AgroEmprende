/**
 * Cálculos de venta.
 *
 * Principio §55: ningún cálculo financiero vive en una pantalla. Todas las
 * pantallas y funciones SQL usan estas funciones (o su equivalente en SQL con
 * la misma regla de redondeo).
 */
import { addMoney, multiplyMoney, subtractMoney, ZERO } from './money';
import type { Money } from '@agroemprende/types';
import type { ReceivableStatus, UserFacingPaymentStatus } from '@agroemprende/types';

export interface SaleItemInput {
  readonly quantity: number;
  /** Precio unitario ya en centavos (`Money`). */
  readonly unitPrice: Money;
  /** Descuento a nivel de línea, si aplica. */
  readonly discount?: Money;
}

export interface SaleTotals {
  readonly subtotal: Money;
  readonly discount: Money;
  readonly total: Money;
}

/** Total de una línea: cantidad × precio unitario − descuento de línea. */
export const calculateLineTotal = (item: SaleItemInput): Money => {
  if (item.quantity < 0) {
    throw new RangeError(`calculateLineTotal: quantity negativa (${item.quantity})`);
  }
  const gross = multiplyMoney(item.unitPrice, item.quantity);
  return subtractMoney(gross, item.discount ?? ZERO);
};

export interface CalculateSaleTotalInput {
  readonly items: readonly SaleItemInput[];
  /** Descuento a nivel de venta. */
  readonly discount?: Money;
}

/** Totales de una venta. El total NUNCA puede quedar negativo. */
export const calculateSaleTotal = (input: CalculateSaleTotalInput): SaleTotals => {
  if (input.items.length === 0) {
    return { subtotal: ZERO, discount: ZERO, total: ZERO };
  }
  const subtotal = input.items.reduce<Money>(
    (acc, item) => addMoney(acc, calculateLineTotal(item)),
    ZERO,
  );
  const discount = input.discount ?? ZERO;
  const total = subtractMoney(subtotal, discount);
  if (total < ZERO) {
    throw new RangeError('calculateSaleTotal: el total no puede ser negativo');
  }
  return { subtotal, discount, total };
};

export interface ReceivableBalanceInput {
  readonly originalAmount: Money;
  /** Suma de abonos aplicados. */
  readonly paidAmount: Money;
}

/** Saldo de una cuenta por cobrar. Invariante: nunca negativo. */
export const calculateReceivableBalance = (input: ReceivableBalanceInput): Money => {
  const balance = subtractMoney(input.originalAmount, input.paidAmount);
  return balance < ZERO ? ZERO : balance;
};

export interface ResolvedReceivableStatus {
  readonly status: ReceivableStatus;
  /** Lo que ve el usuario final: PAGADA / PARCIAL / PENDIENTE / VENCIDA. */
  readonly label: UserFacingPaymentStatus;
}

export interface ReceivableStatusInput {
  /** Saldo pendiente actual. */
  readonly balance: Money;
  /** Suma de abonos ya aplicados. Distingue PARCIAL de PENDIENTE. */
  readonly paidAmount: Money;
  readonly dueDate: string;
  readonly today: string;
}

/**
 * Estado de una cuenta por cobrar.
 *
 * Nota §15: los estados visibles son PAGADA, PARCIAL, PENDIENTE, VENCIDA.
 * El interno distingue `overdue` de `open` para poder consultar "pendiente
 * no vencido" y "vencido" por separado en los reportes de antigüedad.
 *
 * Se recibe el saldo y lo abonado (no solo el saldo) porque PENDIENTE y PARCIAL
 * se diferencian justamente por existir o no un abono: con el saldo solamente,
 * PENDIENTE nunca se alcanzaría.
 */
export const resolveReceivableStatus = (input: ReceivableStatusInput): ResolvedReceivableStatus => {
  if (input.balance === ZERO) return { status: 'paid', label: 'PAGADA' };
  if (input.dueDate < input.today) return { status: 'overdue', label: 'VENCIDA' };
  if (input.paidAmount > ZERO) return { status: 'partial', label: 'PARCIAL' };
  return { status: 'open', label: 'PENDIENTE' };
};

export interface PaymentAllocation {
  readonly paymentId: string;
  readonly amount: Money;
}

/**
 * Distribuye un pago entre varias cuentas por cobrar.
 *
 * Un cliente puede deber en varias unidades de negocio. El pago se aplica
 * primero a las cuentas más antiguas, y dentro de cada unidad nunca se mezcla
 * el saldo con otro negocio (principio §68).
 *
 * Devuelve las asignaciones y lo que queda sin aplicar (sobro del pago), que
 * puede convertirse en anticipo del cliente.
 */
export const allocatePayments = (
  payables: readonly {
    readonly receivableId: string;
    readonly balance: Money;
    readonly dueDate: string;
  }[],
  payment: Money,
): { allocations: readonly PaymentAllocation[]; unapplied: Money } => {
  if (payment < ZERO) {
    throw new RangeError('allocatePayments: el pago no puede ser negativo');
  }
  // Orden FIFO por vencimiento: lo más viejo primero.
  const ordered = [...payables].sort((a, b) =>
    a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0,
  );
  const allocations: PaymentAllocation[] = [];
  let remaining = payment;
  for (const payable of ordered) {
    if (remaining <= ZERO) break;
    const applied = remaining >= payable.balance ? payable.balance : remaining;
    if (applied > ZERO) {
      allocations.push({ paymentId: payable.receivableId, amount: applied });
      remaining = subtractMoney(remaining, applied);
    }
  }
  return { allocations, unapplied: remaining };
};

export const AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Días de atraso a partir de la fecha de vencimiento (0 si no ha vencido). */
export const daysOverdue = (dueDate: string, today: string): number => {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) {
    throw new RangeError(`daysOverdue: fechas inválidas (${dueDate}, ${today})`);
  }
  const days = Math.floor((now - due) / 86_400_000);
  return days > 0 ? days : 0;
};

/** Bucket de antigüedad para el reporte de cuentas por cobrar (§17). */
export const resolveAgingBucket = (dueDate: string, today: string): AgingBucket => {
  const days = daysOverdue(dueDate, today);
  if (days === 0) return 'current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
};
