/**
 * Configuración de ESLint para apps/web (Next.js App Router).
 * Complementa la base con las reglas específicas de Next.js.
 *
 * @type {import("eslint").Linter.Config[]}
 */
import base from './base.mjs';

export default [
  ...base,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // En App Router los Server Components por defecto; "use client" es explícito.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@agroemprende/supabase/server'],
              message:
                'El cliente de servidor (cookies httpOnly) solo puede usarse en Server Components o Route Handlers.',
            },
          ],
        },
      ],
    },
  },
];
