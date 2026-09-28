/**
 * Unidades de negocio (business units) y sus tipos.
 *
 * Principio §5 y §6: AgroEmprende es UNA plataforma. Ponedoras, Cerdos y los
 * futuros negocios (ganadería, pollos de engorde, piscicultura, agricultura)
 * son filas de `core.business_units`, no aplicaciones separadas.
 *
 * Cada movimiento financiero lleva `businessUnitId` y las finanzas de dos
 * unidades NUNCA se mezclan. Ver docs/decisions/ADR-0004.
 */
import type { BusinessUnitId, CurrencyCode } from './common';

export const BUSINESS_UNIT_TYPES = [
  'poultry_layers', // Ponedoras
  'broilers', // Pollos de engorde
  'swine', // Cerdos
  'cattle', // Ganadería
  'fish', // Piscicultura
  'crops', // Agricultura
  'other',
] as const;

export type BusinessUnitType = (typeof BUSINESS_UNIT_TYPES)[number];

export interface BusinessUnit {
  readonly id: BusinessUnitId;
  readonly organizationId: string;
  /** Código estable y legible: PONEDORAS, CERDOS. Es la clave de negocio. */
  readonly code: string;
  readonly name: string;
  readonly type: BusinessUnitType;
  /** Unidad superior, para agrupar fincas/actividades. */
  readonly parentId: BusinessUnitId | null;
  readonly currency: CurrencyCode;
  readonly isActive: boolean;
  readonly deletedAt: string | null;
}

/** Filtro de negocio para cualquier consulta financiera o productiva. */
export interface BusinessUnitScope {
  readonly businessUnitId: BusinessUnitId;
  /** true = la vistaRequested agrega todas las unidades (solo roles superiores). */
  readonly includeAll: boolean;
}
