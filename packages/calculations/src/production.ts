/**
 * Producción de huevos e indicadores del lote.
 *
 * Principio §11: el sistema calcula huevos diarios, semanales, mensuales,
 * promedio diario, producción por gallina y porcentaje de postura.
 *
 * El porcentaje de postura se define sobre las gallinas EN PRODUCCIÓN
 * (edad mínima de postura). Si no se conoce la edad mínima, se devuelve
 * `InsufficientData` en lugar de dividir entre el total de aves.
 */
import { missing, ok, type InsufficientData } from '@agroemprende/types';

export interface ProductionDay {
  readonly date: string;
  readonly eggsGood: number;
  readonly eggsBroken: number;
  readonly eggsSmall: number;
  /** Aves vivas en ese día. Si es null, no se puede calcular por gallina. */
  readonly birds: number | null;
}

export interface ProductionSummary {
  readonly totalEggsGood: number;
  readonly totalEggsBroken: number;
  readonly totalEggs: number;
  readonly daysRecorded: number;
  readonly averageDaily: number;
  readonly bestDay: { readonly date: string; readonly eggs: number } | null;
  readonly worstDay: { readonly date: string; readonly eggs: number } | null;
  /** Huevos por ave por día. NULL si algún día no conoce el número de aves. */
  readonly eggsPerBirdPerDay: number | null;
  /** Vitrina de producción: cómo viene la postura. */
  readonly last7DaysAverage: number | null;
  readonly last30DaysAverage: number | null;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Agrega una serie de días de producción. */
export const summarizeProduction = (days: readonly ProductionDay[]): ProductionSummary => {
  const ordered = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let totalGood = 0;
  let totalBroken = 0;
  let best: ProductionSummary['bestDay'] = null;
  let worst: ProductionSummary['worstDay'] = null;
  let eggDaysSum = 0;
  let birdDaysSum = 0;
  let birdDaysCount = 0;

  for (const day of ordered) {
    // La "vitrina" de producción (promedio, mejor día, peor día, postura) se
    // calcula sobre huevos BUENOS. Los rotos y los pequeños son mermas: se
    // informan aparte y nunca se cuentan como producción, porque hacerlo
    // inflaría el mejor día y ocultaría el problema real del lote.
    const eggs = day.eggsGood;
    totalGood += day.eggsGood;
    totalBroken += day.eggsBroken;
    if (best === null || eggs > best.eggs) best = { date: day.date, eggs };
    if (worst === null || eggs < worst.eggs) worst = { date: day.date, eggs };
    if (day.birds !== null && day.birds > 0) {
      eggDaysSum += eggs;
      birdDaysSum += day.birds;
      birdDaysCount += 1;
    }
  }

  const daysRecorded = ordered.length;
  const totalSmall = ordered.reduce((acc, d) => acc + d.eggsSmall, 0);
  const totalEggs = totalGood + totalBroken + totalSmall;

  return {
    totalEggsGood: totalGood,
    totalEggsBroken: totalBroken,
    totalEggs,
    daysRecorded,
    averageDaily: daysRecorded > 0 ? round2(totalGood / daysRecorded) : 0,
    bestDay: best,
    worstDay: worst,
    eggsPerBirdPerDay:
      birdDaysCount > 0 && birdDaysSum > 0 ? round2(eggDaysSum / birdDaysSum) : null,
    last7DaysAverage: averageOfLast(ordered, 7),
    last30DaysAverage: averageOfLast(ordered, 30),
  };
};

const averageOfLast = (ordered: readonly ProductionDay[], window: number): number | null => {
  if (ordered.length === 0) return null;
  const slice = ordered.slice(-window);
  if (slice.length === 0) return null;
  const total = slice.reduce((acc, day) => acc + day.eggsGood, 0);
  return round2(total / slice.length);
};

/** Total de huevos en un rango de fechas (ambos extremos inclusive). */
export const eggsBetween = (days: readonly ProductionDay[], from: string, to: string): number =>
  days
    .filter((day) => day.date >= from && day.date <= to)
    .reduce((acc, day) => acc + day.eggsGood, 0);

export interface LayingRateInput {
  readonly eggsGood: number;
  /** Aves en edad de postura. */
  readonly layingBirds: number | null;
  /** Huevos por ave/día esperados (típicamente ~0.9-1.0). NULL si no se conoce. */
  readonly expectedEggsPerBirdPerDay: number | null;
  readonly days: number;
}

export interface LayingRateResult {
  readonly eggsPerBirdPerDay: number;
  /** Porcentaje de postura: huevos por ave ÷ máximo esperado. 0-100. */
  readonly layingPercent: number;
}

/**
 * Porcentaje de postura.
 *
 * Si no se conoce el número de aves en postura o la producción esperada,
 * devuelve `InsufficientData`: es preferible pedir el dato a mostrar un
 * porcentaje inventado que genere decisiones malas.
 */
export const calculateLayingRate = (input: LayingRateInput): InsufficientData<LayingRateResult> => {
  if (input.days <= 0) return missing('days');
  if (input.layingBirds === null) return missing('layingBirds');
  if (input.layingBirds <= 0) return missing('layingBirds');
  if (input.expectedEggsPerBirdPerDay === null) return missing('expectedEggsPerBirdPerDay');
  if (input.expectedEggsPerBirdPerDay <= 0) return missing('expectedEggsPerBirdPerDay');

  const eggsPerBirdPerDay = input.eggsGood / input.layingBirds / input.days;
  // El porcentaje se calcula con el valor SIN redondear. Redondear primero los
  // huevos por ave y después el porcentaje producía 97 % en vez de 96,86 %:
  // un error de 0,14 puntos que se acumula al reportar una semana o un mes.
  const layingPercent = round2((eggsPerBirdPerDay / input.expectedEggsPerBirdPerDay) * 100);
  return ok({ eggsPerBirdPerDay: round2(eggsPerBirdPerDay), layingPercent });
};

/** Simulación: cuántos huevos daría un lote a lo largo de N días. */
export const projectEggsOver = (birds: number, eggsPerBirdPerDay: number, days: number): number =>
  Math.round(birds * eggsPerBirdPerDay * days);

/** Margen por huevo, comparando precio de venta real contra costo total. */
export interface EggMarginInput {
  readonly pricePerEgg: number;
  readonly feedCostPerEgg: number;
  /** Otros costos por huevo (agua, salud, merma). Si no se conocen, 0 explícito. */
  readonly otherCostPerEgg?: number;
}

export interface EggMarginResult {
  readonly totalCostPerEgg: number;
  readonly marginPerEgg: number;
  readonly marginPercent: number | null;
}

export const calculateEggMargin = (input: EggMarginInput): EggMarginResult => {
  const other = input.otherCostPerEgg ?? 0;
  const totalCostPerEgg = round2(input.feedCostPerEgg + other);
  const marginPerEgg = round2(input.pricePerEgg - totalCostPerEgg);
  const marginPercent =
    input.pricePerEgg > 0 ? round2((marginPerEgg / input.pricePerEgg) * 100) : null;
  return { totalCostPerEgg, marginPerEgg, marginPercent };
};
