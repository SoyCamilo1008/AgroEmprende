/**
 * Unidades de medida y su conversión.
 *
 * El proyecto mezcla kg (inventario de alimento y carne) con libras (precio de
 * cortes de cerdo) y con unidades de empaque (cubeta de 30 huevos, bolsa de
 * 40 kg). Las conversiones viven en la base de datos (`catalog.measure_units`)
 * y NO como constantes en el código, para poder corregir un factor histórico
 * sin desplegar. Ver docs/database/costing.md.
 */
import type { Quantity } from './money';

export const MEASURE_UNITS = [
  'unit',
  'tray',
  'dozen',
  'g',
  'kg',
  'ton',
  'bag',
  'liter',
  'm3',
  'lb',
  'day',
] as const;

export type MeasureUnit = (typeof MEASURE_UNITS)[number];

export interface MeasureUnitDefinition {
  readonly code: MeasureUnit;
  readonly name: string;
  /** Unidad base del mismo magnitud (kg para g/kg/ton; unit para unidades de conteo). */
  readonly baseCode: MeasureUnit;
  /** Cuántas unidades de `code` equivalen a 1 unidad de `baseCode`. */
  readonly factorToBase: Quantity;
  /** true si el producto se compra/vende en paquetes de esta unidad. */
  readonly isPack: boolean;
}
