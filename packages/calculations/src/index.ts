/**
 * @agroemprende/calculations
 *
 * MOTOR DE CÁLCULO del proyecto. Funciones puras, sin IO, sin dependencias de
 * framework, con pruebas exhaustivas. Es la única fuente de verdad de los
 * cálculos financieros y productivos: las pantallas NO recalculan.
 */
export {
  addDays,
  businessDateIn,
  businessToday,
  DEFAULT_BUSINESS_TIME_ZONE,
} from './business-date';

export {
  addMoney,
  distributeMoney,
  formatMoney,
  growthRate,
  moneyToPesos,
  multiplyMoney,
  percentageOfMoney,
  pesosToMoney,
  ROUNDING_MODE,
  subtractMoney,
  unitPrice,
  ZERO,
} from './money';

export {
  AGING_BUCKETS,
  allocatePayments,
  calculateLineTotal,
  calculateReceivableBalance,
  calculateSaleTotal,
  daysOverdue,
  resolveAgingBucket,
  resolveReceivableStatus,
} from './sales';
export type {
  CalculateSaleTotalInput,
  ResolvedReceivableStatus,
  SaleItemInput,
  SaleTotals,
} from './sales';

export {
  calculateFeedConsumption,
  calculateFeedProgramCost,
  feedCostPerBird,
  feedCostPerEgg,
  summarizeFeedCosts,
} from './feed';
export type { FeedConsumptionInput, FeedConsumptionResult } from './feed';

export {
  calculateEggMargin,
  calculateLayingRate,
  eggsBetween,
  projectEggsOver,
  summarizeProduction,
} from './production';
export type {
  EggMarginInput,
  EggMarginResult,
  LayingRateInput,
  LayingRateResult,
  ProductionDay,
  ProductionSummary,
} from './production';

export {
  calculateCarcassYield,
  calculateCostOfGoodsSold,
  calculateCutRevenue,
  calculateInventoryBalance,
  calculateInventoryValue,
  calculateWasteRate,
  calculateWeightedAverageCost,
  reconcileCutsWithCarcass,
  sumKnownMoney,
  traceMeatLot,
} from './inventory';
export type {
  CutsReconciliation,
  InventoryBalanceResult,
  MeatLotTrace,
  WeightedAverageInput,
  WeightedAverageResult,
} from './inventory';

export {
  calculateCashFlow,
  calculateCustomerBalance,
  calculateGrossProfit,
  calculateMargins,
  calculateNetProfit,
  calculatePeriodSummary,
  calculatePigCycleResult,
  calculateReinvestmentImpact,
} from './cycles';
export type {
  CashFlowInput,
  CashFlowResult,
  CustomerBalanceRow,
  CustomerBalanceTotal,
  MarginResult,
  PeriodSummary,
  PigCycleResult,
  PigCycleResultInput,
  ReinvestmentInput,
  ReinvestmentResult,
} from './cycles';
