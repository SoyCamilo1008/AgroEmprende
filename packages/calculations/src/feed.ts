/**
 * Consumo de alimento.
 *
 * Principio §13: el sistema calcula gramos, kg, sacos equivalentes y costo,
 * pero ADMITE registrar el consumo real. Si no hay precio registrado, el costo
 * se devuelve como `null` — nunca se inventa un precio (§14, §70).
 *
 * Reglas de redondeo aplicadas de forma consistente:
 *   - gramos: 2 decimales
 *   - kg: 3 decimales
 *   - sacos equivalentes: 4 decimales
 *   - costo total: centavos enteros
 */
import Decimal from 'decimal.js';
import { missing, ok, type InsufficientData, type Money, type Quantity } from '@agroemprende/types';
import { multiplyMoney, ROUNDING_MODE, toMoney, ZERO } from './money';

export interface FeedConsumptionInput {
  readonly birdsCount: number;
  /** Gramos por ave. NULL si no se conoce: el resultado será `insufficient`. */
  readonly gramsPerBird: Quantity | null;
  /** Peso de la bolsa en kg (40 para Italcol). */
  readonly bagWeightKg: Quantity;
  /** Costo por bolsa. NULL si aún no hay precio registrado. */
  readonly costPerBag: Money | null;
  /** Si es true, el consumo provino del plan y no de una medición real. */
  readonly isEstimated?: boolean;
}

export interface FeedConsumptionResult {
  readonly totalGrams: Quantity;
  readonly totalKg: Quantity;
  readonly bagsEquivalent: Quantity;
  /** NULL cuando no hay precio registrado: NO se inventa. */
  readonly totalCost: Money | null;
  readonly isEstimated: boolean;
}

/**
 * Calcula el consumo de alimento de un lote.
 *
 * Si falta `gramsPerBird` devuelve `InsufficientData` con el dato que falta,
 * para que la interfaz pida el valor en vez de mostrar un cero engañoso.
 */
export const calculateFeedConsumption = (
  input: FeedConsumptionInput,
): InsufficientData<FeedConsumptionResult> => {
  if (input.birdsCount <= 0) {
    throw new RangeError(`calculateFeedConsumption: birdsCount debe ser > 0 (${input.birdsCount})`);
  }
  if (input.bagWeightKg <= 0) {
    throw new RangeError(
      `calculateFeedConsumption: bagWeightKg debe ser > 0 (${input.bagWeightKg})`,
    );
  }
  if (input.gramsPerBird === null) {
    return missing('gramsPerBird');
  }

  const decimal = new Decimal(input.birdsCount).mul(input.gramsPerBird);
  const totalGrams = decimal.toDecimalPlaces(2, ROUNDING_MODE).toNumber();
  const totalKg = decimal.div(1000).toDecimalPlaces(3, ROUNDING_MODE).toNumber();
  const bagsEquivalent = new Decimal(totalKg)
    .div(input.bagWeightKg)
    .toDecimalPlaces(4, ROUNDING_MODE)
    .toNumber();

  const totalCost =
    input.costPerBag === null
      ? null
      : toMoney(
          new Decimal(input.costPerBag)
            .mul(bagsEquivalent)
            .toDecimalPlaces(0, ROUNDING_MODE)
            .toNumber(),
        );

  return ok({
    totalGrams,
    totalKg,
    bagsEquivalent,
    totalCost,
    isEstimated: input.isEstimated ?? false,
  });
};

/**
 * Costo de alimento de un periodo a partir de los consumos registrados.
 * Suma solo los costos que existen: un consumo sin precio NO se trata como 0
 * (sería inventar un dato), se excluye y se reporta como faltante.
 */
export const summarizeFeedCosts = (
  consumptions: readonly { readonly totalCost: Money | null }[],
): { readonly totalCost: Money; readonly missingPriceCount: number } => {
  let total = ZERO;
  let missingPriceCount = 0;
  for (const consumption of consumptions) {
    if (consumption.totalCost === null) {
      missingPriceCount += 1;
      continue;
    }
    total = toMoney(total + consumption.totalCost);
  }
  return { totalCost: total, missingPriceCount };
};

/** Costo de alimento por ave, útil para el costo de producción del huevo. */
export const feedCostPerBird = (totalCost: Money, birdsCount: number): Money => {
  if (birdsCount <= 0) {
    throw new RangeError(`feedCostPerBird: birdsCount debe ser > 0 (${birdsCount})`);
  }
  return toMoney(
    new Decimal(totalCost).div(birdsCount).toDecimalPlaces(0, ROUNDING_MODE).toNumber(),
  );
};

/**
 * Costo de alimento por huevo producido.
 *
 * Es el indicador clave del módulo de ponedoras: cuánto cuesta producir un
 * huevo con la dieta actual.
 */
export const feedCostPerEgg = (totalCost: Money, eggsProduced: number): InsufficientData<Money> => {
  if (eggsProduced <= 0) {
    return missing('eggsProduced');
  }
  if (totalCost === ZERO) {
    return missing('totalCost');
  }
  return ok(
    toMoney(new Decimal(totalCost).div(eggsProduced).toDecimalPlaces(0, ROUNDING_MODE).toNumber()),
  );
};

/** Costo total de un programa de alimento (ej. 3 sacos levante + 2 finalizador). */
export const calculateFeedProgramCost = (
  stages: readonly { readonly bagsPerPig: number; readonly costPerBag: Money }[],
): Money => {
  let total = ZERO;
  for (const stage of stages) {
    if (stage.bagsPerPig <= 0) {
      throw new RangeError(
        `calculateFeedProgramCost: bagsPerPig debe ser > 0 (${stage.bagsPerPig})`,
      );
    }
    total = toMoney(total + multiplyMoney(stage.costPerBag, stage.bagsPerPig));
  }
  return total;
};
