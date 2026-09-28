import { describe, expect, it } from 'vitest';
import {
  addMoney,
  distributeMoney,
  formatMoney,
  growthRate,
  moneyToPesos,
  multiplyMoney,
  percentageOfMoney,
  pesosToMoney,
  subtractMoney,
  toMoney,
  unitPrice,
  ZERO,
} from '../src/money';

describe('money: conversión', () => {
  it('convierte pesos a centavos sin perder precisión', () => {
    expect(pesosToMoney(18_000)).toBe(1_800_000);
    expect(pesosToMoney(0)).toBe(0);
    expect(moneyToPesos(toMoney(1_800_000))).toBe(18_000);
  });

  it('redondea a centavos al convertir', () => {
    expect(pesosToMoney(18_000.555)).toBe(1_800_056);
  });
});

describe('money: aritmética exacta', () => {
  it('suma y resta importes sin error de coma flotante', () => {
    // Con float: 0.1 + 0.2 === 0.30000000000000004
    expect(addMoney(pesosToMoney(0.1), pesosToMoney(0.2))).toBe(pesosToMoney(0.3));
  });

  it('suma una lista de importes', () => {
    expect(addMoney(pesosToMoney(90_000), pesosToMoney(150_000), pesosToMoney(7_300_000))).toBe(
      pesosToMoney(7_540_000),
    );
  });

  it('resta correctamente', () => {
    expect(subtractMoney(pesosToMoney(90_000), pesosToMoney(40_000))).toBe(pesosToMoney(50_000));
  });

  it('permite resultado negativo en la resta (utilidad negativa)', () => {
    expect(subtractMoney(pesosToMoney(30_000), pesosToMoney(120_000))).toBe(pesosToMoney(-90_000));
  });

  it('multiplica cantidad por precio con redondeo contable', () => {
    // 18.000 COP × 5 cubetas = 90.000
    expect(multiplyMoney(pesosToMoney(18_000), 5)).toBe(pesosToMoney(90_000));
    // 600 COP × 30 huevos = 18.000
    expect(multiplyMoney(pesosToMoney(600), 30)).toBe(pesosToMoney(18_000));
    // 90.000 COP × 1,5 sacos = 135.000
    expect(multiplyMoney(pesosToMoney(90_000), 1.5)).toBe(pesosToMoney(135_000));
  });

  it('multiplica por cero', () => {
    expect(multiplyMoney(pesosToMoney(90_000), 0)).toBe(ZERO);
  });
});

describe('money: reparto sin perder centavos', () => {
  it('reparte 3.000 COP entre 3 clientes sin perder ni crear centavos', () => {
    const parts = distributeMoney(pesosToMoney(3_000), 3);
    expect(parts).toEqual([pesosToMoney(1_000), pesosToMoney(1_000), pesosToMoney(1_000)]);
    expect(addMoney(...parts)).toBe(pesosToMoney(3_000));
  });

  it('distribuye el resto entre las primeras partes', () => {
    // 10.000 centavos / 3 = 3.333,33 → la parte ideal es 3.333,33 y el centavo
    // sobrante (10.000 − 3×3.333 = 1) va a la primera parte.
    const parts = distributeMoney(pesosToMoney(100), 3);
    expect(parts).toEqual([pesosToMoney(33.34), pesosToMoney(33.33), pesosToMoney(33.33)]);
    expect(addMoney(...parts)).toBe(pesosToMoney(100));
  });

  it('lanza si las partes no son un entero positivo', () => {
    expect(() => distributeMoney(pesosToMoney(100), 0)).toThrow(RangeError);
    expect(() => distributeMoney(pesosToMoney(100), -2)).toThrow(RangeError);
    expect(() => distributeMoney(pesosToMoney(100), 2.5)).toThrow(RangeError);
  });
});

describe('money: unitario y porcentajes', () => {
  it('calcula el precio unitario', () => {
    expect(unitPrice(pesosToMoney(18_000), 30)).toBe(pesosToMoney(600));
  });

  it('redondea el unitario de forma consistente', () => {
    // 10.000 COP / 3 = 3.333,3333 COP → 3.333,33 COP (ROUND_HALF_UP)
    expect(unitPrice(pesosToMoney(10_000), 3)).toBe(pesosToMoney(3_333.33));
  });

  it('rechaza division por cero', () => {
    expect(() => unitPrice(pesosToMoney(10_000), 0)).toThrow(RangeError);
  });

  it('calcula porcentajes', () => {
    expect(percentageOfMoney(pesosToMoney(100_000), 16)).toBe(pesosToMoney(16_000));
  });

  it('devuelve null en variación desde cero en vez de dividir por cero', () => {
    expect(growthRate(pesosToMoney(50_000), ZERO)).toBeNull();
    expect(growthRate(pesosToMoney(55_000), pesosToMoney(50_000))).toBe(10);
    expect(growthRate(pesosToMoney(45_000), pesosToMoney(50_000))).toBe(-10);
  });
});

describe('money: formato para la interfaz', () => {
  it('formatea con separador de miles colombiano', () => {
    expect(formatMoney(pesosToMoney(18_000))).toBe('$18.000');
    expect(formatMoney(pesosToMoney(7_300_000))).toBe('$7.300.000');
    expect(formatMoney(ZERO)).toBe('$0');
  });

  it('formatea negativos y millones', () => {
    expect(formatMoney(pesosToMoney(-90_000))).toBe('-$90.000');
    expect(formatMoney(pesosToMoney(2_635_200))).toBe('$2.635.200');
  });
});
