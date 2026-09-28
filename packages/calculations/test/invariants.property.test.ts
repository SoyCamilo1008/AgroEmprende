/**
 * Pruebas de propiedades: verifican INVARIANTES, no ejemplos concretos.
 *
 * Si un refactor rompe la contabilidad, estas pruebas fallan aunque todos los
 * casos de ejemplo sigan pasando. Son la red de seguridad real del motor
 * financiero. Ver docs/testing.md.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { toMoney } from '@agroemprende/types';
import {
  addMoney,
  distributeMoney,
  multiplyMoney,
  pesosToMoney,
  subtractMoney,
} from '../src/money';
import { allocatePayments, calculateReceivableBalance, calculateSaleTotal } from '../src/sales';
import { calculateInventoryBalance, calculateWeightedAverageCost } from '../src/inventory';

/** Importe en centavos: entero, no negativo y razonable. */
const moneyArb = fc.integer({ min: 0, max: 100_000_000 }).map((cents) => toMoney(cents));

/** Cantidad de producto. */
const quantityArb = fc.integer({ min: 1, max: 10_000 });

describe('invariante: la aritmética monetaria es exacta', () => {
  it('(a + b) - b === a para cualquier importe', () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, (a, b) => {
        expect(subtractMoney(addMoney(a, b), b)).toBe(a);
      }),
    );
  });

  it('la suma es conmutativa y asociativa', () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, moneyArb, (a, b, c) => {
        expect(addMoney(a, b)).toBe(addMoney(b, a));
        expect(addMoney(addMoney(a, b), c)).toBe(addMoney(a, addMoney(b, c)));
      }),
    );
  });

  it('multiplicar por entero equivale a sumar esa cantidad de veces', () => {
    fc.assert(
      fc.property(moneyArb, fc.integer({ min: 0, max: 50 }), (amount, times) => {
        let repeated = 0;
        for (let index = 0; index < times; index += 1) repeated += amount;
        expect(multiplyMoney(amount, times)).toBe(repeated);
      }),
    );
  });
});

describe('invariante: repartir dinero ni lo pierde ni lo crea', () => {
  it('la suma de las partes es exactamente el importe original', () => {
    fc.assert(
      fc.property(moneyArb, fc.integer({ min: 1, max: 12 }), (amount, parts) => {
        const distributed = distributeMoney(amount, parts);
        expect(distributed).toHaveLength(parts);
        expect(addMoney(...distributed)).toBe(amount);
      }),
    );
  });

  it('ninguna parte difiere de la parte ideal en más de un centavo', () => {
    fc.assert(
      fc.property(moneyArb, fc.integer({ min: 1, max: 12 }), (amount, parts) => {
        const ideal = amount / parts;
        for (const part of distributeMoney(amount, parts)) {
          expect(Math.abs(part - ideal)).toBeLessThanOrEqual(1);
        }
      }),
    );
  });
});

