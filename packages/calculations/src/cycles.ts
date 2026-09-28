/**
 * Resultado financiero: utilidad, flujo de caja y reinversión.
 *
 * Principio §18 y §33:
 *  - Gasto operativo, inversión y reinversión son COSAS DISTINTAS.
 *  - La reinversión NO es gasto: mueve patrimonio. Por eso se modela con
 *    `funding` (utilidad retenida vs. capital externo) y con `cashAmount`
 *    (cuánta caja salió de verdad), para no mentir sobre la caja disponible.
 *  - La venta no es dinero recibido: el flujo de caja sale de los pagos.
 */
import type { Money } from '@agroemprende/types';
import { addMoney, subtractMoney, toMoney, ZERO } from './money';

export interface ProfitAndLossInput {
  /** Ingresos devengados (ventas), no cobrados. */
  readonly revenues: Money;
  /** Costos directos: alimento, salud, agua, merma. */
  readonly costs: Money;
  /** Gastos operativos: transporte, energía, mano de obra, administración. */
  readonly expenses: Money;
}

/** Utilidad: resultado devengado del periodo. */
export const calculateGrossProfit = (input: ProfitAndLossInput): Money =>
  subtractMoney(input.revenues, input.costs);

export const calculateNetProfit = (input: ProfitAndLossInput): Money =>
  subtractMoney(calculateGrossProfit(input), input.expenses);

export interface MarginResult {
  readonly revenue: Money;
  readonly cost: Money;
  readonly grossProfit: Money;
  /** Margen sobre ingresos. NULL si no hubo ingresos (evita dividir por cero). */
  readonly marginPercent: number | null;
  readonly costRatio: number | null;
}

export const calculateMargins = (input: ProfitAndLossInput): MarginResult => {
  const grossProfit = calculateGrossProfit(input);
  const marginPercent =
    input.revenues > 0 ? Math.round((grossProfit / input.revenues) * 10_000) / 100 : null;
  const costRatio =
    input.revenues > 0 ? Math.round((input.costs / input.revenues) * 10_000) / 100 : null;
  return { revenue: input.revenues, cost: input.costs, grossProfit, marginPercent, costRatio };
};

export interface CashFlowInput {
  /** Pagos recibidos de clientes (entradas reales de caja). */
  readonly inboundPayments: Money;
  /** Pagos a proveedores y gastos pagados. */
  readonly outboundPayments: Money;
  /** Inversiones pagadas en efectivo. */
  readonly investmentPayments: Money;
  /** Reinversiones pagadas en efectivo. */
  readonly reinvestmentPayments: Money;
}

export interface CashFlowResult {
  readonly totalInflow: Money;
  readonly totalOutflow: Money;
  readonly netCashFlow: Money;
  /** Desglose para que el usuario vea de dónde salió el dinero. */
  readonly byCategory: {
    readonly operating: Money;
    readonly investment: Money;
    readonly reinvestment: Money;
  };
}

export const calculateCashFlow = (input: CashFlowInput): CashFlowResult => {
  const totalInflow = input.inboundPayments;
  const totalOutflow = addMoney(
    input.outboundPayments,
    input.investmentPayments,
    input.reinvestmentPayments,
  );
  return {
    totalInflow,
    totalOutflow,
    netCashFlow: subtractMoney(totalInflow, totalOutflow),
    byCategory: {
      operating: input.outboundPayments,
      investment: input.investmentPayments,
      reinvestment: input.reinvestmentPayments,
    },
  };
};

export interface ReinvestmentInput {
  readonly netProfit: Money;
  /** Reinversiones con cargo a utilidad retenida, solo la parte en efectivo. */
  readonly reinvestedFromProfitCash: Money;
  /** Reinversiones en activos o insumos que NO salieron de la caja. */
  readonly reinvestedNonCash: Money;
  readonly currentCash: Money;
}

export interface ReinvestmentResult {
  readonly netProfit: Money;
  readonly totalReinvested: Money;
  /** Caja que queda en el bolsillo después de reinvertir. */
  readonly availableCashAfterReinvestment: Money;
  /** Utilidad que NO se reinvirtió y queda como resultado del periodo. */
  readonly retainedResult: Money;
}

