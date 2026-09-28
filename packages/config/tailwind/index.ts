/**
 * Preset de Tailwind CSS v4 compartido por apps/web y packages/ui.
 *
 * Tailwind v4 usa configuración en CSS (no tailwind.config.js). Este preset
 * expone los tokens de diseño de AgroEmprende para que ambas superficies
 * (web y, en el futuro, los componentes compartidos) sean visualmente iguales.
 */
export const designTokens = {
  color: {
    brand: {
      DEFAULT: 'oklch(0.62 0.15 145)',
      foreground: 'oklch(0.99 0 0)',
    },
    positive: 'oklch(0.65 0.17 150)',
    warning: 'oklch(0.75 0.16 80)',
    danger: 'oklch(0.58 0.20 25)',
    info: 'oklch(0.62 0.14 235)',
  },
  fontFamily: {
    sans: ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
    mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
  },
  radius: {
    card: '0.75rem',
  },
} as const;

export type DesignTokens = typeof designTokens;
