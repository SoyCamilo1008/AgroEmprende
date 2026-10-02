/**
 * @agroemprende/ui
 *
 * Sistema de diseño. Los componentes son "tontos" a propósito: reciben datos ya
 * calculados por `@agroemprende/calculations` y solo los presentan. Ninguna
 * pantalla calcula dinero; ninguna pantalla aplica reglas de negocio.
 */
export { Badge, type BadgeProps, type BadgeTone } from './components/badge';
export { Button, type ButtonProps } from './components/button';
export { Card, CardHeader, CardTitle } from './components/card';
export {
  DataTable,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
  type DataTableProps,
  type TableCellProps,
  type TableHeadCellProps,
} from './components/data-table';
export { EmptyState, type EmptyStateProps } from './components/empty-state';
export { MoneyDisplay, PesosDisplay, type MoneyDisplayProps } from './components/money-display';
export { Stat, StatGrid, type StatProps, type StatGridProps } from './components/stat';
export { cn } from './lib/cn';