/**
 * Utilidad → reinversión → caja disponible.
 *
 * Ejemplo del prompt (§18):
 *   utilidad 90.000 − reinversión 50.000 = 40.000 de resultado
 *   caja disponible = caja actual − 50.000 (solo la parte en efectivo)
 */
export const calculateReinvestmentImpact = (input: ReinvestmentInput): ReinvestmentResult => {
  const totalReinvested = addMoney(input.reinvestedFromProfitCash, input.reinvestedNonCash);
  return {
    netProfit: input.netProfit,
    totalReinvested,
    availableCashAfterReinvestment: subtractMoney(
      input.currentCash,
      input.reinvestedFromProfitCash,
    ),
    retainedResult: subtractMoney(input.netProfit, totalReinvested),
  };
};

export interface PigCycleResultInput {
  /** Ingresos atribuibles al ciclo (ventas de carne del ciclo). */
  readonly revenue: Money;
  /** Costos directos: alimento, medicamentos, agua. */
  readonly directCosts: Money;
  /** Gastos operativos atribuibles: sacrificio, transporte, mano de obra. */
  readonly operatingExpenses: Money;
  /** Inversión de capital del ciclo (animales, instalaciones). NO es gasto del ciclo. */
  readonly capitalInvestment: Money;
  /** Reinversión en efectivo con cargo a utilidad dentro del ciclo. */
  readonly reinvestedCash: Money;
  readonly currentCash: Money;
}

export interface PigCycleResult {
  readonly totalCosts: Money;
  readonly grossProfit: Money;
  readonly netProfit: Money;
  readonly cashGenerated: Money;
  readonly availableCashAfterReinvestment: Money;
  /** Costo por cerdo del ciclo, si se conoce la cantidad. */
  readonly costPerPig: Money | null;
}

export const calculatePigCycleResult = (
  input: PigCycleResultInput,
  pigsCount: number | null,
): PigCycleResult => {
  const totalCosts = addMoney(input.directCosts, input.operatingExpenses);
  const grossProfit = subtractMoney(input.revenue, totalCosts);
  const cashGenerated = subtractMoney(input.revenue, input.reinvestedCash);
  return {
    totalCosts,
    grossProfit,
    netProfit: grossProfit,
    cashGenerated,
    availableCashAfterReinvestment: subtractMoney(input.currentCash, input.reinvestedCash),
    costPerPig:
      pigsCount !== null && pigsCount > 0 ? toMoney(Math.round(totalCosts / pigsCount)) : null,
  };
};

/** Acumulado del mes: ingresos, gastos y utilidad del período. */
export interface PeriodSummary {
  readonly revenue: Money;
  readonly costs: Money;
  readonly netProfit: Money;
  readonly receivedCash: Money;
  readonly receivableBalance: Money;
  readonly receivableStatusLabel: 'PAGADA' | 'PARCIAL' | 'PENDIENTE' | 'VENCIDA';
}

export const calculatePeriodSummary = (
  input: Omit<PeriodSummary, 'netProfit' | 'receivableStatusLabel'>,
): PeriodSummary => {
  const netProfit = subtractMoney(input.revenue, input.costs);
  const receivableStatusLabel =
    input.receivableBalance <= 0 ? 'PAGADA' : input.receivedCash <= 0 ? 'PENDIENTE' : 'PARCIAL';
  return { ...input, netProfit, receivableStatusLabel };
};

/** Saldo consolidado de un cliente, con desglose por unidad de negocio. */
export interface CustomerBalanceRow {
  readonly businessUnitId: string;
  readonly balance: Money;
}

export interface CustomerBalanceTotal {
  readonly total: Money;
  readonly byBusinessUnit: readonly CustomerBalanceRow[];
  /** true si el cliente tiene deuda en más de una unidad de negocio. */
  readonly isSplit: boolean;
}

export const calculateCustomerBalance = (
  rows: readonly CustomerBalanceRow[],
): CustomerBalanceTotal => {
  const nonZero = rows.filter((row) => row.balance !== ZERO);
  let total = ZERO;
  for (const row of nonZero) total = addMoney(total, row.balance);
  return { total, byBusinessUnit: nonZero, isSplit: nonZero.length > 1 };
};
