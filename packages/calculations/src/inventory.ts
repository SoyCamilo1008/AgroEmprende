/**
 * Inventario: saldos y valoración por promedio ponderado.
 *
 * Decisión §13 del prompt + decisión del propietario: **promedio ponderado**.
 * Cada entrada recalcula el costo unitario promedio del ítem; las salidas usan
 * ese costo promedio. Ver docs/decisions/ADR-0008.
 *
 * Todos los saldos se derivan de `inventory_movements` (libro de movimientos,
 * append-only). Este módulo reproduce EXACTAMENTE la misma aritmética que
 * ejecuta SQL, de modo que el test de paridad web ↔ base de datos sea posible.
 */
import Decimal from 'decimal.js';
import type { InsufficientData, Money, Quantity } from '@agroemprende/types';
import { missing, ok } from '@agroemprende/types';
import { ROUNDING_MODE, toMoney, ZERO } from './money';

export interface InventoryBalanceInput {
  readonly initialQuantity: Quantity;
  readonly inQuantity: Quantity;
  readonly outQuantity: Quantity;
}

/**
 * Saldo de inventario.
 *
 * Si el resultado es negativo significa un problema de datos (venta sin
 * producción registrada, por ejemplo): se señala explícitamente en vez de
 * devolver 0 en silencio.
 */
export interface InventoryBalanceResult {
  readonly quantity: Quantity;
  readonly isNegative: boolean;
}

export const calculateInventoryBalance = (input: InventoryBalanceInput): InventoryBalanceResult => {
  const quantity = new Decimal(input.initialQuantity)
    .plus(input.inQuantity)
    .minus(input.outQuantity)
    .toNumber();
  return { quantity, isNegative: quantity < 0 };
};

export interface WeightedAverageInput {
  readonly currentQuantity: Quantity;
  readonly currentAverageCost: Money;
  readonly inQuantity: Quantity;
  /** Costo unitario de la entrada. */
  readonly inUnitCost: Money;
}

export interface WeightedAverageResult {
  readonly newQuantity: Quantity;
  readonly newAverageCost: Money;
}

/**
 * Costo promedio ponderado tras una entrada.
 *
 * Fórmula: (cantidad × costo actual + entrada × costo de entrada) ÷ cantidad total
 * Si no hay cantidad previa, el costo promedio es el de la entrada.
 */
export const calculateWeightedAverageCost = (
  input: WeightedAverageInput,
): InsufficientData<WeightedAverageResult> => {
  if (input.inQuantity < 0) {
    throw new RangeError(`calculateWeightedAverageCost: inQuantity negativa (${input.inQuantity})`);
  }
  if (input.currentQuantity < 0) {
    throw new RangeError(
      `calculateWeightedAverageCost: currentQuantity negativa (${input.currentQuantity})`,
    );
  }
  if (input.currentQuantity === 0 && input.inQuantity === 0) {
    return missing('inQuantity');
  }
  if (input.currentQuantity === 0) {
    return ok({
      newQuantity: input.inQuantity,
      newAverageCost: toMoney(input.inUnitCost),
    });
  }
  const currentValue = new Decimal(input.currentQuantity).mul(input.currentAverageCost);
  const incomingValue = new Decimal(input.inQuantity).mul(input.inUnitCost);
  const newQuantity = new Decimal(input.currentQuantity).plus(input.inQuantity);
  const newAverageCost = toMoney(
    currentValue.plus(incomingValue).div(newQuantity).toDecimalPlaces(0, ROUNDING_MODE).toNumber(),
  );
  return ok({ newQuantity: newQuantity.toNumber(), newAverageCost });
};

/** Valor total del inventario a costo promedio. */
export const calculateInventoryValue = (quantity: Quantity, averageCost: Money): Money =>
  toMoney(new Decimal(quantity).mul(averageCost).toDecimalPlaces(0, ROUNDING_MODE).toNumber());

/**
 * Costo de una salida de inventario.
 * Al promedio ponderado, el costo de venta de x unidades es x × costo promedio.
 */
export const calculateCostOfGoodsSold = (outQuantity: Quantity, averageCost: Money): Money =>
  toMoney(new Decimal(outQuantity).mul(averageCost).toDecimalPlaces(0, ROUNDING_MODE).toNumber());

