import { describe, expect, it } from 'vitest';
import {
  calculateEggMargin,
  calculateLayingRate,
  eggsBetween,
  projectEggsOver,
  summarizeProduction,
  type ProductionDay,
} from '../src/production';

const day = (
  date: string,
  eggsGood: number,
  birds: number | null = 50,
  eggsBroken = 0,
  eggsSmall = 0,
): ProductionDay => ({ date, eggsGood, eggsBroken, eggsSmall, birds });

describe('producción: resumen del lote', () => {
  it('resume la producción de una semana', () => {
    const days = [
      day('2026-09-21', 48, 50, 1),
      day('2026-09-22', 49, 50),
      day('2026-09-23', 47, 50, 2),
      day('2026-09-24', 50, 50),
      day('2026-09-25', 48, 50),
      day('2026-09-26', 49, 50, 1),
      day('2026-09-27', 48, 50),
    ];
    const summary = summarizeProduction(days);
    expect(summary.daysRecorded).toBe(7);
    expect(summary.totalEggsGood).toBe(339);
    expect(summary.totalEggsBroken).toBe(4);
    // El total incluye mermas; el promedio NO (ver producción.ts).
    expect(summary.totalEggs).toBe(343);
    expect(summary.averageDaily).toBe(48.43);
    expect(summary.bestDay).toEqual({ date: '2026-09-24', eggs: 50 });
    expect(summary.worstDay).toEqual({ date: '2026-09-23', eggs: 47 });
  });

  it('el peor día se mide sobre huevos buenos, no sobre mermas', () => {
    // 10 buenos + 5 rotos = 15 huevos, pero solo 10 son producción vendible:
    // ese día NO debe aparecer como el mejor día del lote.
    const summary = summarizeProduction([day('2026-09-26', 40, 50), day('2026-09-27', 10, 50, 5)]);
    expect(summary.bestDay).toEqual({ date: '2026-09-26', eggs: 40 });
    expect(summary.worstDay).toEqual({ date: '2026-09-27', eggs: 10 });
    expect(summary.totalEggs).toBe(55);
    expect(summary.totalEggsGood).toBe(50);
    expect(summary.totalEggsBroken).toBe(5);
  });

  it('calcula huevos por ave por día', () => {
    const summary = summarizeProduction([day('2026-09-27', 48, 50)]);
    expect(summary.eggsPerBirdPerDay).toBe(0.96);
  });

  it('devuelve null por ave si no conoce el número de aves', () => {
    const summary = summarizeProduction([day('2026-09-27', 48, null)]);
    expect(summary.eggsPerBirdPerDay).toBeNull();
    expect(summary.averageDaily).toBe(48);
  });

  it('maneja una serie vacía sin romperse', () => {
    const summary = summarizeProduction([]);
    expect(summary.daysRecorded).toBe(0);
    expect(summary.averageDaily).toBe(0);
    expect(summary.eggsPerBirdPerDay).toBeNull();
    expect(summary.bestDay).toBeNull();
  });

  it('calcula el promedio de los últimos 7 días', () => {
    const days = Array.from({ length: 10 }, (_, index) =>
      day(`2026-09-${String(index + 18).padStart(2, '0')}`, index < 3 ? 30 : 40, 50),
    );
    const summary = summarizeProduction(days);
    expect(summary.last7DaysAverage).toBe(40);
    expect(summary.averageDaily).toBe(37);
  });
});

describe('producción: rango de fechas', () => {
  it('cuantiza huevos buenos en un rango inclusive', () => {
    const days = [day('2026-09-25', 10), day('2026-09-26', 20), day('2026-09-27', 30)];
    expect(eggsBetween(days, '2026-09-26', '2026-09-27')).toBe(50);
    expect(eggsBetween(days, '2026-09-01', '2026-09-30')).toBe(60);
    expect(eggsBetween(days, '2027-01-01', '2027-01-31')).toBe(0);
  });
});

describe('producción: porcentaje de postura', () => {
  it('calcula la postura con datos completos', () => {
    // 48 huevos / 50 gallinas / 1 día = 0,96 por ave; esperado 1,0 → 96 %
    const result = calculateLayingRate({
      eggsGood: 48,
      layingBirds: 50,
      expectedEggsPerBirdPerDay: 1,
      days: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.eggsPerBirdPerDay).toBe(0.96);
    expect(result.value.layingPercent).toBe(96);
  });

  it('calcula la postura semanal', () => {
    // 339 huevos / 50 gallinas / 7 días = 0,96857 huevos por ave y día
    // → 96,86 % de postura. El porcentaje usa el valor sin redondear: redondear
    // primero a 0,97 daba 97 % y ocultaba la diferencia real.
    const result = calculateLayingRate({
      eggsGood: 339,
      layingBirds: 50,
      expectedEggsPerBirdPerDay: 1,
      days: 7,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.layingPercent).toBe(96.86);
  });

  it('pide el dato si no se conocen las aves en postura', () => {
    expect(
      calculateLayingRate({
        eggsGood: 48,
        layingBirds: null,
        expectedEggsPerBirdPerDay: 1,
        days: 1,
      }),
    ).toEqual({ ok: false, missing: ['layingBirds'] });
  });

  it('pide el dato si no se conoce la producción esperada', () => {
    expect(
      calculateLayingRate({
        eggsGood: 48,
        layingBirds: 50,
        expectedEggsPerBirdPerDay: null,
        days: 1,
      }),
    ).toEqual({ ok: false, missing: ['expectedEggsPerBirdPerDay'] });
  });
});

describe('producción: proyección y margen', () => {
  it('proyecta la producción de un lote', () => {
    // 182 gallinas × 0,95 × 30 días
    expect(projectEggsOver(182, 0.95, 30)).toBe(5_187);
  });

  it('calcula el margen por huevo frente al precio de referencia', () => {
    // Precio 600 COP/huevo, costo de alimento 281,25 → margen 53 %
    const result = calculateEggMargin({ pricePerEgg: 600, feedCostPerEgg: 281.25 });
    expect(result.totalCostPerEgg).toBe(281.25);
    expect(result.marginPerEgg).toBe(318.75);
    expect(result.marginPercent).toBe(53.13);
  });

  it('devuelve margen negativo cuando el costo supera el precio', () => {
    const result = calculateEggMargin({ pricePerEgg: 600, feedCostPerEgg: 650 });
    expect(result.marginPerEgg).toBe(-50);
    expect(result.marginPercent).toBe(-8.33);
  });

  it('devuelve null de porcentaje cuando el precio es cero', () => {
    expect(calculateEggMargin({ pricePerEgg: 0, feedCostPerEgg: 100 }).marginPercent).toBeNull();
  });
});
