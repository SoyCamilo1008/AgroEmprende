/**
 * Aritmética monetaria.
 *
 * Principio §34: el dinero NUNCA es `float`. Todo importe se representa como
 * entero de centavos (`Money`), lo que hace exactas las sumas y restas
 * (0.1 + 0.2 === 0.3 en enteros, no en IEEE-754).
 *
 * Las divisiones usan `decimal.js` y una única regla de redondeo
 * (`ROUND_HALF_UP`, la práctica contable colombiana) declarada en un solo
 * lugar. Ver docs/decisions/ADR-0006.
 */
import Decimal from 'decimal.js';
import { toMoney, type Money, type Quantity } from '@agroemprende/types';

/**
 * Reexportado desde el paquete de tipos para que los módulos del motor no
 * dependan de la ruta interna de `@agroemprende/types`.
 */
export { toMoney };
export type { Money, Quantity };

export const ROUNDING_MODE = Decimal.ROUND_HALF_UP;

/** Convierte pesos (18.000) a centavos (1.800.000). */
export const pesosToMoney = (pesos: number): Money => toMoney(Math.round(pesos * 100));

/** Convierte centavos (1.800.000) a pesos (18.000). */
export const moneyToPesos = (amount: Money): number => amount / 100;

export const ZERO = toMoney(0);

/** Suma exacta de importes. */
export const addMoney = (...amounts: readonly Money[]): Money =>
  toMoney(amounts.reduce<number>((acc, amount) => acc + amount, 0));

/** Resta exacta. */
export const subtractMoney = (minuend: Money, subtrahend: Money): Money =>
  toMoney(minuend - subtrahend);

/**
 * Multiplica un importe por una cantidad con redondeo contable.
 * Ejemplo: precio 18.000 COP × 5 cubetas = 90.000 COP.
 */
export const multiplyMoney = (amount: Money, quantity: number): Money =>
  toMoney(new Decimal(amount).mul(quantity).toDecimalPlaces(0, ROUNDING_MODE).toNumber());

/**
 * Reparte un importe entre n partes sin perder ni crear centavos.
 *
 * Los centavos sobrantes se distribuyen de una en una entre las primeras
 * partes, de modo que la suma de las partes es EXACTAMENTE el importe original.
 * Esto evita que una venta de 3.000 COP entre 3 clientes produzca 33,33×3.
 */
export const distributeMoney = (amount: Money, parts: number): readonly Money[] => {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError(`distributeMoney: parts debe ser un entero positivo, recibido ${parts}`);
  }
  const basePart = Math.trunc(amount / parts);
  let remainder = amount - basePart * parts;
  const result: Money[] = [];
  for (let index = 0; index < parts; index += 1) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    result.push(toMoney(basePart + extra));
  }
  return result;
};

/**
 * Unitario: reparte el valor total en n unidades de la misma magnitud.
 * Para precio unitario real (por ejemplo costo por kilo) usa `unitPrice`.
 */
export const unitPrice = (total: Money, quantity: number): Money => {
  if (quantity === 0) {
    throw new RangeError('unitPrice: quantity no puede ser 0');
  }
  return toMoney(new Decimal(total).div(quantity).toDecimalPlaces(0, ROUNDING_MODE).toNumber());
};

/** Porcentaje de un importe, redondeado a centavos. Ej. IVA, margen. */
export const percentageOfMoney = (amount: Money, percentage: number): Money =>
  toMoney(
    new Decimal(amount).mul(percentage).div(100).toDecimalPlaces(0, ROUNDING_MODE).toNumber(),
  );

/** Tasa de variación porcentual entre dos importes. */
export const growthRate = (current: Money, previous: Money): number | null => {
  if (previous === 0) return null; // no se inventa una variación desde cero
  return new Decimal(current).minus(previous).div(previous).mul(100).toDecimalPlaces(2).toNumber();
};

/**
 * Formatea un importe a texto para la interfaz.
 * `9000000` centavos ? "$90.000". No usa `toLocaleString` para no depender de
 * los datos de configuración regional del dispositivo.
 */
export const formatMoney = (amount: Money, symbol = '$'): string => {
  const pesos = Math.abs(moneyToPesos(amount));
  const sign = amount < 0 ? '-' : '';
  const [integerPart = '0'] = String(pesos).split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${symbol}${grouped}`;
};
