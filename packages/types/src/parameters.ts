/**
 * Parámetros de referencia: precios de referencia, supuestos de planificación
 * y datos técnicos medidos.
 *
 * Principio §69: hay que distinguir entre
 *   dato histórico | dato actual | precio de referencia | supuesto de
 *   planificación | configuración.
 *
 * "18.000 COP por cubeta" es un precio de planificación ACTUAL. No es el precio
 * histórico de todas las ventas. Por eso vive aquí con `dataKind: 'reference'`
 * y con vigencia, y las ventas reales guardan su propio precio unitario.
 *
 * Principio §70: si no existe el dato, no se inventa. Un parámetro puede estar
 * ausente; el sistema entonces lo pide o devuelve `InsufficientData`.
 */
import type { BusinessUnitId, IsoDate, Uuid } from './common';
import type { CurrencyCode } from './common';
import type { MeasureUnit } from './units';

export const DATA_KINDS = [
  'measured', // medido en campo
  'historical', // hecho consumado y registrado
  'reference', // precio de referencia actual
  'planned', // supuesto de planificación
  'configured', // parámetro del sistema
] as const;
export type DataKind = (typeof DATA_KINDS)[number];

export const PARAMETER_CATEGORIES = [
  'price_reference',
  'technical',
  'planning',
  'logistics',
  'capacity',
] as const;
export type ParameterCategory = (typeof PARAMETER_CATEGORIES)[number];

export interface ReferenceParameter {
  readonly id: Uuid;
  readonly organizationId: Uuid;
  /** NULL = parámetro de toda la organización. */
  readonly businessUnitId: BusinessUnitId | null;
  readonly key: string;
  readonly label: string;
  readonly category: ParameterCategory;
  readonly dataKind: DataKind;
  readonly numericValue: number | null;
  readonly textValue: string | null;
  readonly currency: CurrencyCode | null;
  readonly unitOfMeasure: MeasureUnit | null;
  readonly effectiveFrom: IsoDate | null;
  readonly effectiveTo: IsoDate | null;
  /** Por qué existe este valor y de dónde salió. Obligatorio. */
  readonly notes: string | null;
}
