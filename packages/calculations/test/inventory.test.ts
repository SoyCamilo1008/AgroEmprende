import { describe, expect, it } from 'vitest';
import { pesosToMoney } from '../src/money';
import {
  calculateCarcassYield,
  calculateCostOfGoodsSold,
  calculateCutRevenue,
  calculateInventoryBalance,
  calculateInventoryValue,
  calculateWasteRate,
  calculateWeightedAverageCost,
  reconcileCutsWithCarcass,
  sumKnownMoney,
  traceMeatLot,
} from '../src/inventory';

const P = pesosToMoney;

describe('inventario: saldo', () => {
  it('calcula el saldo de un corte de carne', () => {
    const result = calculateInventoryBalance({
      initialQuantity: 20,
      inQuantity: 0,
      outQuantity: 12,
    });
    expect(result.quantity).toBe(8);
    expect(result.isNegative).toBe(false);
  });

  it('señala explícitamente un saldo negativo en vez de devolver cero', () => {
    const result = calculateInventoryBalance({
      initialQuantity: 5,
      inQuantity: 0,
      outQuantity: 8,
    });
    expect(result.quantity).toBe(-3);
    expect(result.isNegative).toBe(true);
  });
});

describe('inventario: promedio ponderado', () => {
  it('el primer lote define el costo promedio', () => {
    const result = calculateWeightedAverageCost({
      currentQuantity: 0,
      currentAverageCost: P(0),
      inQuantity: 100,
      inUnitCost: P(90_000),
    });
    expect(result.ok && result.value).toEqual({ newQuantity: 100, newAverageCost: P(90_000) });
  });

  it('recalcula el promedio al recibir una entrada más cara', () => {
    // 100 kg a 90.000  +  100 kg a 100.000  =  200 kg a 95.000
    const result = calculateWeightedAverageCost({
      currentQuantity: 100,
      currentAverageCost: P(90_000),
      inQuantity: 100,
      inUnitCost: P(100_000),
    });
    expect(result.ok && result.value).toEqual({ newQuantity: 200, newAverageCost: P(95_000) });
  });

  it('mantiene el costo con una entrada barata', () => {
    const result = calculateWeightedAverageCost({
      currentQuantity: 200,
      currentAverageCost: P(95_000),
      inQuantity: 100,
      inUnitCost: P(80_000),
    });
    expect(result.ok && result.value).toEqual({ newQuantity: 300, newAverageCost: P(90_000) });
  });

  it('pide el dato si no hay cantidad ni entrada', () => {
    expect(
      calculateWeightedAverageCost({
        currentQuantity: 0,
        currentAverageCost: P(0),
        inQuantity: 0,
        inUnitCost: P(0),
      }),
    ).toEqual({ ok: false, missing: ['inQuantity'] });
  });

  it('rechaza cantidades negativas', () => {
    expect(() =>
      calculateWeightedAverageCost({
        currentQuantity: -1,
        currentAverageCost: P(0),
        inQuantity: 1,
        inUnitCost: P(0),
      }),
    ).toThrow(RangeError);
  });
});

describe('inventario: valoración y costo de venta', () => {
  it('valor del inventario a costo promedio', () => {
    expect(calculateInventoryValue(200, P(95_000))).toBe(P(19_000_000));
  });

  it('costo de la mercadería vendida', () => {
    expect(calculateCostOfGoodsSold(12, P(95_000))).toBe(P(1_140_000));
  });

  it('trazabilidad de un corte: 20 kg inicial, 12 vendidos, 8 disponibles', () => {
    expect(traceMeatLot(20, 12)).toEqual({
      initialWeightKg: 20,
      soldWeightKg: 12,
      remainingWeightKg: 8,
      isFullySold: false,
    });
  });

  it('marca el lote como totalmente vendido', () => {
    expect(traceMeatLot(20, 20).isFullySold).toBe(true);
  });

  it('rechaza ventas negativas', () => {
    expect(() => traceMeatLot(20, -1)).toThrow(RangeError);
  });
});

describe('carne: rendimiento SIN inventar datos', () => {
  it('calcula el rendimiento solo con peso de canal real', () => {
    const result = calculateCarcassYield(115, 78);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(67.83);
  });

  it('NO calcula rendimiento si falta el peso de canal', () => {
    expect(calculateCarcassYield(115, null)).toEqual({ ok: false, missing: ['carcassWeightKg'] });
  });

  it('NO calcula rendimiento si falta el peso vivo', () => {
    expect(calculateCarcassYield(null, 78)).toEqual({ ok: false, missing: ['liveWeightKg'] });
  });

  it('rechaza peso vivo cero o negativo', () => {
    expect(calculateCarcassYield(0, 78)).toEqual({ ok: false, missing: ['liveWeightKg'] });
  });

  it('ingreso potencial de un corte solo con peso real', () => {
    // 18 kg × 2,20462 lb/kg × 12.000 COP/lb = 47.619.792 centavos
    const result = calculateCutRevenue(18, P(12_000), 2.20462);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(47_619_792);
  });

  it('pide el peso real del corte', () => {
    expect(calculateCutRevenue(null, P(12_000), 2.20462)).toEqual({
      ok: false,
      missing: ['weightKg'],
    });
  });
});

describe('carne: cuadre de cortes', () => {
  it('detecta que la suma de cortes cuadra con la canal', () => {
    const result = reconcileCutsWithCarcass(
      [{ weightKg: 18 }, { weightKg: 10 }, { weightKg: 7 }, { weightKg: 8 }, { weightKg: 12 }],
      55,
    );
    expect(result.cutsTotalKg).toBe(55);
    expect(result.isBalanced).toBe(true);
    expect(result.differenceKg).toBe(0);
  });

  it('señala el faltante cuando los cortes no cuadran', () => {
    const result = reconcileCutsWithCarcass([{ weightKg: 18 }, { weightKg: 10 }], 55);
    expect(result.differenceKg).toBe(-27);
    expect(result.isBalanced).toBe(false);
  });

  it('devuelve isBalanced null mientras no haya peso de canal', () => {
    const result = reconcileCutsWithCarcass([{ weightKg: 18 }, { weightKg: null }], null);
    expect(result.isBalanced).toBeNull();
    expect(result.cutsTotalKg).toBe(18);
  });
});

describe('inventario: utilidades de apoyo', () => {
  it('tasa de merma', () => {
    expect(calculateWasteRate(100, 3)).toBe(3);
    expect(calculateWasteRate(0, 3)).toBeNull();
  });

  it('suma ignorando nulos en lugar de contarlos como cero', () => {
    expect(sumKnownMoney([P(10_000), null, P(20_000)])).toBe(P(30_000));
  });
});