/**
 * Trazabilidad de un corte de carne: kilo inicial, vendido, disponible.
 * Ejemplo (§30): inicial 20 kg, vendido 12 kg, disponible 8 kg.
 */
export interface MeatLotTrace {
  readonly initialWeightKg: Quantity;
  readonly soldWeightKg: Quantity;
  readonly remainingWeightKg: Quantity;
  readonly isFullySold: boolean;
}

export const traceMeatLot = (initialWeightKg: Quantity, soldWeightKg: Quantity): MeatLotTrace => {
  if (soldWeightKg < 0) {
    throw new RangeError(`traceMeatLot: soldWeightKg negativa (${soldWeightKg})`);
  }
  const remainingWeightKg = new Decimal(initialWeightKg)
    .minus(soldWeightKg)
    .toDecimalPlaces(3)
    .toNumber();
  return {
    initialWeightKg,
    soldWeightKg,
    remainingWeightKg,
    isFullySold: remainingWeightKg <= 0,
  };
};

/**
 * Rendimiento cárnico.
 *
 * Principio §29: SOLO se calcula si se registró el peso real de canal.
 * Si falta, devuelve `InsufficientData`. El sistema jamás estima el rendimiento.
 */
export const calculateCarcassYield = (
  liveWeightKg: Quantity | null,
  carcassWeightKg: Quantity | null,
): InsufficientData<Quantity> => {
  if (liveWeightKg === null) return missing('liveWeightKg');
  if (carcassWeightKg === null) return missing('carcassWeightKg');
  if (liveWeightKg <= 0) return missing('liveWeightKg');
  const percent = new Decimal(carcassWeightKg)
    .div(liveWeightKg)
    .mul(100)
    .toDecimalPlaces(2)
    .toNumber();
  return ok(percent);
};

/**
 * Ingreso potencial de un corte = peso real × precio configurado.
 * Si el peso real no existe, no se inventa: devuelve `InsufficientData`.
 */
export const calculateCutRevenue = (
  weightKg: Quantity | null,
  pricePerUnit: Money,
  priceUnitFactor: Quantity,
): InsufficientData<Money> => {
  if (weightKg === null) return missing('weightKg');
  if (weightKg <= 0) return missing('weightKg');
  const revenue = toMoney(
    new Decimal(pricePerUnit)
      .mul(weightKg)
      .mul(priceUnitFactor)
      .toDecimalPlaces(0, ROUNDING_MODE)
      .toNumber(),
  );
  return ok(revenue);
};

/** Merma: porcentaje de lo que se perdió sobre lo producido. */
export const calculateWasteRate = (produced: Quantity, wasted: Quantity): number | null => {
  if (produced <= 0) return null;
  return new Decimal(wasted).div(produced).mul(100).toDecimalPlaces(2).toNumber();
};

/** Verificación de cuadre entre Cortes y peso de canal. */
export interface CutsReconciliation {
  readonly cutsTotalKg: Quantity;
  readonly carcassWeightKg: Quantity | null;
  readonly differenceKg: Quantity | null;
  /** true si la suma de cortes cuadra con el peso de canal registrado. */
  readonly isBalanced: boolean | null;
}

export const reconcileCutsWithCarcass = (
  cuts: readonly { readonly weightKg: Quantity | null }[],
  carcassWeightKg: Quantity | null,
): CutsReconciliation => {
  const cutsTotalKg = cuts.reduce<number>((acc, cut) => acc + (cut.weightKg ?? 0), 0);
  if (carcassWeightKg === null) {
    return { cutsTotalKg, carcassWeightKg: null, differenceKg: null, isBalanced: null };
  }
  const differenceKg = new Decimal(cutsTotalKg)
    .minus(carcassWeightKg)
    .toDecimalPlaces(3)
    .toNumber();
  return {
    cutsTotalKg: new Decimal(cutsTotalKg).toDecimalPlaces(3).toNumber(),
    carcassWeightKg,
    differenceKg,
    isBalanced: Math.abs(differenceKg) < 0.001,
  };
};

/** Suma de dinero SIN valores faltantes: ignora `null` en vez de tratarlos como 0. */
export const sumKnownMoney = (amounts: readonly (Money | null)[]): Money => {
  let total = ZERO;
  for (const amount of amounts) {
    if (amount === null) continue;
    total = toMoney(total + amount);
  }
  return total;
};
