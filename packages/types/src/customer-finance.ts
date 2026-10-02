/**
 * Cartera, historial de ventas y resumen financiero del cliente.
 *
 * Por que es un archivo aparte de `finance.ts`
 * ---------------------------------------------
 * `finance.ts` describe las TABLAS del modulo: una venta, un pago, un asiento. Lo
 * de este archivo describe las tres lecturas que la aplicacion pide: que debe un
 * cliente, que se le vendio, que se le ha cobrado y como se reparte por unidad.
 *
 * La diferencia importa porque las cifras NO se guardan. Todo lo de aqui se deriva
 * en PostgreSQL al leer (migraciones `20260928172000` y `20260928173000`), y este
 * modulo es la forma que toma esa derivacion al llegar a la interfaz. Si alguien
 * busca "de donde sale outstanding", la respuesta es la vista, no un campo.
 *
 * La regla que atraviesa todo el archivo
 * --------------------------------------
 * Un importe es `Money` (centavos). PostgreSQL devuelve `NUMERIC(18,2)` en PESOS,
 * porque el que formatea es `numeric` y ahi los centavos son ruido. La conversion
 * ocurre UNA vez, en la frontera, con `pesosToMoney` de `@agroemprende/calculations`
 * (ADR-0006). Mezclar las dos unidades es la forma mas rapida de mostrar un saldo
 * cien veces mas pequeno, y el error no se ve: se ve un numero plausible.
 */
import type {
  BusinessUnitId,
  CustomerId,
  IsoDate,
  IsoDateTime,
  PaymentId,
  ReceivableId,
  SaleId,
} from './common';
import type { Money } from './money';
import type {
  PaymentMethod,
  ReceivableStatus,
  SettlementMethod,
  UserFacingPaymentStatus,
} from './finance';

/**
 * Referencia a una unidad de negocio: lo minimo para etiquetar una cifra.
 *
 * No es `BusinessUnit` porque aqui no se necesita el tipo de unidad, su moneda ni
 * su `deletedAt`. Y `id: null` NO significa "sin unidad": significa que la unidad
 * no se pudo leer y la cifra se muestra sin etiqueta. Es una distincion que el
 * sistema hace a proposito y que la interfaz debe poder pintar: una fila de dinero
 * que desaparece por falta de permiso para leer su nombre es peor que un nombre
 * ausente (ADR-0004).
 */
export interface BusinessUnitRef {
  readonly id: BusinessUnitId;
  readonly code: string;
  readonly name: string;
}

/** Fila de la cartera: una obligacion, su saldo y en que estado esta. */
export interface CustomerReceivable {
  readonly id: ReceivableId;
  readonly customerId: CustomerId;
  readonly saleId: SaleId;
  readonly businessUnit: BusinessUnitRef | null;
  readonly invoiceNumber: string;
  readonly saleDate: IsoDate;
  readonly dueDate: IsoDate;
  /** `credit` siempre: una obligacion solo nace de una venta a credito. */
  readonly paymentMethod: PaymentMethod;
  readonly originalAmount: Money;
  readonly paidAmount: Money;
  /** Lo que falta por pagar. `0` cuando esta liquidada. */
  readonly balance: Money;
  /**
   * Instante en que la deuda quedo COMPLETAMENTE liquidada, `null` mientras exista
   * saldo aunque haya abonos parciales.
   *
   * NO es la fecha del ultimo abono (esa esta en `CustomerPayment.paymentDate`) y
   * NO es la fecha de negocio: PostgreSQL lo llena con `now()`. Confundir "cuando
   * se saldo" con "cuando se cobro" rompe una pregunta que el dueño se hace todos
   * los meses.
   */
  readonly paidAt: IsoDateTime | null;
  /**
   * Estado visible, DERIVADO con `resolveReceivableStatus` de
   * `@agroemprende/calculations` a partir de saldo, abonos y vencimiento.
   *
   * Se calcula aqui y no en la pantalla para que Web y Mobile no tengan dos
   * copias de la misma regla: si divergen, el movil muestra "al dia" donde la web
   * muestra "vencida", y el unico dato fiable es el que uno de los dos calcula.
   */
  readonly status: ReceivableStatus;
  /** PAGADA / PARCIAL / PENDIENTE / VENCIDA: lo que se escribe en pantalla. */
  readonly statusLabel: UserFacingPaymentStatus;
  /** Dias de atraso. `0` si no esta vencida. Nunca negativo. */
  readonly daysOverdue: number;
  readonly createdAt: IsoDateTime;
}

/** Venta del historial del cliente, con la marca de anulacion. */
export interface CustomerSale {
  readonly id: SaleId;
  readonly customerId: CustomerId;
  readonly businessUnit: BusinessUnitRef | null;
  readonly invoiceNumber: string;
  readonly saleDate: IsoDate;
  /** `null` en ventas de contado: no hay cartera, y sin vencimiento se pierde la antiguedad. */
  readonly dueDate: IsoDate | null;
  readonly paymentMethod: PaymentMethod;
  readonly subtotal: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly description: string | null;
  /**
   * `true` si la venta fue anulada.
   *
   * Se DERIVA del contra-asiento `reversal` del libro mayor (ADR-0003), no de una
   * columna: no existe. La venta NO desaparece del historial cuando se anula, se
   * marca. Ocultarla seria borrar historia, y la contabilidad es append-only.
   */
  readonly isVoided: boolean;
  readonly createdAt: IsoDateTime;
}

