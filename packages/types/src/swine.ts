/**
 * Cerdos: ciclos, animales individuales, pesos, alimento, salud, sacrificio
 * y cortes.
 *
 * Principio §21: cada cerdo tiene identidad individual (no cantidades
 * globales). Principio §29: NO se inventa rendimiento cárnico. Por eso
 * `carcassWeightKg` y `cut.weightKg` son NULL hasta que el usuario registre
 * el peso real obtenido.
 */
import type { BusinessUnitId, IsoDate, IsoDateTime, PigCycleId, PigId, Uuid } from './common';
import type { Money, Quantity } from './money';

export const PIG_STATUSES = [
  'active',
  'growing',
  'ready',
  'slaughtered',
  'sold_alive',
  'deceased',
  'culled',
] as const;
export type PigStatus = (typeof PIG_STATUSES)[number];

export const PIG_CYCLE_STATUSES = ['planning', 'active', 'closing', 'closed'] as const;
/** Cerrar un ciclo NO lo elimina: queda consultable en el historial. */
export type PigCycleStatus = (typeof PIG_CYCLE_STATUSES)[number];

/**
 * Cortes de cerdo. `code` es el nombre comercial; el precio NO está aquí
 * (vive en `catalog.product_prices` con vigencia) para poder ajustarlo.
 */
export const PIG_CUT_CODES = [
  'pierna',
  'costilla',
  'canon',
  'tocino',
  'papada',
  'hueso_espinazo',
  'pezuna_osobuco',
  'otro',
] as const;
export type PigCutCode = (typeof PIG_CUT_CODES)[number];

export interface PigCycle {
  readonly id: PigCycleId;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly name: string;
  readonly startDate: IsoDate;
  readonly plannedEndDate: IsoDate | null;
  readonly endDate: IsoDate | null;
  readonly status: PigCycleStatus;
  readonly pigsCount: number;
  /** Snapshot financiero congelado al cerrar el ciclo. */
  readonly costsTotal: Money | null;
  readonly revenueTotal: Money | null;
  readonly netProfit: Money | null;
  readonly closedAt: IsoDateTime | null;
  readonly closedBy: Uuid | null;
  readonly closureNotes: string | null;
}

export interface Pig {
  readonly id: PigId;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  /** Identificador individual, único en la organización (ej. CERDO-001). */
  readonly code: string;
  readonly name: string | null;
  readonly cycleId: PigCycleId | null;
  readonly entryDate: IsoDate;
  readonly breed: string | null;
  readonly supplierId: Uuid | null;
  readonly initialWeightKg: Quantity | null;
  readonly purchasePrice: Money | null;
  readonly targetWeightKg: Quantity | null;
  readonly status: PigStatus;
  readonly notes: string | null;
}

export interface PigWeightRecord {
  readonly id: Uuid;
  readonly pigId: PigId;
  readonly recordDate: IsoDate;
  readonly weightKg: Quantity;
  /** Cómo se obtuvo: báscula real, estimación, fórmula. No se mezcla. */
  readonly method: 'scale' | 'estimate' | 'formula';
  readonly notes: string | null;
}

export interface PigSlaughter {
  readonly id: Uuid;
  readonly pigId: PigId;
  readonly cycleId: PigCycleId | null;
  readonly slaughterDate: IsoDate;
  readonly liveWeightKg: Quantity | null;
  /** NULL hasta registrar el peso real de canal. */
  readonly carcassWeightKg: Quantity | null;
  /** Solo se calcula si existe `carcassWeightKg`; si no, es NULL. */
  readonly yieldPercent: Quantity | null;
  readonly slaughterCostsTotal: Money;
  readonly notes: string | null;
}

export interface PigCut {
  readonly id: Uuid;
  readonly slaughterId: Uuid;
  readonly code: PigCutCode;
  /** Peso REAL obtenido. NULL = todavía no pesado. */
  readonly weightKg: Quantity | null;
  readonly isEstimated: boolean;
  readonly notes: string | null;
}

/** Gastos de sacrificio: flexibles y explícitos. Nunca se inventan. */
export const SLAUGHTER_COST_TYPES = [
  'knives',
  'ice',
  'transport',
  'supplies',
  'external_labor',
  'other',
] as const;
export type SlaughterCostType = (typeof SLAUGHTER_COST_TYPES)[number];

export interface PigSlaughterCost {
  readonly id: Uuid;
  readonly slaughterId: Uuid;
  readonly type: SlaughterCostType;
  readonly description: string | null;
  readonly amount: Money;
}
