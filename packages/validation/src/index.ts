/**
 * Esquemas de clientes.
 *
 * Principio §16: el cliente es una entidad GLOBAL de la organización.
 * Sus compras pertenecen a una unidad de negocio concreta, pero el cliente es
 * uno solo. Nunca se duplica por negocio.
 */
import { z } from 'zod';
import {
  businessUnitCodeSchema,
  emailSchema,
  isoDateSchema,
  notesSchema,
  pesoAmountSchema,
  phoneSchema,
  quantitySchema,
  uuidSchema,
} from './common';

export const CUSTOMER_TYPES = ['person', 'company', 'restaurant', 'market', 'other'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const customerSchema = z.object({
  name: z.string().trim().min(2, 'El nombre es obligatorio').max(160),
  type: z.enum(CUSTOMER_TYPES).default('person'),
  documentType: z.enum(['cc', 'ce', 'nit', 'rut', 'other']).optional(),
  documentNumber: z.string().trim().max(32).optional(),
  email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
  phone: phoneSchema.optional().or(z.literal('').transform(() => undefined)),
  address: z.string().trim().max(240).optional(),
  /** Límite de crédito en pesos. NULL = sin límite. */
  creditLimit: pesoAmountSchema.nullable().default(null),
  notes: notesSchema,
  isActive: z.boolean().default(true),
});

export type CustomerInput = z.infer<typeof customerSchema>;

/** Validación de una venta de productos (huevos, carne, otros). */
export const saleItemSchema = z.object({
  productId: uuidSchema,
  description: z.string().trim().max(240).optional(),
  quantity: quantitySchema.refine((value) => value > 0, {
    message: 'La cantidad debe ser mayor que cero',
  }),
  unitOfMeasure: z.enum([
    'unit',
    'tray',
    'dozen',
    'g',
    'kg',
    'ton',
    'bag',
    'liter',
    'm3',
    'lb',
    'day',
  ]),
  /** Precio unitario en pesos, editable en cada venta. */
  unitPrice: pesoAmountSchema,
  discount: pesoAmountSchema.default(0),
  businessUnitId: uuidSchema,
});

/**
 * Cómo se cobra la venta.
 *
 * `credit` no es una forma de pago: es la ausencia de cobro inmediato. Es el
 * mismo vocabulario que usa `finance.expenses`, y el servidor lo lee igual:
 * una venta `credit` genera cartera y vence, cualquier otra se liquida en el
 * acto contra caja o bancos y no genera nada que cobrar.
 */
export const salePaymentMethodSchema = z.enum([
  'cash',
  'bank_transfer',
  'card',
  'digital_wallet',
  'credit',
]);

export const createSaleSchema = z.object({
  /** Cliente global; la unidad de negocio va en las líneas. */
  customerId: uuidSchema,
  businessUnitId: uuidSchema,
  saleDate: isoDateSchema,
  /** `credit` deja la venta a cobrar; los demás la liquidan en el acto. */
  paymentMethod: salePaymentMethodSchema,
  items: z.array(saleItemSchema).min(1, 'La venta debe tener al menos una línea'),
  discount: pesoAmountSchema.default(0),
  /**
   * Vencimiento. Solo lo calcula el servidor a partir de los términos del
   * cliente; el cliente lo envía como contraste y el servidor lo rechaza si no
   * coincide (ADR-0003: la fuente de la fecha es el servidor).
   */
  dueDate: isoDateSchema.optional(),
  notes: notesSchema,
  /** Clave de idempotencia generada por el cliente. */
  idempotencyKey: z.uuid(),
});

export type CreateSaleInput = z.infer<typeof createSaleSchema>;

/**
 * Coherencia entre condición de cobro y vencimiento.
 *
 * El servidor (CHECK `sales_credit_due_date_agreement`) garantiza que la venta
 * sea a crédito si y solo si tiene vencimiento. Esta regla replica el mismo
 * invariante en el cliente para que el error llegue al usuario antes de gastar
 * una ida al servidor, y no después.
 */
export const createSaleSchemaRefined = createSaleSchema.superRefine((data, ctx) => {
  const isCredit = data.paymentMethod === 'credit';

  if (isCredit && !data.dueDate) {
    ctx.addIssue({
      code: 'custom',
      path: ['dueDate'],
      message: 'Una venta a crédito requiere fecha de vencimiento',
    });
  }

  if (!isCredit && data.dueDate) {
    ctx.addIssue({
      code: 'custom',
      path: ['dueDate'],
      message: 'Una venta de contado no lleva fecha de vencimiento: no hay nada que cobrar',
    });
  }
});

/** El metodo con el que entra el efectivo. Un pago nunca es 'credit'. */
export const settlementMethodSchema = z.enum(['cash', 'bank_transfer', 'card', 'digital_wallet']);

/** Pago (abono) a una cuenta por cobrar. */
export const registerPaymentSchema = z.object({
  customerId: uuidSchema,
  businessUnitId: uuidSchema,
  paymentDate: isoDateSchema,
  amount: pesoAmountSchema.refine((value) => value > 0, {
    message: 'El valor del pago debe ser mayor que cero',
  }),
  method: settlementMethodSchema,
  accountId: uuidSchema,
  /** Cuentas a las que se aplica el pago, en orden de aplicación. */
  receivableIds: z.array(uuidSchema).default([]),
  reference: z.string().trim().max(80).optional(),
  notes: notesSchema,
  idempotencyKey: z.uuid(),
});

export type RegisterPaymentInput = z.infer<typeof registerPaymentSchema>;

/** Gasto operativo, inversión o reinversión: la categoría define el treatment. */
export const expenseCategorySchema = z.enum([
  'feed',
  'water',
  'health',
  'transport',
  'energy',
  'labor',
  'equipment',
  'infrastructure',
  'contribution',
  'other',
]);

export const createExpenseSchema = z.object({
  businessUnitId: uuidSchema,
  expenseDate: isoDateSchema,
  category: expenseCategorySchema,
  amount: pesoAmountSchema.refine((value) => value > 0, {
    message: 'El valor debe ser mayor que cero',
  }),
  description: z.string().trim().min(3, 'Describe el gasto').max(240),
  supplierId: uuidSchema.optional(),
  /** Distribución analítica del costo a un lote o ciclo concreto. */
  costObjectType: z.enum(['flock', 'pig', 'pig_cycle', 'none']).default('none'),
  costObjectId: uuidSchema.optional(),
  /** Igual que en ventas: 'credit' genera cuentas por pagar, el resto no. */
  paymentMethod: z.enum(['cash', 'bank_transfer', 'card', 'digital_wallet', 'credit']).optional(),
  idempotencyKey: z.uuid(),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

/** Configuración de una unidad de negocio al crearla. */
export const createBusinessUnitSchema = z.object({
  code: businessUnitCodeSchema,
  name: z.string().trim().min(2).max(80),
  type: z.enum(['poultry_layers', 'broilers', 'swine', 'cattle', 'fish', 'crops', 'other']),
  farmId: uuidSchema.optional(),
});

/** Lote de ponedoras. */
export const createFlockSchema = z.object({
  businessUnitId: uuidSchema,
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(2).max(80),
  breed: z.string().trim().max(80).optional(),
  supplierId: uuidSchema.optional(),
  initialQuantity: z.number().int().positive(),
  arrivalDate: isoDateSchema,
  initialAgeWeeks: z.number().int().min(0).max(120),
  purchasePriceTotal: pesoAmountSchema.default(0),
  layStartDate: isoDateSchema.optional(),
});

/**
 * Producción diaria de huevos.
 * La fecha es de negocio (YYYY-MM-DD), nunca un instante: así un registro hecho
 * a las 11:59 p. m. no se desplaza al día siguiente.
 */
export const recordDailyProductionSchema = z.object({
  flockId: uuidSchema,
  productionDate: isoDateSchema,
  eggsGood: z.number().int().min(0),
  eggsBroken: z.number().int().min(0).default(0),
  eggsSmall: z.number().int().min(0).default(0),
  birds: z.number().int().positive().optional(),
  notes: notesSchema,
  idempotencyKey: z.uuid(),
});

export type RecordDailyProductionInput = z.infer<typeof recordDailyProductionSchema>;

/** Cerdo: identidad individual obligatoria. */
export const createPigSchema = z.object({
  businessUnitId: uuidSchema,
  cycleId: uuidSchema.optional(),
  code: z.string().trim().min(2).max(32),
  name: z.string().trim().max(60).optional(),
  entryDate: isoDateSchema,
  breed: z.string().trim().max(80).optional(),
  supplierId: uuidSchema.optional(),
  initialWeightKg: z.number().positive().optional(),
  purchasePrice: pesoAmountSchema.optional(),
  targetWeightKg: z.number().positive().optional(),
});

/** Peso de un cerdo. `method` distingue báscula real de estimación. */
export const recordPigWeightSchema = z.object({
  pigId: uuidSchema,
  recordDate: isoDateSchema,
  weightKg: z.number().positive(),
  method: z.enum(['scale', 'estimate', 'formula']),
  notes: notesSchema,
});

/** Consumo de alimento: puede ser real o estimado, y el precio puede faltar. */
export const recordFeedConsumptionSchema = z.object({
  businessUnitId: uuidSchema,
  flockId: uuidSchema.optional(),
  pigId: uuidSchema.optional(),
  cycleId: uuidSchema.optional(),
  feedProductId: uuidSchema,
  consumptionDate: isoDateSchema,
  birdsCount: z.number().int().positive().optional(),
  gramsPerBird: z.number().positive().nullable().default(null),
  bags: z.number().positive().optional(),
  bagWeightKg: z.number().positive().optional(),
  costPerBag: pesoAmountSchema.nullable().default(null),
  isEstimated: z.boolean().default(false),
  notes: notesSchema,
});

/**
 * Consumo de agua: el costo por litro es OPCIONAL a propósito.
 * §14: no inventar el costo real del agua. Si el usuario no lo conoce, se
 * registra el consumo y el costo queda NULL, marcado como pendiente.
 */
export const recordWaterConsumptionSchema = z.object({
  businessUnitId: uuidSchema,
  flockId: uuidSchema.optional(),
  cycleId: uuidSchema.optional(),
  recordDate: isoDateSchema,
  liters: z.number().positive().optional(),
  unitCostPerLiter: pesoAmountSchema.nullable().default(null),
  tankCapacityLiters: z.number().positive().optional(),
  refillIntervalDays: z.number().int().positive().optional(),
  notes: notesSchema,
});

/**
 * Sacrificio de un cerdo.
 * `carcassWeightKg` es opcional a propósito: sin él NO se calcula rendimiento
 * (§29). `liveWeightKg` tampoco se inventa.
 */
export const recordSlaughterSchema = z.object({
  pigId: uuidSchema,
  cycleId: uuidSchema.optional(),
  slaughterDate: isoDateSchema,
  liveWeightKg: z.number().positive().optional(),
  carcassWeightKg: z.number().positive().optional(),
  costs: z
    .array(
      z.object({
        type: z.enum(['knives', 'ice', 'transport', 'supplies', 'external_labor', 'other']),
        description: z.string().trim().max(160).optional(),
        amount: pesoAmountSchema,
      }),
    )
    .default([]),
  notes: notesSchema,
});

/** Peso real de un corte: sin él no hay rendimiento ni ingreso potencial. */
export const recordPigCutSchema = z.object({
  slaughterId: uuidSchema,
  code: z.enum([
    'pierna',
    'costilla',
    'canon',
    'tocino',
    'papada',
    'hueso_espinazo',
    'pezuna_osobuco',
    'otro',
  ]),
  weightKg: z.number().positive().nullable().default(null),
  isEstimated: z.boolean().default(false),
  notes: notesSchema,
});