/** Abono aplicado a una obligacion: por que la deuda quedo como quedo. */
export interface CustomerPayment {
  readonly id: PaymentId;
  readonly customerId: CustomerId;
  /**
   * Fecha de NEGOCIO del abono (ADR-0012), no el instante en que se registro.
   * `paidAt` de la cartera es `now()`; este es el dia que el cliente paga.
   */
  readonly paymentDate: IsoDate;
  readonly method: SettlementMethod;
  /** Cuanto entro en total. */
  readonly amount: Money;
  /** Parte del abono que no se aplico a ninguna deuda: saldo a favor. */
  readonly unappliedAmount: Money;
  /** Parte que si se aplico a la obligacion de esta fila. */
  readonly appliedAmount: Money;
  readonly description: string | null;
  readonly receivableId: ReceivableId;
  readonly saleId: SaleId;
  /**
   * Unidad de la VENTA, no la del pago.
   *
   * `register_payment` aplica los abonos por vencimiento a lo largo de toda la
   * organizacion, asi que un pago hecho en una granja puede saldar una deuda de
   * otra. La cartera pertenece a la venta: es lo que la organizacion vendio y por
   * tanto lo que esa unidad tiene por recuperar.
   */
  readonly businessUnit: BusinessUnitRef | null;
  readonly invoiceNumber: string;
  readonly dueDate: IsoDate;
  readonly createdAt: IsoDateTime;
}

/**
 * Una fila del resumen: las cifras de una unidad, o la consolidada de todas.
 *
 * `isConsolidated` NO se deduce de que `businessUnit` sea null: una fila sin unidad
 * y una fila que representa todas las unidades son cosas distintas, y confundirlas
 * es como la app termina mostrando "Granja: todas" con el id de una granja real.
 */
export interface CustomerFinancialSummaryRow {
  /** `null` en la fila consolidada. */
  readonly businessUnit: BusinessUnitRef | null;
  readonly isConsolidated: boolean;

  readonly salesCount: number;
  /** Ventas liquidadas en el acto: ni generan cartera ni se cobran despues. */
  readonly cashSalesCount: number;
  readonly creditSalesCount: number;

  readonly receivableCount: number;
  /** Obligaciones con saldo. Incluye las parciales. */
  readonly openCount: number;
  readonly partialCount: number;
  readonly overdueCount: number;
  readonly paidCount: number;

  /** Facturado total, contado y a credito juntos. */
  readonly totalSold: Money;
  readonly cashSalesTotal: Money;
  /** Total puesto a credito, que es lo que paso a ser cartera. */
  readonly creditBilled: Money;
  /** Cobrado contra ventas a credito. Las ventas de contado NO se cuentan aqui. */
  readonly totalPaid: Money;
  /** Lo que el cliente debe ahora. */
  readonly outstanding: Money;
  /** La parte de `outstanding` que esta vencida a la fecha de negocio. */
  readonly overdueOutstanding: Money;
  /**
   * Vencimiento mas antiguo entre las obligaciones abiertas. `null` cuando no debe
   * nada, y `null` es la respuesta correcta: cero seria una fecha que no existe.
   */
  readonly oldestOpenDueDate: IsoDate | null;
}

/**
 * Los conteos de un resumen NO son categorias disjuntas.
 *
 * Una obligacion con saldo, un abono parcial y el vencimiento pasado aparece en
 * `openCount`, en `partialCount` y en `overdueCount` a la vez. Sumarlos para
 * mostrar "cartera: 12" daria un numero que no existe; por eso los contadores se
 * muestran por separado.
 */
export interface CustomerFinancialSummary {
  readonly rows: readonly CustomerFinancialSummaryRow[];
  /** Fila consolidada, o `null` si la base no la devolvio. */
  readonly consolidated: CustomerFinancialSummaryRow | null;
}

/** Filtros que comparten las lecturas de ventas y abonos. */
export interface CustomerFinanceListOptions {
  /**
   * Fecha de NEGOCIO contra la que se decide que esta vencida (ADR-0012).
   *
   * Es OBLIGATORIA y la pasa la aplicacion. Si la vista usara `current_date`, el
   * "vencidas" dependeria del reloj del servidor; y si `today` fuera opcional, un
   * `undefined` se convierte en `NULL` haria que `due_date < today` no casara con nada y el
   * conteo de vencidas saliera en cero con la misma calma que si el cliente
   * estuviera al dia. Un dato que se puede perder en silencio no puede ser
   * opcional.
   */
  readonly today: IsoDate;
  /** `undefined` = todas las unidades. Filtra el dato, NO autoriza: RLS manda. */
  readonly businessUnitId?: BusinessUnitId | undefined;
  /** Fecha de negocio inicial del rango, inclusive. */
  readonly dateFrom?: IsoDate | undefined;
  /** Fecha de negocio final del rango, inclusive. */
  readonly dateTo?: IsoDate | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** Una pagina de filas con el total de filas que coinciden. */
export interface CustomerFinancePage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}
