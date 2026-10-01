import { describe, expect, it } from 'vitest';
import { toMoney } from '@agroemprende/types';
import { pesosToMoney } from '../src/money';
import {
  allocatePayments,
  calculateLineTotal,
  calculateReceivableBalance,
  calculateSaleTotal,
  daysOverdue,
  resolveAgingBucket,
  resolveReceivableStatus,
} from '../src/sales';

const P = pesosToMoney;

describe('ventas: totales', () => {
  it('calcula el total de una venta de huevos por cubetas', () => {
    // 5 cubetas × 18.000 = 90.000
    const result = calculateSaleTotal({
      items: [{ quantity: 5, unitPrice: P(18_000) }],
    });
    expect(result.subtotal).toBe(P(90_000));
    expect(result.total).toBe(P(90_000));
  });

  it('precio por huevo: 30 huevos a 600 = una cubeta de 18.000', () => {
    const result = calculateSaleTotal({
      items: [{ quantity: 30, unitPrice: P(600) }],
    });
    expect(result.total).toBe(P(18_000));
  });

  it('acepta precio distinto al de referencia (el precio se edita por venta)', () => {
    const result = calculateSaleTotal({
      items: [{ quantity: 5, unitPrice: P(20_000) }],
    });
    expect(result.total).toBe(P(100_000));
  });

  it('calcula el total de una venta de carne: 12 kg de pierna a 12.000 COP/libra', () => {
    // 1 kg = 2,20462 lb  →  12 kg = 26,45544 lb
    // 26,45544 lb × 12.000 COP = 317.465,28 COP = 31.746.528 centavos
    // El resultado es exacto al centavo: la venta de carne se calcula en
    // centavos, no en pesos truncados (28 centavos por venta sí se pierden).
    const pounds = 12 * 2.20462;
    const result = calculateSaleTotal({
      items: [{ quantity: pounds, unitPrice: P(12_000) }],
    });
    expect(result.total).toBe(toMoney(31_746_528));
  });

  it('aplica descuento de venta', () => {
    const result = calculateSaleTotal({
      items: [{ quantity: 2, unitPrice: P(18_000) }],
      discount: P(6_000),
    });
    expect(result.subtotal).toBe(P(36_000));
    expect(result.discount).toBe(P(6_000));
    expect(result.total).toBe(P(30_000));
  });

  it('aplica descuento de línea', () => {
    expect(calculateLineTotal({ quantity: 3, unitPrice: P(18_000), discount: P(4_000) })).toBe(
      P(50_000),
    );
  });

  it('devuelve ceros para una venta vacía', () => {
    expect(calculateSaleTotal({ items: [] })).toEqual({
      subtotal: P(0),
      discount: P(0),
      total: P(0),
    });
  });

  it('rechaza cantidades negativas', () => {
    expect(() => calculateLineTotal({ quantity: -1, unitPrice: P(18_000) })).toThrow(RangeError);
  });

  it('impide que el total sea negativo', () => {
    expect(() =>
      calculateSaleTotal({ items: [{ quantity: 1, unitPrice: P(18_000) }], discount: P(50_000) }),
    ).toThrow(RangeError);
  });
});

describe('cuentas por cobrar: saldo', () => {
  it('saldo de una venta totalmente pagada', () => {
    expect(calculateReceivableBalance({ originalAmount: P(90_000), paidAmount: P(90_000) })).toBe(
      P(0),
    );
  });

  it('saldo de una venta con pago parcial', () => {
    expect(calculateReceivableBalance({ originalAmount: P(90_000), paidAmount: P(40_000) })).toBe(
      P(50_000),
    );
  });

  it('nunca devuelve saldo negativo si el abono excede el total', () => {
    expect(calculateReceivableBalance({ originalAmount: P(90_000), paidAmount: P(100_000) })).toBe(
      P(0),
    );
  });
});

