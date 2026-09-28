/**
 * @agroemprende/ui
 *
 * Sistema de diseño. Los componentes son "tontos" a propósito: reciben datos ya
 * calculados por `@agroemprende/calculations` y solo los presentan. Ninguna
 * pantalla calcula dinero; ninguna pantalla aplica reglas de negocio.
 */
export { Button, type ButtonProps } from './components/button';
export { Card, CardHeader, CardTitle } from './components/card';
export { MoneyDisplay, PesosDisplay, type MoneyDisplayProps } from './components/money-display';
export { cn } from './lib/cn';
