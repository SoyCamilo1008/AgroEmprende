import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/**
 * Tabla de datos.
 *
 * Existe por el encabezado `<caption>`, no por los bordes. Una tabla sin título en un
 * lector de pantalla es un archivo de números sin nombre: si el usuario no puede decir
 * qué es la columna "Vencimiento", la columna no le sirve aunque se lea perfecto. Por
 * eso `caption` es obligatorio y `showCaption` solo decide si además se ve en pantalla.
 */
export interface DataTableProps {
  /** Título de la tabla. Required: es la única etiqueta que da sentido a las columnas. */
  readonly caption: string;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  /** `true` (por defecto) muestra el título en pantalla; `false` lo deja solo para lectores. */
  readonly showCaption?: boolean | undefined;
}

export const DataTable = ({ caption, children, className, showCaption = true }: DataTableProps) => (
  <div className={cn('overflow-x-auto', className)}>
    <table className="w-full border-collapse text-sm">
      <caption
        className={cn(
          'pb-2 text-left text-sm font-medium text-foreground',
          !showCaption && 'sr-only',
        )}
      >
        {caption}
      </caption>
      {children}
    </table>
  </div>
);

export const TableHead = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className={cn('border-b border-border', className)} {...props} />
);

export const TableBody = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody className={cn('divide-y divide-border', className)} {...props} />
);

export const TableRow = ({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn('hover:bg-surface-hover', className)} {...props} />
);

export interface TableHeadCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** Alineación de la columna. Los importes van a la derecha: se suman y se comparan. */
  readonly align?: 'left' | 'right' | undefined;
}

const alignClasses = { left: 'text-left', right: 'text-right' } as const;

export const TableHeadCell = ({ align = 'left', className, ...props }: TableHeadCellProps) => (
  <th
    scope="col"
    className={cn(
      'px-3 py-2 text-xs font-medium tracking-wide text-foreground/60 uppercase',
      alignClasses[align],
      className,
    )}
    {...props}
  />
);

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  readonly align?: 'left' | 'right' | undefined;
  /** `true` (por defecto) marca la celda como encabezado de su fila, para lectores. */
  readonly header?: boolean | undefined;
}

export const TableCell = ({
  align = 'left',
  header = false,
  className,
  ...props
}: TableCellProps) =>
  header ? (
    <th
      scope="row"
      className={cn(
        'px-3 py-2 text-left font-medium text-foreground',
        alignClasses[align],
        className,
      )}
      {...props}
    />
  ) : (
    <td className={cn('px-3 py-2 text-foreground/80', alignClasses[align], className)} {...props} />
  );