describe('cuentas por cobrar: estado', () => {
  it('PAGADA cuando el saldo es cero', () => {
    expect(
      resolveReceivableStatus({
        balance: P(0),
        paidAmount: P(90_000),
        dueDate: '2026-10-01',
        today: '2026-09-27',
      }),
    ).toEqual({ status: 'paid', label: 'PAGADA' });
  });

  // Una deuda saldada no está "vencida" por muy vencido que sea su vencimiento:
  // el saldo es cero y no hay nada que cobrar. La precedencia importa porque
  // `paid_at` se escribe exactamente en ese momento.
  it('PAGADA aunque el vencimiento ya haya pasado si no hay saldo', () => {
    expect(
      resolveReceivableStatus({
        balance: P(0),
        paidAmount: P(90_000),
        dueDate: '2026-09-01',
        today: '2026-09-27',
      }),
    ).toEqual({ status: 'paid', label: 'PAGADA' });
  });

  it('VENCIDA cuando ya pasó el vencimiento con saldo', () => {
    expect(
      resolveReceivableStatus({
        balance: P(50_000),
        paidAmount: P(40_000),
        dueDate: '2026-09-20',
        today: '2026-09-27',
      }),
    ).toEqual({ status: 'overdue', label: 'VENCIDA' });
  });

  it('PARCIAL cuando tiene abono y no ha vencido', () => {
    expect(
      resolveReceivableStatus({
        balance: P(50_000),
        paidAmount: P(40_000),
        dueDate: '2026-10-10',
        today: '2026-09-27',
      }),
    ).toEqual({ status: 'partial', label: 'PARCIAL' });
  });

  it('PENDIENTE cuando no hay abono y no ha vencido', () => {
    expect(
      resolveReceivableStatus({
        balance: P(90_000),
        paidAmount: P(0),
        dueDate: '2026-10-10',
        today: '2026-09-27',
      }),
    ).toEqual({ status: 'open', label: 'PENDIENTE' });
  });
});

describe('cuentas por cobrar: aplicación de pagos', () => {
  it('aplica el pago FIFO por vencimiento entre unidades de negocio', () => {
    const result = allocatePayments(
      [
        { receivableId: 'ponedoras-nueva', balance: P(30_000), dueDate: '2026-10-20' },
        { receivableId: 'cerdos-vieja', balance: P(90_000), dueDate: '2026-09-10' },
      ],
      P(100_000),
    );
    expect(result.allocations).toEqual([
      { paymentId: 'cerdos-vieja', amount: P(90_000) },
      { paymentId: 'ponedoras-nueva', amount: P(10_000) },
    ]);
    expect(result.unapplied).toBe(P(0));
  });

  it('reporta el sobrante como anticipo, sin inventar aplicaciones', () => {
    const result = allocatePayments(
      [{ receivableId: 'cx-1', balance: P(40_000), dueDate: '2026-09-10' }],
      P(150_000),
    );
    expect(result.allocations).toEqual([{ paymentId: 'cx-1', amount: P(40_000) }]);
    expect(result.unapplied).toBe(P(110_000));
  });

  it('no aplica nada si no hay cuentas pendientes', () => {
    const result = allocatePayments([], P(50_000));
    expect(result.allocations).toEqual([]);
    expect(result.unapplied).toBe(P(50_000));
  });
});

describe('cuentas por cobrar: antigüedad', () => {
  it('calcula días de atraso', () => {
    expect(daysOverdue('2026-09-17', '2026-09-27')).toBe(10);
    expect(daysOverdue('2026-09-30', '2026-09-27')).toBe(0);
  });

  it('clasifica en buckets de antigüedad', () => {
    // 27/09/2026 menos 27/08/2026 = 31 días; menos 28/07/2026 = 61 días.
    expect(resolveAgingBucket('2026-09-27', '2026-09-27')).toBe('current');
    expect(resolveAgingBucket('2026-09-17', '2026-09-27')).toBe('1-30');
    expect(resolveAgingBucket('2026-08-27', '2026-09-27')).toBe('31-60');
    expect(resolveAgingBucket('2026-07-28', '2026-09-27')).toBe('61-90');
    expect(resolveAgingBucket('2026-01-01', '2026-09-27')).toBe('90+');
  });

  it('rechaza fechas inválidas', () => {
    expect(() => daysOverdue('no-es-fecha', '2026-09-27')).toThrow(RangeError);
  });
});
