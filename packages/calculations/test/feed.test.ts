import { describe, expect, it } from 'vitest';
import { pesosToMoney, toMoney } from '../src/money';
import {
  calculateFeedConsumption,
  calculateFeedProgramCost,
  feedCostPerBird,
  feedCostPerEgg,
  summarizeFeedCosts,
} from '../src/feed';

const P = pesosToMoney;
const ITALCOL_40KG = 40;
const ITALCOL_PRICE = P(90_000);

describe('alimento: consumo de un lote', () => {
  it('calcula gramos, kg y sacos para 50 gallinas a 120 g/día', () => {
    // 50 × 120 = 6.000 g = 6 kg = 0,15 sacos de 40 kg
    const result = calculateFeedConsumption({
      birdsCount: 50,
      gramsPerBird: 120,
      bagWeightKg: ITALCOL_40KG,
      costPerBag: ITALCOL_PRICE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalGrams).toBe(6_000);
    expect(result.value.totalKg).toBe(6);
    expect(result.value.bagsEquivalent).toBe(0.15);
    // 0,15 sacos × 90.000 = 13.500
    expect(result.value.totalCost).toBe(P(13_500));
  });

  it('calcula consumo de 182 gallinas a 120 g/día', () => {
    const result = calculateFeedConsumption({
      birdsCount: 182,
      gramsPerBird: 120,
      bagWeightKg: ITALCOL_40KG,
      costPerBag: ITALCOL_PRICE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalGrams).toBe(21_840);
    expect(result.value.totalKg).toBe(21.84);
    expect(result.value.bagsEquivalent).toBe(0.546);
  });

  it('usa 90 g/día para aves jóvenes', () => {
    const adult = calculateFeedConsumption({
      birdsCount: 32,
      gramsPerBird: 120,
      bagWeightKg: ITALCOL_40KG,
      costPerBag: null,
    });
    const young = calculateFeedConsumption({
      birdsCount: 32,
      gramsPerBird: 90,
      bagWeightKg: ITALCOL_40KG,
      costPerBag: null,
    });
    expect(adult.ok && young.ok).toBe(true);
    if (!adult.ok || !young.ok) return;
    expect(young.value.totalGrams).toBe(2_880);
    expect(young.value.totalKg).toBe(2.88);
  });

  it('devuelve costo null cuando no hay precio registrado (no inventa)', () => {
    const result = calculateFeedConsumption({
      birdsCount: 50,
      gramsPerBird: 120,
      bagWeightKg: ITALCOL_40KG,
      costPerBag: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalCost).toBeNull();
    expect(result.value.totalKg).toBe(6);
  });

  it('marca el consumo como estimado si proviene del plan', () => {
    const result = calculateFeedConsumption({
      birdsCount: 6,
      gramsPerBird: 110,
      bagWeightKg: 40,
      costPerBag: null,
      isEstimated: true,
    });
    expect(result.ok && result.value.isEstimated).toBe(true);
  });

  it('pide el dato que falta en vez de devolver cero', () => {
    const result = calculateFeedConsumption({
      birdsCount: 50,
      gramsPerBird: null,
      bagWeightKg: ITALCOL_40KG,
      costPerBag: ITALCOL_PRICE,
    });
    expect(result).toEqual({ ok: false, missing: ['gramsPerBird'] });
  });

  it('valida las entradas', () => {
    expect(() =>
      calculateFeedConsumption({
        birdsCount: 0,
        gramsPerBird: 120,
        bagWeightKg: 40,
        costPerBag: null,
      }),
    ).toThrow(RangeError);
    expect(() =>
      calculateFeedConsumption({
        birdsCount: 10,
        gramsPerBird: 120,
        bagWeightKg: 0,
        costPerBag: null,
      }),
    ).toThrow(RangeError);
  });
});

describe('alimento: costos del periodo', () => {
  it('suma los costos conocidos y cuenta los que faltan precio', () => {
    const summary = summarizeFeedCosts([
      { totalCost: P(90_000) },
      { totalCost: P(45_000) },
      { totalCost: null },
    ]);
    expect(summary.totalCost).toBe(P(135_000));
    expect(summary.missingPriceCount).toBe(1);
  });

  it('ignora los nulos: NO los trata como cero real', () => {
    const summary = summarizeFeedCosts([{ totalCost: null }, { totalCost: null }]);
    expect(summary.totalCost).toBe(P(0));
    expect(summary.missingPriceCount).toBe(2);
  });
});

describe('alimento: costo unitario', () => {
  it('costo de alimento por ave', () => {
    expect(feedCostPerBird(P(90_000), 50)).toBe(P(1_800));
  });

  it('costo de alimento por huevo', () => {
    // 13.500 COP / 48 huevos = 281,25 COP por huevo (281,25 no se redondea a
    // 281: se redondea a centavos, y el centavo importa cuando se multiplica
    // por cientos de huevos del día).
    const result = feedCostPerEgg(P(13_500), 48);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(P(281.25));
  });

  it('pide el dato si no hubo producción registrada', () => {
    expect(feedCostPerEgg(P(13_500), 0)).toEqual({ ok: false, missing: ['eggsProduced'] });
  });

  it('programa estándar de cerdos: 3 sacos levante + 2 finalizador', () => {
    // (3 × 90.400) + (2 × 84.000) = 271.200 + 168.000 = 439.200
    const cost = calculateFeedProgramCost([
      { bagsPerPig: 3, costPerBag: P(90_400) },
      { bagsPerPig: 2, costPerBag: P(84_000) },
    ]);
    expect(cost).toBe(P(439_200));
  });

  it('costo del programa para 6 cerdos: 2.635.200', () => {
    const perPig = calculateFeedProgramCost([
      { bagsPerPig: 3, costPerBag: P(90_400) },
      { bagsPerPig: 2, costPerBag: P(84_000) },
    ]);
    expect(toMoney(perPig * 6)).toBe(P(2_635_200));
  });
});
