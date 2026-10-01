import { describe, expect, it } from 'vitest';
import {
  businessUnitCodeSchema,
  isoDateSchema,
  pesoAmountSchema,
  phoneSchema,
} from '../src/common';
import {
  createExpenseSchema,
  createExpenseSchemaRefined,
  createSaleSchema,
  createSaleSchemaRefined,
  customerContactSchema,
  customerSchema,
  recordWaterConsumptionSchema,
} from '../src/index';

const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const uuid2 = '9c858901-8a57-4791-81fe-4c455b099bc9';

const validSale = {
  customerId: uuid,
  businessUnitId: uuid2,
  saleDate: '2026-09-27',
  /** Por defecto la venta es de contado: no genera cartera. */
  paymentMethod: 'cash' as const,
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

  it('no inventa un tipo de cliente que la base no tiene', () => {
    // `core.customers` no tiene columna `type`. Aunque el tipo de entrada no
    // compila si se lo pasa, en runtime la clave se descarta: lo que sale de
    // aquí son columnas de la tabla y nada más.
    const result = customerSchema.safeParse({ name: 'Juan Pérez', type: 'person' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('type');
    }
  });

  it('no ofrece un límite de crédito en pesos', () => {
    // La base maneja un plazo (credit_days), no un tope de cartera. Aceptar el
    // límite construiría un acuerdo comercial que nadie tomó.
    const result = customerSchema.safeParse({ name: 'Juan Pérez', creditLimit: 5_000_000 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('creditLimit');
    }
  });

  it('acepta días de crédito acordados', () => {
    const result = customerSchema.safeParse({ name: 'Juan Pérez', creditDays: 30 });
    expect(result.success).toBe(true);
  });

  it('deja los días de crédito en null cuando no hay acuerdo', () => {
    // null = no hay plazo. No se rellena con 30 por defecto: eso cambiaría la
    // cartera de todos los clientes sin que nadie lo decidiera.
    const result = customerSchema.safeParse({ name: 'Juan Pérez' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.creditDays).toBeNull();
    }
  });

  it('distingue "se paga hoy" (0) de "no hay acuerdo" (null)', () => {
    const result = customerSchema.safeParse({ name: 'Juan Pérez', creditDays: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.creditDays).toBe(0);
    }
  });

  it('rechaza un plazo que la tabla no permite', () => {
    expect(customerSchema.safeParse({ name: 'Juan', creditDays: 400 }).success).toBe(false);
    expect(customerSchema.safeParse({ name: 'Juan', creditDays: -1 }).success).toBe(false);
    expect(customerSchema.safeParse({ name: 'Juan', creditDays: 12.5 }).success).toBe(false);
  });

  it('normaliza el código del cliente a mayúsculas', () => {
    const result = customerSchema.safeParse({ name: 'Juan', code: 'cli-01' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe('CLI-01');
    }
  });

  it('rechaza un código con caracteres que la tabla no admite', () => {
    expect(customerSchema.safeParse({ name: 'Juan', code: 'A' }).success).toBe(false);
    expect(customerSchema.safeParse({ name: 'Juan', code: 'CLI 01' }).success).toBe(false);
    expect(customerSchema.safeParse({ name: 'Juan', code: 'CLIÑ01' }).success).toBe(false);
  });

  it('exige un NIT de solo dígitos', () => {
    expect(customerSchema.safeParse({ name: 'Juan', taxId: '900123456' }).success).toBe(true);
    expect(customerSchema.safeParse({ name: 'Juan', taxId: '900-123-456' }).success).toBe(false);
    expect(customerSchema.safeParse({ name: 'Juan', taxId: '12345' }).success).toBe(false);
  });

  it('acepta un contacto con su rol', () => {
    const result = customerContactSchema.safeParse({
      customerId: uuid,
      name: 'María López',
      role: 'Dueño de compra',
      phone: '3101234567',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isPrimary).toBe(false);
    }
  });

  it('exige el cliente al que pertenece el contacto', () => {
    expect(customerContactSchema.safeParse({ name: 'María López' }).success).toBe(false);
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

  it('acepta venta a crédito sin vencimiento: el servidor lo deriva de los términos', () => {
    // Si el cliente tiene crédito acordado, `create_sale` calcula
    // saleDate + credit_days. Exigirlo aquí rechazaría una venta que la base de
    // datos acepta, y obligaría al formulario a repetir ese cálculo.
    const result = createSaleSchemaRefined.safeParse({ ...validSale, paymentMethod: 'credit' });
    expect(result.success).toBe(true);
  });

  it('acepta venta a crédito con vencimiento', () => {
    const result = createSaleSchemaRefined.safeParse({
      ...validSale,
      paymentMethod: 'credit',
      dueDate: '2026-10-12',
    });
    expect(result.success).toBe(true);
  });

  it('acepta venta de contado sin vencimiento', () => {
    const result = createSaleSchemaRefined.safeParse({ ...validSale, paymentMethod: 'cash' });
    expect(result.success).toBe(true);
  });

  it('rechaza una venta de contado que llega con vencimiento', () => {
    // El servidor tiene el CHECK `sales_credit_due_date_agreement`; aqui se
    // replica para que el error llegue antes de gastar la ida.
    const result = createSaleSchemaRefined.safeParse({
      ...validSale,
      paymentMethod: 'cash',
      dueDate: '2026-10-12',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'dueDate')).toBe(true);
    }
  });

  it('rechaza un método de pago que no existe en la base', () => {
    expect(createSaleSchema.safeParse({ ...validSale, paymentMethod: 'neqi' }).success).toBe(false);
  });
});

describe('validación: gastos', () => {
  const validExpense = {
    businessUnitId: uuid2,
    expenseDate: '2026-09-27',
    category: 'feed' as const,
    amount: 250_000,
    description: 'Compra de concentrado',
    idempotencyKey: uuid,
  };

  it('acepta un gasto de contado sin vencimiento', () => {
    const result = createExpenseSchemaRefined.safeParse({ ...validExpense, paymentMethod: 'cash' });
    expect(result.success).toBe(true);
  });

  it('exige vencimiento en un gasto a crédito', () => {
    // El proveedor no tiene términos acordados: no hay nada que derivar, así que
    // el vencimiento tiene que venir en la petición.
    const result = createExpenseSchemaRefined.safeParse({
      ...validExpense,
      paymentMethod: 'credit',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'dueDate')).toBe(true);
    }
  });

  it('acepta un gasto a crédito con vencimiento', () => {
    const result = createExpenseSchemaRefined.safeParse({
      ...validExpense,
      paymentMethod: 'credit',
      dueDate: '2026-10-12',
    });
    expect(result.success).toBe(true);
  });

  it('rechaza un gasto de contado que llega con vencimiento', () => {
    const result = createExpenseSchemaRefined.safeParse({
      ...validExpense,
      paymentMethod: 'cash',
      dueDate: '2026-10-12',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'dueDate')).toBe(true);
    }
  });

  it('exige un monto mayor que cero', () => {
    expect(createExpenseSchema.safeParse({ ...validExpense, amount: 0 }).success).toBe(false);
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
