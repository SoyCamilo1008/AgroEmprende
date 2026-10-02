import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Mosaico de totales: el bloque de cifras que responde "¿cuánto me debe?".
 *
 * `Stat` es tonto: recibe una etiqueta y un valor YA calculado y listo para mostrar. No
 * suma, no formatea dinero y no conoce `Money`. Quien lo usa decide si el importe
 * viene de `MoneyDisplay` o de un conteo, y por eso el mismo mosaico muestra "debe
 * $160.000" y "3 ventas" sin que ninguno de los dos números se convierta en texto
 * dentro del componente.
 */
export interface StatProps {
  readonly label: string;
  readonly children: ReactNode;
  /**
   * Tono del VALOR. Para deuda se usa `negative` y para lo cobrado `positive`: el
   * número ya está calculado, aquí solo se decide cómo se lee.
   */
  readonly tone?: 'neutral' | 'positive' | 'negative' | undefined;
  /** Texto de apoyo bajo la cifra, como "de 3 unidades". */
  readonly hint?: string | undefined;
  /** `true` cuando el dato no existe y no se debe rellenar con un cero. */
  readonly pending?: boolean | undefined;
  readonly className?: string | undefined;
}

const toneClasses = {
  neutral: 'text-foreground',
  positive: 'text-positive',
  negative: 'text-danger',
} as const;

export const Stat = ({
  label,
  children,
  tone = 'neutral',
  hint,
  pending = false,
  className,
}: StatProps) => (
  <div className={cn('min-w-0', className)}>
    <dt className="text-xs font-medium tracking-wide text-foreground/60 uppercase">{label}</dt>
    <dd className={cn('mt-1 text-xl font-semibold tabular-nums', toneClasses[tone])}>
      {pending ? (
        // Un guion, no un cero ni un esqueleto parpadeante: la cifra todavia no se ha
        // consultado y "0" seria un saldo que nadie midio.
        <span className="text-foreground/30" aria-label="Sin dato">
          —
        </span>
      ) : (
        children
      )}
    </dd>
    {hint === undefined ? null : <p className="mt-0.5 text-xs text-foreground/50">{hint}</p>}
  </div>
);

export interface StatGridProps {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

export const StatGrid = ({ children, className }: StatGridProps) => (
  <dl className={cn('grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4', className)}>
    {children}
  </dl>
);
