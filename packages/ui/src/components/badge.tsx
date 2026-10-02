import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Distintivo de estado.
 *
 * Es tonto a propósito: recibe una ETIQUETA ya resuelta y un tono, y nada más. No sabe
 * qué significa "VENCIDA" ni cuándo aplicarla: eso lo decidió quien ya consultó la
 * base, y por eso el mismo distintivo sirve para una obligación vencida, un pago
 * parcial o una venta anulada.
 *
 * El color NO es la única señal, porque la etiqueta siempre se escribe. Un distintivo
 * rojo y sin texto solo le funciona a quien distingue rojo de verde, y la información
 * se pierde justo en el color con más área de la fila.
 */
export type BadgeTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info' | 'muted';

export interface BadgeProps {
  readonly label: string;
  readonly tone?: BadgeTone | undefined;
  readonly className?: string | undefined;
  /** Contenido extra después de la etiqueta, para una fecha o un conteo. */
  readonly children?: ReactNode | undefined;
}

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-foreground/5 text-foreground ring-1 ring-border',
  positive: 'bg-positive/10 text-positive ring-1 ring-positive/25',
  warning: 'bg-warning/10 text-warning ring-1 ring-warning/25',
  danger: 'bg-danger/10 text-danger ring-1 ring-danger/25',
  info: 'bg-info/10 text-info ring-1 ring-info/25',
  muted: 'bg-foreground/5 text-foreground/60 ring-1 ring-border',
};

export const Badge = ({ label, tone = 'neutral', className, children }: BadgeProps) => (
  <span
    className={cn(
      'inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap',
      toneClasses[tone],
      className,
    )}
  >
    {label}
    {children}
  </span>
);
