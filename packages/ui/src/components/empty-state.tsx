import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Estado vacío: lo que se ve cuando una consulta no devolvió nada.
 *
 * Dice QUÉ se esperaba y POR QUÉ no hay datos, y nunca los inventa. Un espacio en
 * blanco deja a quien mira la pantalla sin saber si el cliente no debe nada, si la
 * consulta falló o si la página está rota; las tres se ven idénticas y solo una es
 * un dato. Un mensaje que dice "sin datos" sin más es la versión peor, porque parece
 * una respuesta cuando en realidad es una ausencia.
 *
 * `detail` lleva la razón concreta: "nunca ha tenido una venta" y "ningún pago
 * registrado" son hechos distintos, y el usuario necesita saber cuál está mirando.
 */
export interface EmptyStateProps {
  readonly title: string;
  /** La razón concreta de que esté vacío. Sin esto el estado vacío no informa. */
  readonly detail?: string | undefined;
  readonly action?: ReactNode | undefined;
  readonly className?: string | undefined;
  readonly icon?: ReactNode | undefined;
}

export const EmptyState = ({ title, detail, action, className, icon }: EmptyStateProps) => (
  <div
    className={cn(
      'flex flex-col items-center gap-2 rounded border border-dashed border-border px-6 py-10 text-center',
      className,
    )}
  >
    {icon === undefined ? null : <div className="text-foreground/30">{icon}</div>}
    <p className="text-sm font-medium text-foreground">{title}</p>
    {detail === undefined ? null : <p className="max-w-sm text-sm text-foreground/60">{detail}</p>}
    {action === undefined ? null : <div className="mt-2">{action}</div>}
  </div>
);