describe('invariante: total de venta = suma de líneas − descuento', () => {
  const itemsArb = fc.array(fc.record({ quantity: quantityArb, unitPrice: moneyArb }), {
    minLength: 1,
    maxLength: 8,
  });

  it('se cumple para cualquier descuento válido', () => {
    fc.assert(
      fc.property(itemsArb, fc.integer({ min: 0, max: 100 }), (items, discountPercent) => {
        const lines = items.map((item) => ({
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        }));
        // El descuento se deriva del subtotal: un descuento mayor que el subtotal
        // es un dato inválido y `calculateSaleTotal` lo rechaza (se prueba
        // aparte), no un caso de este invariante.
        const subtotal = calculateSaleTotal({ items: lines }).subtotal;
        const discount = toMoney(Math.floor((subtotal * discountPercent) / 100));
        const totals = calculateSaleTotal({
          items: lines,
          discount: discount === 0 ? undefined : discount,
        });
        expect(totals.subtotal).toBe(subtotal);
        expect(totals.total).toBe(subtotal - discount);
        expect(totals.total).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('rechaza un descuento mayor que el subtotal en vez de dar un total negativo', () => {
    fc.assert(
      fc.property(itemsArb, (items) => {
        const lines = items.map((item) => ({
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        }));
        const subtotal = calculateSaleTotal({ items: lines }).subtotal;
        const excessive = addMoney(subtotal, toMoney(1));
        expect(() => calculateSaleTotal({ items: lines, discount: excessive })).toThrow(RangeError);
      }),
    );
  });
});

describe('invariante: saldo = original − abonos, nunca negativo', () => {
  it('se cumple para cualquier combinación de abono', () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, (original, paid) => {
        const balance = calculateReceivableBalance({ originalAmount: original, paidAmount: paid });
        expect(balance).toBe(Math.max(0, original - paid));
        expect(balance).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe('invariante: aplicar pagos nunca crea saldo negativo', () => {
  const payableArb = fc.record({
    balance: moneyArb,
    dueDate: fc.constantFrom('2026-01-01', '2026-06-15', '2026-12-31'),
  });

  it('lo aplicado a cada cuenta nunca supera su saldo', () => {
    fc.assert(
      fc.property(
        fc.array(payableArb, { minLength: 1, maxLength: 6 }),
        moneyArb,
        (payables, payment) => {
          const { allocations } = allocatePayments(
            payables.map((payable, index) => ({ ...payable, receivableId: `r${index}` })),
            payment,
          );
          for (const [index, payable] of payables.entries()) {
            const appliedToThis = allocations
              .filter((allocation) => allocation.paymentId === `r${index}`)
              .reduce((acc, allocation) => acc + allocation.amount, 0);
            expect(appliedToThis).toBeLessThanOrEqual(payable.balance);
          }
        },
      ),
    );
  });

  it('lo aplicado más lo no aplicado es exactamente el pago', () => {
    fc.assert(
      fc.property(
        fc.array(payableArb, { minLength: 1, maxLength: 6 }),
        moneyArb,
        (payables, payment) => {
          const { allocations, unapplied } = allocatePayments(
            payables.map((payable, index) => ({ ...payable, receivableId: `r${index}` })),
            payment,
          );
          const totalApplied = allocations.reduce((acc, allocation) => acc + allocation.amount, 0);
          const totalSaldo = payables.reduce((acc, payable) => acc + payable.balance, 0);
          expect(totalApplied + unapplied).toBe(payment);
          expect(totalApplied).toBeLessThanOrEqual(Math.min(payment, totalSaldo));
        },
      ),
    );
  });
});

describe('invariante: el inventario cuadra con los movimientos', () => {
  it('saldo = inicial + entradas − salidas para cualquier combinación', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000 }),
        fc.integer({ min: 0, max: 1_000 }),
        fc.integer({ min: 0, max: 1_000 }),
        (initial, inQty, outQty) => {
          const { quantity, isNegative } = calculateInventoryBalance({
            initialQuantity: initial,
            inQuantity: inQty,
            outQuantity: outQty,
          });
          expect(quantity).toBe(initial + inQty - outQty);
          expect(isNegative).toBe(quantity < 0);
        },
      ),
    );
  });

  it('el costo promedio ponderado siempre queda entre los dos costos de entrada', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        moneyArb,
        fc.integer({ min: 1, max: 10_000 }),
        moneyArb,
        (currentQty, currentCost, inQty, inCost) => {
          const result = calculateWeightedAverageCost({
            currentQuantity: currentQty,
            currentAverageCost: currentCost,
            inQuantity: inQty,
            inUnitCost: inCost,
          });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const { newQuantity, newAverageCost } = result.value;
          expect(newQuantity).toBe(currentQty + inQty);
          expect(newAverageCost).toBeGreaterThanOrEqual(Math.min(currentCost, inCost));
          expect(newAverageCost).toBeLessThanOrEqual(Math.max(currentCost, inCost));
        },
      ),
    );
  });
});

describe('invariante: coherencia entre pesos y centavos', () => {
  it('pesosToMoney(moneyToPesos(x)) === x para importes con centavos', () => {
    fc.assert(
      fc.property(moneyArb, (cents) => {
        expect(pesosToMoney(cents / 100)).toBe(cents);
      }),
    );
  });
});
