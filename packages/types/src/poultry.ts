/**
 * Ponedoras: lotes, producción diaria, alimento, agua, salud y descartes.
 *
 * Nota crítica §11: el precio de los huevos puede variar por venta. Por eso
 * `unitPrice` vive en la línea de venta, no en el lote ni en el producto.
 */
import type { BusinessUnitId, FlockId, IsoDate, Uuid } from './common';
import type { Money, Quantity } from './money';

export const FLOCK_STATUSES = [
  'planned',
  'arriving',
  'rearing',
  'laying',
  'culled',
  'closed',
] as const;
export type FlockStatus = (typeof FLOCK_STATUSES)[number];

export const FLOCK_MOVEMENT_TYPES = [
  'mortality',
  'cull',
  'addition',
  'transfer_in',
  'transfer_out',
  'adjustment',
] as const;
export type FlockMovementType = (typeof FLOCK_MOVEMENT_TYPES)[number];

export const FEED_PHASES = ['levante', 'postura', 'finalizador', 'concentrado'] as const;
export type FeedPhase = (typeof FEED_PHASES)[number];

/** Origen de un dato de consumo: estimado por plan o medido realmente. */
export const DATA_ORIGINS = ['measured', 'planned', 'reference'] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];

export interface Flock {
  readonly id: FlockId;
  readonly organizationId: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly code: string;
  readonly name: string;
  readonly breed: string | null;
  readonly supplierId: Uuid | null;
  readonly initialQuantity: number;
  readonly currentQuantity: number;
  readonly arrivalDate: IsoDate;
  /** Edad en semanas al momento del registro. La edad actual se CALCULA. */
  readonly initialAgeWeeks: number;
  readonly layStartDate: IsoDate | null;
  readonly status: FlockStatus;
  readonly purchasePriceTotal: Money;
  readonly notes: string | null;
}

export interface FlockMovement {
  readonly id: Uuid;
  readonly flockId: FlockId;
  readonly movementDate: IsoDate;
  readonly type: FlockMovementType;
  /** Siempre positiva; el tipo define el signo. */
  readonly quantity: number;
  readonly unitCost: Money | null;
  readonly reason: string | null;
  readonly notes: string | null;
}

export interface DailyProduction {
  readonly id: Uuid;
  readonly flockId: FlockId;
  readonly productionDate: IsoDate;
  readonly eggsGood: number;
  readonly eggsBroken: number;
  readonly eggsSmall: number;
  readonly notes: string | null;
  /** UNIQUE(flock_id, production_date): clave de la regla anti-duplicado offline. */
  readonly createdBy: Uuid;
}

export interface FeedConsumption {
  readonly id: Uuid;
  readonly flockId: FlockId;
  readonly consumptionDate: IsoDate;
  readonly feedProductId: Uuid;
  readonly birdsCount: number;
  /** NULL si no se conoce: se pide el dato, no se inventa (§70). */
  readonly gramsPerBird: Quantity | null;
  readonly totalGrams: Quantity | null;
  readonly totalKg: Quantity | null;
  readonly bagsEquivalent: Quantity | null;
  readonly unitCost: Money | null;
  readonly totalCost: Money | null;
  readonly origin: DataOrigin;
  readonly notes: string | null;
}

export interface WaterConsumption {
  readonly id: Uuid;
  readonly businessUnitId: BusinessUnitId;
  readonly flockId: FlockId | null;
  readonly recordDate: IsoDate;
  readonly liters: Quantity | null;
  readonly unitCostPerLiter: Money | null;
  readonly totalCost: Money | null;
  readonly tankCapacityLiters: Quantity | null;
  readonly refillIntervalDays: number | null;
  readonly origin: DataOrigin;
  readonly notes: string | null;
}

export interface Disposal {
  readonly id: Uuid;
  readonly flockId: FlockId;
  readonly disposalDate: IsoDate;
  readonly quantity: number;
  readonly unitPrice: Money | null;
  readonly total: Money | null;
  /** Destino de las aves: venta, consumo propio, regalo, descarte. */
  readonly destination: 'sale' | 'own_consumption' | 'given_away' | 'discarded';
  readonly notes: string | null;
}
