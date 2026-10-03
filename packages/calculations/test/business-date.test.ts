/**
 * Pruebas de la fecha de negocio.
 *
 * El caso que importa no es "devuelve la fecha de hoy", sino "devuelve el 1 de octubre
 * cuando ya es el 2 en UTC". Las pruebas fijan el instante exacto para que el fallo
 * sea visible: con el reloj del sistema, esta función pasaria casi siempre, y el dia
 * que fallara seria el dia que nadie probaria.
 */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  businessDateIn,
  businessToday,
  DEFAULT_BUSINESS_TIME_ZONE,
} from '../src/business-date';

describe('businessDateIn', () => {
  it('devuelve el dia del negocio, no el dia UTC', () => {
    // 2026-10-02T03:30Z son las 10:30 p. m. del 1 de octubre en Bogota (UTC-5).
    // El instante ya es "2 de octubre" y el dia del negocio es "1 de octubre": si la
    // funcion devolviera el 2, toda la cartera, la postura y los ciclos quedarian
    // corridos un dia y el error seria invisible hasta que no cuadraran las cuentas.
    const instant = new Date('2026-10-02T03:30:00Z');
    expect(businessDateIn('America/Bogota', instant)).toBe('2026-10-01');
    // El mismo instante, en UTC, SI es 2 de octubre. La zona es lo unico que cambia.
    expect(businessDateIn('UTC', instant)).toBe('2026-10-02');
  });

  it('no adelanta el dia por la diferencia horaria', () => {
    // Medianoche en Bogota es 05:00Z: la mitad del mundo ve el dia siguiente.
    const instant = new Date('2026-10-02T05:00:00Z');
    expect(businessDateIn('America/Bogota', instant)).toBe('2026-10-02');
  });

  it('respeta una zona al oeste de UTC', () => {
    // En Lima (UTC-5) las 00:30Z del 2 de octubre son las 7:30 p. m. del 1.
    expect(businessDateIn('America/Lima', new Date('2026-10-02T00:30:00Z'))).toBe('2026-10-01');
  });

  it('devuelve YYYY-MM-DD con dos digitos de mes y dia', () => {
    // Un mes de un digito ("2026-1-05") no es una `IsoDate` y compararlo como texto
    // contra una fecha de PostgreSQL daria un filtro que nunca casa.
    const instant = new Date('2026-01-05T20:00:00Z');
    const result = businessDateIn('America/Bogota', instant);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).toBe('2026-01-05');
  });

  it('rellena con ceros un mes y un dia de un digito', () => {
    const instant = new Date('2026-03-07T15:00:00Z');
    expect(businessDateIn('America/Bogota', instant)).toBe('2026-03-07');
  });

  it('salta el cambio de dia en la frontera de medianoche', () => {
    const antes = new Date('2026-10-02T04:59:00Z');
    const despues = new Date('2026-10-02T05:00:00Z');
    expect(businessDateIn('America/Bogota', antes)).toBe('2026-10-01');
    expect(businessDateIn('America/Bogota', despues)).toBe('2026-10-02');
  });

  it('avisa si la zona horaria no existe', () => {
    // Fallar al arrancar es mejor que un "hoy" desplazado que nadie nota hasta que las
    // cuentas no cuadran.
    expect(() => businessDateIn('America/NoExiste', new Date())).toThrow(RangeError);
    expect(() => businessDateIn('America/NoExiste', new Date())).toThrow(/zona horaria invalida/);
  });

  it('avisa si el instante no es una fecha', () => {
    expect(() => businessDateIn('America/Bogota', new Date('no soy una fecha'))).toThrow(
      RangeError,
    );
  });
});

describe('businessToday', () => {
  it('usa la zona por defecto del proyecto', () => {
    const instant = new Date('2026-10-02T03:30:00Z');
    expect(businessToday(instant)).toBe(businessDateIn(DEFAULT_BUSINESS_TIME_ZONE, instant));
    expect(DEFAULT_BUSINESS_TIME_ZONE).toBe('America/Bogota');
  });

  it('no depende del reloj del sistema cuando se le pasa un instante', () => {
    const instant = new Date('2026-10-02T03:30:00Z');
    expect(businessToday(instant)).toBe('2026-10-01');
  });
});

describe('addDays', () => {
  it('suma dias de calendario', () => {
    expect(addDays('2026-10-01', 1)).toBe('2026-10-02');
    expect(addDays('2026-10-01', 30)).toBe('2026-10-31');
  });

  it('cruza el cambio de año', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('cruza un año bisiesto', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('devuelve la misma fecha con cero dias', () => {
    expect(addDays('2026-10-01', 0)).toBe('2026-10-01');
  });

  it('permite restar', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('no se corre un dia por el reloj local del servidor', () => {
    // La razon de usar UTC puro: `setDate` es local, y sumar sobre un `Date` en UTC
    // devolveria el 31 de diciembre al 1 de enero o al revés segun donde corra el
    // servidor. Aqui la respuesta no depende de donde corra.
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('avisa si la fecha no es una fecha de negocio', () => {
    expect(() => addDays('2026-1-1', 1)).toThrow(RangeError);
    expect(() => addDays('ayer', 1)).toThrow(RangeError);
    expect(() => addDays('2026-10-01T00:00:00Z', 1)).toThrow(RangeError);
  });

  it('avisa si los dias no son un entero', () => {
    // Un 1.5 dias no es una fecha de negocio: no existe "el dia 1,5 de octubre".
    expect(() => addDays('2026-10-01', 1.5)).toThrow(RangeError);
  });
});
