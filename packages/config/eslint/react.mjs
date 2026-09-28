/**
 * Configuración de ESLint para paquetes con React (apps/web, packages/ui).
 * Requiere `eslint-plugin-react-hooks`, declarado como dependencia de este
 * paquete porque la configuración lo importa en tiempo de ejecución.
 *
 * Nota: aquí no se activa el plugin de JSX de React (`eslint-plugin-react`).
 * La versión moderna de Next.js usa el nuevo transform de JSX y el plugin
 * clásico produce falsos positivos; las reglas que importan son las de hooks.
 *
 * @type {import("eslint").Linter.Config[]}
 */
import base from './base.mjs';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  ...base,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
