/**
 * Cómo se ve un estado en la pantalla, sin decidir qué estado es.
 *
 * La decisión del estado la tomó PostgreSQL (`finance.customer_receivables` ya trae
 * `status` y `status_label`), y aquí solo se traduce a color. Es deliberado: si esta
 * tabla decidiera qué es "vencida", habría dos reglas de vencimiento — la de la base y
 * la del navegador — y la segunda no se probaría contra datos reales.
 *
 * El tono nunca reemplaza la etiqueta: `statusLabel` siempre se escribe al lado, así
 * que la información no depende de distinguir colores.
 */
import type { BadgeTone } from '@agroemprende/ui';
import type { PaymentMethod, ReceivableStatus, SettlementMethod } from '@agroemprende/types';

/** Tono del distintivo según el estado interno de la obligación. */
export const receivableTone = (status: ReceivableStatus): BadgeTone => {
  switch (status) {
    // Verde: lo que el cliente ya pagó. Es lo único que se celebra con color.
    case 'paid':
      return 'positive';
    // Rojo: lo que ya se pasó de fecha. Es lo único que necesita alarma.
    case 'overdue':
      return 'danger';
    case 'written_off':
      return 'muted';
    // Anulada: una obligación que la contabilidad dio de baja ni es deuda ni es un
    // problema. Mostrarla en rojo sería inventar una alarma.
    case 'void':
      return 'muted';
    case 'partial':
      return 'warning';
    case 'open':
      return 'info';
    default:
      // Un estado que no exista todavía no se pinta de ningún color conocido: se ve
      // neutro y llama la atención por no parecerse a los demás.
      return 'neutral';
  }
};

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  bank_transfer: 'Transferencia',
  card: 'Tarjeta',
  digital_wallet: 'Billetera digital',
  // `credit` no es un medio de pago: es la AUSENCIA de cobro inmediato. Se dice
  // "Crédito" y no "No pagó", que suena a un problema en vez de a una condición de
  // venta pactada.
  credit: 'Crédito',
};

export const paymentMethodLabel = (method: PaymentMethod): string =>
  PAYMENT_METHOD_LABELS[method] ?? method;

const SETTLEMENT_METHOD_LABELS: Record<SettlementMethod, string> = {
  cash: 'Efectivo',
  bank_transfer: 'Transferencia',
  card: 'Tarjeta',
  digital_wallet: 'Billetera digital',
};

export const settlementMethodLabel = (method: SettlementMethod): string =>
  SETTLEMENT_METHOD_LABELS[method] ?? method;
