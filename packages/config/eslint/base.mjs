/**
 * Configuración base de ESLint (flat config) para todos los paquetes y apps.
 *
 * Reglas de la casa:
 *  - Prohibido `any` implícito: se exige `unknown` + narrowing.
 *  - Sin variables sin usar (TypeScript ya lo comprueba, ESLint lo reinforce).
 *  - Sin `!` (non-null assertion) en código de dominio: se prefiere validar.
 *  - Sin `console.log` en código de aplicación (se usa el logger).
 *
 * @type {import("eslint").Linter.Config[]}
 */
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/.expo/**',
      '**/generated/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    // `projectService` habilita el lint con información de tipos, necesario
    // para reglas como `no-floating-promises`. No fijamos `tsconfigRootDir`:
    // el valor por defecto es `process.cwd()`, que es el directorio del
    // paquete que se está lintando (donde vive su tsconfig.json).
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  prettierConfig,
);
