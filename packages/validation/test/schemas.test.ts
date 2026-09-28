import { describe, expect, it } from 'vitest';
import {
  businessUnitCodeSchema,
  isoDateSchema,
  pesoAmountSchema,
  phoneSchema,
} from '../src/common';
import {
  createSaleSchema,
  createSaleSchemaRefined,
  customerSchema,
  recordWaterConsumptionSchema,
} from '../src/index';

const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const uuid2 = '9c858901-8a57-4791-81fe-4c455b099bc9';

const validSale = {
  customerId: uuid,
  businessUnitId: uuid2,
  saleDate: '2026-09-27',
  items: [
    {
      productId: uuid,
      quantity: 5,
      unitOfMeasure: 'tray' as const,
      unitPrice: 18_000,
      businessUnitId: uuid2,
    },
  ],
  idempotencyKey: uuid,
};

describe('validación: fechas de negocio', () => {
  it('acepta YYYY-MM-DD', () => {
    expect(isoDateSchema.safeParse('2026-09-27').success).toBe(true);
  });

  it('rechaza formatos alternativos (no usar Date)', () => {
    expect(isoDateSchema.safeParse('27/09/2026').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-09-27T10:00:00Z').success).toBe(false);
  });

  it('rechaza fechas imposibles', () => {
    expect(isoDateSchema.safeParse('2026-13-45').success).toBe(false);
  });
});

describe('validación: importes', () => {
  it('acepta 18.000 COP', () => {
    expect(pesoAmountSchema.safeParse(18_000).success).toBe(true);
  });

  it('acepta hasta 4 decimales para precios unitarios', () => {
    expect(pesoAmountSchema.safeParse(12_000.5).success).toBe(true);
  });

  it('rechaza más de 4 decimales', () => {
    expect(pesoAmountSchema.safeParse(12_000.12345).success).toBe(false);
  });

  it('rechaza negativos y valores absurdos', () => {
    expect(pesoAmountSchema.safeParse(-1).success).toBe(false);
    expect(pesoAmountSchema.safeParse(1e13).success).toBe(false);
  });
});

describe('validación: clientes', () => {
  it('acepta un cliente con teléfono colombiano', () => {
    const result = customerSchema.safeParse({ name: 'Juan Pérez', phone: '3101234567' });
    expect(result.success).toBe(true);
  });

  it('acepta el teléfono con prefijo +57', () => {
    expect(customerSchema.safeParse({ name: 'Juan', phone: '+57 3101234567' }).success).toBe(true);
  });

  it('rechaza un teléfono inválido', () => {
    expect(customerSchema.safeParse({ name: 'Juan', phone: '123' }).success).toBe(false);
  });

  it('exige nombre', () => {
    expect(customerSchema.safeParse({ name: 'J' }).success).toBe(false);
  });
});

describe('validación: ventas', () => {
  it('acepta una venta de 5 cubetas a 18.000', () => {
    const result = createSaleSchema.safeParse(validSale);
    expect(result.success).toBe(true);
  });

  it('exige al menos una línea', () => {
    expect(createSaleSchema.safeParse({ ...validSale, items: [] }).success).toBe(false);
  });

  it('exige cantidad mayor que cero', () => {
    const result = createSaleSchema.safeParse({
      ...validSale,
      items: [{ ...validSale.items[0], quantity: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('exige fecha de vencimiento en ventas a crédito', () => {
    const result = createSaleSchemaRefined.safeParse({ ...validSale, isCredit: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'dueDate')).toBe(true);
    }
  });

  it('acepta venta a crédito con vencimiento', () => {
    const result = createSaleSchemaRefined.safeParse({
      ...validSale,
      isCredit: true,
      dueDate: '2026-10-12',
    });
    expect(result.success).toBe(true);
  });

  it('acepta venta de contado sin vencimiento', () => {
    expect(createSaleSchemaRefined.safeParse({ ...validSale, isCredit: false }).success).toBe(true);
  });
});

describe('validación: agua (no inventar costos)', () => {
  it('permite registrar consumo sin costo por litro', () => {
    const result = recordWaterConsumptionSchema.safeParse({
      businessUnitId: uuid2,
      recordDate: '2026-09-27',
      liters: 250,
      unitCostPerLiter: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unitCostPerLiter).toBeNull();
    }
  });

  it('permite registrar solo el costo si no se midieron litros', () => {
    const result = recordWaterConsumptionSchema.safeParse({
      businessUnitId: uuid2,
      recordDate: '2026-09-27',
      unitCostPerLiter: 900,
    });
    expect(result.success).toBe(true);
  });
});

describe('validación: códigos de negocio', () => {
  it('acepta PONEDORAS y CERDOS', () => {
    expect(businessUnitCodeSchema.safeParse('PONEDORAS').success).toBe(true);
    expect(businessUnitCodeSchema.safeParse('CERDOS').success).toBe(true);
  });

  it('rechaza espacios y minúsculas', () => {
    expect(businessUnitCodeSchema.safeParse('Ponedoras').success).toBe(false);
    expect(businessUnitCodeSchema.safeParse('ponedoras ').success).toBe(false);
  });
});

describe('validación: teléfonos', () => {
  it('acepta móvil y fijo', () => {
    expect(phoneSchema.safeParse('3001234567').success).toBe(true);
    expect(phoneSchema.safeParse('1234567').success).toBe(true);
  });

  it('rechaza basura', () => {
    expect(phoneSchema.safeParse('abc').success).toBe(false);
  });
});
