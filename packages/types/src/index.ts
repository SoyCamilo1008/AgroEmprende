/**
 * @agroemprende/types
 *
 * Tipos de dominio compartidos. Este paquete NO depende de React, de Supabase
 * ni de ningún framework: lo consumen por igual apps/web, apps/mobile, las
 * Edge Functions (Deno) y los tests de la lógica de negocio.
 */
export type {
  Branded,
  BusinessUnitId,
  CurrencyCode,
  CustomerId,
  FlockId,
  InsufficientData,
  InventoryLotId,
  IsoDate,
  IsoDateTime,
  JournalEntryId,
  OrganizationId,
  PaymentId,
  PigCycleId,
  PigId,
  ProductId,
  ReceivableId,
  SaleId,
  SupplierId,
  UserId,
  Uuid,
} from './common';
export { missing, ok } from './common';

export type { CurrencyCode as Currency } from './common';
export type { Money, MoneyAmount, Quantity } from './money';
export { toMoney } from './money';

export type { MeasureUnit, MeasureUnitDefinition } from './units';
export { MEASURE_UNITS } from './units';

export type { BusinessUnit, BusinessUnitScope, BusinessUnitType } from './business-units';
export { BUSINESS_UNIT_TYPES } from './business-units';

export type { Permission, Role, RoleDefinition } from './auth';
export { PERMISSIONS, ROLES } from './auth';

export type {
  CustomerBalance,
  Expense,
  ExpenseType,
  Investment,
  LedgerEntry,
  LedgerLine,
  Payable,
  Payment,
  PaymentAllocation,
  PaymentAssignment,
  PaymentMethod,
  Receivable,
  ReceivableStatus,
  Reinvestment,
  Sale,
  SaleItem,
  SaleSettlement,
  SettlementMethod,
  UserFacingPaymentStatus,
} from './finance';
export {
  EXPENSE_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  RECEIVABLE_STATUSES,
  SETTLEMENT_METHODS,
} from './finance';

export type {
  DailyProduction,
  DataOrigin,
  Disposal,
  FeedConsumption,
  FeedPhase,
  Flock,
  FlockMovement,
  FlockMovementType,
  FlockStatus,
  WaterConsumption,
} from './poultry';
export { DATA_ORIGINS, FEED_PHASES, FLOCK_MOVEMENT_TYPES, FLOCK_STATUSES } from './poultry';

export type {
  Pig,
  PigCycle,
  PigCycleStatus,
  PigCut,
  PigCutCode,
  PigSlaughter,
  PigSlaughterCost,
  PigStatus,
  PigWeightRecord,
  SlaughterCostType,
} from './swine';
export { PIG_CUT_CODES, PIG_CYCLE_STATUSES, PIG_STATUSES, SLAUGHTER_COST_TYPES } from './swine';

export type { DataKind, ParameterCategory, ReferenceParameter } from './parameters';
export { DATA_KINDS, PARAMETER_CATEGORIES } from './parameters';
