import { describe, expect, it } from 'vitest';
import { pesosToMoney } from '../src/money';
import {
  calculateCashFlow,
  calculateCustomerBalance,
  calculateGrossProfit,
  calculateMargins,
  calculateNetProfit,
  calculatePeriodSummary,
  calculatePigCycleResult,
  calculateReinvestmentImpact,
} from '../src/cycles';

const P = pesosToMoney;

describe('resultado: utilidad', () => {
  it('separa utilidad bruta de utilidad neta', () => {
    const input = { revenues: P(90_000), costs: P(30_000), expenses: P(10_000) };
    expect(calculateGrossProfit(input)).toBe(P(60_000));
    expect(calculateNetProfit(input)).toBe(P(50_000));
  });

  it('permite utilidad negativa sin romper', () => {
    const input = { revenues: P(90_000), costs: P(120_000), expenses: P(15_000) };
    expect(calculateNetProfit(input)).toBe(P(-45_000));
  });

  it('calcula márgenes y ratios', () => {
    const result = calculateMargins({
      revenues: P(100_000),
      costs: P(60_000),
      expenses: P(0),
    });
    expect(result.grossProfit).toBe(P(40_000));
    expect(result.marginPercent).toBe(40);
    expect(result.costRatio).toBe(60);
  });

  it('no divide por cero cuando no hubo ingresos', () => {
    const result = calculateMargins({ revenues: P(0), costs: P(50_000), expenses: P(0) });
    expect(result.marginPercent).toBeNull();
    expect(result.costRatio).toBeNull();
  });
});

describe('resultado: flujo de caja', () => {
  it('distingue entrada de salida real de caja', () => {
    const result = calculateCashFlow({
      inboundPayments: P(500_000),
      outboundPayments: P(200_000),
      investmentPayments: P(7_300_000),
      reinvestmentPayments: P(500_000),
    });
    expect(result.totalInflow).toBe(P(500_000));
    expect(result.totalOutflow).toBe(P(8_000_000));
    expect(result.netCashFlow).toBe(P(-7_500_000));
    expect(result.byCategory.investment).toBe(P(7_300_000));
    expect(result.byCategory.reinvestment).toBe(P(500_000));
  });

  it('una venta a crédito NO es entrada de caja hasta que se paga', () => {
    // Se vendió por 90.000 pero solo entraron 40.000:
    const result = calculateCashFlow({
      inboundPayments: P(40_000),
      outboundPayments: P(0),
      investmentPayments: P(0),
      reinvestmentPayments: P(0),
    });
    expect(result.totalInflow).toBe(P(40_000));
    expect(result.netCashFlow).toBe(P(40_000));
  });
});

describe('resultado: reinversión', () => {
  it('la reinversión NO desaparece: utilidad → reinvertido → disponible', () => {
    const result = calculateReinvestmentImpact({
      netProfit: P(90_000),
      reinvestedFromProfitCash: P(50_000),
      reinvestedNonCash: P(0),
      currentCash: P(300_000),
    });
    expect(result.totalReinvested).toBe(P(50_000));
    expect(result.retainedResult).toBe(P(40_000));
    expect(result.availableCashAfterReinvestment).toBe(P(250_000));
  });

  it('la reinversión en insumos NO reduce la caja disponible', () => {
    const result = calculateReinvestmentImpact({
      netProfit: P(90_000),
      reinvestedFromProfitCash: P(0),
      reinvestedNonCash: P(50_000),
      currentCash: P(300_000),
    });
    expect(result.availableCashAfterReinvestment).toBe(P(300_000));
    expect(result.retainedResult).toBe(P(40_000));
  });

  it('permite reinvertir más que la utilidad (deuda o capital externo)', () => {
    const result = calculateReinvestmentImpact({
      netProfit: P(90_000),
      reinvestedFromProfitCash: P(120_000),
      reinvestedNonCash: P(0),
      currentCash: P(300_000),
    });
    expect(result.retainedResult).toBe(P(-30_000));
    expect(result.availableCashAfterReinvestment).toBe(P(180_000));
  });
});

describe('resultado: ciclo de cerdos', () => {
  it('cierra el ciclo con costos, utilidad y caja', () => {
    const result = calculatePigCycleResult(
      {
        revenue: P(2_800_000),
        directCosts: P(2_635_200), // alimento de 6 cerdos
        operatingExpenses: P(120_000), // sacrificio y transporte
        capitalInvestment: P(1_500_000), // compra de los cerdos: NO es gasto del ciclo
        reinvestedCash: P(200_000),
        currentCash: P(1_000_000),
      },
      6,
    );
    expect(result.totalCosts).toBe(P(2_755_200));
    expect(result.grossProfit).toBe(P(44_800));
    expect(result.costPerPig).toBe(P(459_200));
    expect(result.availableCashAfterReinvestment).toBe(P(800_000));
  });

  it('no calcula costo por cerdo si no se conoce la cantidad', () => {
    const result = calculatePigCycleResult(
      {
        revenue: P(100_000),
        directCosts: P(50_000),
        operatingExpenses: P(0),
        capitalInvestment: P(0),
        reinvestedCash: P(0),
        currentCash: P(0),
      },
      null,
    );
    expect(result.costPerPig).toBeNull();
  });
});

describe('resultado: resumen del periodo', () => {
  it('resume el mes con el estado de cartera del cliente', () => {
    const summary = calculatePeriodSummary({
      revenue: P(500_000),
      costs: P(300_000),
      receivedCash: P(200_000),
      receivableBalance: P(300_000),
    });
    expect(summary.netProfit).toBe(P(200_000));
    expect(summary.receivableStatusLabel).toBe('PARCIAL');
  });

  it('marca PENDIENTE si no se ha recibido nada', () => {
    const summary = calculatePeriodSummary({
      revenue: P(500_000),
      costs: P(300_000),
      receivedCash: P(0),
      receivableBalance: P(500_000),
    });
    expect(summary.receivableStatusLabel).toBe('PENDIENTE');
  });

  it('marca PAGADA si no hay saldo pendiente', () => {
    const summary = calculatePeriodSummary({
      revenue: P(500_000),
      costs: P(300_000),
      receivedCash: P(500_000),
      receivableBalance: P(0),
    });
    expect(summary.receivableStatusLabel).toBe('PAGADA');
  });
});

describe('resultado: saldo de cliente por unidad de negocio', () => {
  it('NUNCA mezcla la deuda de ponedoras con la de cerdos', () => {
    // Juan: 90.000 de huevos (ponedoras) + 150.000 de carne (cerdos)
    const result = calculateCustomerBalance([
      { businessUnitId: 'PONEDORAS', balance: P(90_000) },
      { businessUnitId: 'CERDOS', balance: P(150_000) },
    ]);
    expect(result.total).toBe(P(240_000));
    expect(result.isSplit).toBe(true);
    expect(result.byBusinessUnit).toEqual([
      { businessUnitId: 'PONEDORAS', balance: P(90_000) },
      { businessUnitId: 'CERDOS', balance: P(150_000) },
    ]);
  });

  it('omite unidades sin saldo', () => {
    const result = calculateCustomerBalance([
      { businessUnitId: 'PONEDORAS', balance: P(90_000) },
      { businessUnitId: 'CERDOS', balance: P(0) },
    ]);
    expect(result.byBusinessUnit).toHaveLength(1);
    expect(result.isSplit).toBe(false);
  });

  it('cliente sin deuda devuelve cero', () => {
    expect(calculateCustomerBalance([]).total).toBe(P(0));
  });
});
