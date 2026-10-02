/**
 * Esquemas de clientes.
 *
 * Principio §16: el cliente es una entidad GLOBAL de la organización.
 * Sus compras pertenecen a una unidad de negocio concreta, pero el cliente es
 * uno solo. Nunca se duplica por negocio.
 */
import { CREDIT_DAYS_MAX, CREDIT_DAYS_MIN } from '@agroemprende/types';
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

/**
 * Texto opcional que además se puede vaciar.
 *
 * Son tres estados distintos y confundirlos rompe el guardado:
 * - ausente o `undefined`: el formulario no lo tocó, no se escribe nada;
 * - `null`: vaciar el dato a propósito, se escribe `NULL`;
 * - `''`: un campo de formulario vacío, se normaliza a `undefined` para que no
 *   cuente como un cambio.
 *
 * Sin `null` no hay forma de quitarle el teléfono a un cliente que ya lo tenía:
 * mandar `''` no escribiría nada y el número se quedaría para siempre.
 */
const clearableText = <T extends z.ZodType<string>>(schema: T) =>
  schema
    .nullable()
    .optional()
    .or(z.literal('').transform(() => undefined));

/**
 * Cliente de la organización: refleja `core.customers` campo por campo.
 *
 * No hay `type`, `documentType` ni `creditLimit` a propósito. Los dos primeros no
 * existen en la base y son catálogos inventados: cada granja llama distinto a sus
 * clientes y no hay fuente para ese enum. El tercero es peor que inventado, es
 * contradictorio: la base maneja un PLAZO (`credit_days`), no un tope de cartera
 * en pesos. Un formulario que ofrezca un límite en pesos construye un acuerdo
 * comercial que nadie tomó.
 *
 * Las expresiones regulares y los rangos repiten los CHECK de la tabla para que
 * el error llegue antes de gastar la ida al servidor.
 */
/**
 * Los esquemas primitivos se re-exportan para que quien valida no tenga que
 * reconstruirlos.
 *
 * `isoDateSchema` es el caso que importa: las lecturas de cartera reciben la fecha
 * de NEGOCIO que decide si una obligacion esta vencida (ADR-0012), y ese parametro
 * tiene que validarse con la MISMA regla que valida la fecha de una venta. Un
 * repositorio que copiara el `YYYY-MM-DD` tendria dos reglas de fecha, y el dia que
 * una cambiara la otra seguiria aceptando el formato viejo sin avisar.
 */
export {
  businessUnitCodeSchema,
  emailSchema,
  isoDateSchema,
  isoDateTimeSchema,
  notesSchema,
  pesoAmountSchema,
  phoneSchema,
  positiveQuantitySchema,
  quantitySchema,
  uuidSchema,
} from './common';
export const customerSchema = z.object({
  name: z.string().trim().min(2, 'El nombre es obligatorio').max(160),
  /** Código interno de la granja, opcional y único por organización. */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      /^[A-Z0-9_-]{2,32}$/u,
      'El código son de 2 a 32 caracteres: letras, números, guion o guion bajo',
    )
    .nullable()
    .optional(),
  /** NIT/NUI: solo dígitos, de 6 a 15. */
  taxId: z
    .string()
    .trim()
    .regex(/^[0-9]{6,15}$/u, 'El NIT son de 6 a 15 dígitos, sin guiones ni letras')
    .nullable()
    .optional(),
  email: clearableText(emailSchema),
  phone: clearableText(phoneSchema),
  address: z.string().trim().max(240).nullable().optional(),
  /**
   * Días de crédito acordados. `null` = no hay plazo acordado, que es distinto de
   * `0` = se paga hoy. No se rellena con un valor por defecto: 30 días es una
   * decisión comercial y ponerla cambia la cartera de todos los clientes.
   */
  creditDays: z.coerce
    .number()
    .int()
    .min(CREDIT_DAYS_MIN)
    .max(CREDIT_DAYS_MAX)
    .nullable()
    .default(null),
  notes: notesSchema.nullable(),
  isActive: z.boolean().default(true),
});

export type CustomerInput = z.infer<typeof customerSchema>;

/**
 * Contacto del cliente: refleja `core.customer_contacts`. `role` es texto libre
 * porque cada granja nombra distinto a esas personas.
 */
export const customerContactSchema = z.object({
  customerId: uuidSchema,
  name: z.string().trim().min(2, 'El nombre es obligatorio').max(160),
  role: z.string().trim().min(2).max(80).nullable().optional(),
  email: clearableText(emailSchema),
  phone: clearableText(phoneSchema),
  isPrimary: z.boolean().default(false),
  notes: notesSchema.nullable(),
});

export type CustomerContactInput = z.infer<typeof customerContactSchema>;

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
 *
 * Solo se replica la mitad que el cliente puede saber. En una venta a crédito el
 * vencimiento es OPCIONAL: si el cliente tiene términos acordados, el servidor lo
 * deriva como `saleDate + creditDays` y rechaza el que le manden si no coincide
 * (ADR-0003). Exigirlo aquí obligaría al formulario a repetir el cálculo del
 * servidor y a rechazar requests que la base de datos acepta sin problema.
 */
export const createSaleSchemaRefined = createSaleSchema.superRefine((data, ctx) => {
  if (data.paymentMethod !== 'credit' && data.dueDate) {
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
  /**
   * Vencimiento de la cuenta por pagar. Aquí sí es obligatorio en crédito: el
   * proveedor no tiene términos acordados que el servidor pueda derivar, así que
   * quien dice cuándo vence es el llamador (`create_expense` rechaza el crédito
   * sin fecha con 22023).
   */
  dueDate: isoDateSchema.optional(),
  idempotencyKey: z.uuid(),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

/**
 * Réplica del contrato de `create_expense`: el crédito siempre vence y el resto
 * nunca. A diferencia de la venta, aquí no hay `credit_days` que consultation, de
 * modo que las dos mitades del invariante sí son comprobables en el cliente.
 */
export const createExpenseSchemaRefined = createExpenseSchema.superRefine((data, ctx) => {
  const isCredit = data.paymentMethod === 'credit';

  if (isCredit && !data.dueDate) {
    ctx.addIssue({
      code: 'custom',
      path: ['dueDate'],
      message: 'Un gasto a crédito requiere fecha de vencimiento',
    });
  }

  if (!isCredit && data.dueDate) {
    ctx.addIssue({
      code: 'custom',
      path: ['dueDate'],
      message: 'Un gasto de contado no lleva fecha de vencimiento: no hay nada que pagar',
    });
  }
});

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
