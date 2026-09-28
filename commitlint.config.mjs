/**
 * Conventional Commits. Los mensajes se validan en el hook commit-msg.
 *
 * Tipos permitidos (scope entre paréntesis, en minúsculas):
 *   feat      nueva funcionalidad
 *   fix       corrección de error
 *   refactor  cambio de comportamiento sin añadir ni corregir funcionalidad
 *   perf      mejora de rendimiento
 *   test      pruebas
 *   docs      documentación
 *   build     sistema de build / dependencias
 *   ci        GitHub Actions
 *   chore     tareas que no alteran src ni docs
 *   revert    reversión
 *   security  endurecimiento de seguridad
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'refactor',
        'perf',
        'test',
        'docs',
        'build',
        'ci',
        'chore',
        'revert',
        'security',
      ],
    ],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [2, 'always', 120],
    'scope-enum': [
      1,
      'always',
      [
        'web',
        'mobile',
        'ui',
        'types',
        'validation',
        'calculations',
        'supabase',
        'db',
        'migrations',
        'rls',
        'auth',
        'finance',
        'poultry',
        'swine',
        'inventory',
        'ai',
        'docs',
        'ci',
        'deps',
        'root',
      ],
    ],
  },
};
