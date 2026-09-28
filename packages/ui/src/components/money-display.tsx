import { formatMoney } from '@agroemprende/calculations';
import { toMoney, type Money } from '@agroemprende/types';
import { cn } from '../lib/cn';

/**
 * Presentación de dinero.
 *
 * Regla de la casa: los importes viajan como centavos (`Money`) desde el motor
 * de cálculos y SOLO se formatean al mostrarlos. Nunca se formatea en la base
 * de datos ni se recalcula en una pantalla.
 */
export interface MoneyDisplayProps {
  readonly value: Money;
  /** true para gastos, costos y saldos a favor del negocio. */
  readonly tone?: 'neutral' | 'positive' | 'negative';
  readonly className?: string;
  readonly showSymbol?: boolean;
}

const toneClasses = {
  neutral: 'text-foreground',
  positive: 'text-positive',
  negative: 'text-danger',
} as const;

export const MoneyDisplay = ({
  value,
  tone = 'neutral',
  className,
  showSymbol = true,
}: MoneyDisplayProps) => (
  <span className={cn('tabular-nums font-medium', toneClasses[tone], className)}>
    {formatMoney(value, showSymbol ? '$' : '')}
  </span>
);

/** Presentación de un importe recibido desde la API como pesos (no centavos). */
export const PesosDisplay = ({
  value,
  tone = 'neutral',
  className,
}: Omit<MoneyDisplayProps, 'value' | 'showSymbol'> & { readonly value: number }) => (
  <MoneyDisplay value={toMoney(Math.round(value * 100))} tone={tone} className={className} />
);
