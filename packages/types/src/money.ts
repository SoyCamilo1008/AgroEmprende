/**
 * Dinero.
 *
 * Principio §34: NUNCA `float` para cálculos financieros. En la base de datos
 * todo importe es `NUMERIC(18,2)`. En TypeScript el dinero se representa como
 * **enteros en centavos** (`Money`), lo que hace exactas las sumas y restas.
 *
 * Para divisiones (por ejemplo costo por kilo) se usa el motor de
 * cálculos, que aplica la regla de redondeo única del proyecto.
 *
 * Ver docs/decisions/ADR-0006.
 */
import type { CurrencyCode } from './common';

/**
 * Importe monetario entero expressed en la unidad mínima de la moneda
 * (para COP, centavos: 18.000 COP = 1_800_000).
 *
 * OJO: para COP los "centavos" son unidades de un peso, pero el tipo se llama
 * Money y se almacena en centésimas de la unidad mayor (÷100) de forma
 * uniforme, igual que USD. Ver docs/decisions/ADR-0006 para la justificación.
 */
export type Money = number & { readonly __brand: 'Money' };

/** Marca de que un `number` es un importe en centavos. Solo usar desde el motor. */
export const toMoney = (cents: number): Money => cents as Money;

/** Cantidad no monetaria (huevos, kilos, litros, gramos, sacos). Puede ser decimal. */
export type Quantity = number;

export interface MoneyAmount {
  readonly amount: Money;
  readonly currency: CurrencyCode;
}
