# Changelog

Todas las novedades de AgroEmprende se registran aquí.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el
versionado es [SemVer](https://semver.org/lang/es/). Los mensajes de commit siguen
Conventional Commits, y es el commit el que decide en qué sección entra el cambio.

## [No publicado]

Cambios en `main` que todavía no tienen versión.

## [0.1.0] — 2026-09-27

Primera versión: arquitectura del monorepo y motor de cálculo. No incluye base de datos
todavía.

### Añadido

- **Monorepo** con pnpm workspaces y Turborepo: `apps/web`, `apps/mobile` y seis
  paquetes (`types`, `validation`, `calculations`, `ui`, `supabase`, `config`).
- **Toolchain**: TypeScript estricto, ESLint 9 con reglas tipadas y `projectService`,
  Prettier con `endOfLine: lf`, commitlint con Conventional Commits y hooks de husky
  (`pre-commit` con lint-staged, `commit-msg` con commitlint).
- **Decisiones de arquitectura** (ADR-0003 a ADR-0012) y documentación de principios,
  testing, costeo, migraciones, autenticación y RLS.
- **Motor de cálculo** (`@agroemprende/calculations`), funciones puras sin IO:
  - `money`: aritmética en centavos enteros con `ROUND_HALF_UP` explícito.
  - `feed`: consumo y costo de alimento por ave, por huevo y por lote.
  - `production`: postura, margen por huevo y proyección de producción sobre huevos
    buenos, con mermas informadas aparte.
  - `sales`: total de venta, saldo por cobrar, estados y aplicación de abonos.
  - `inventory`: promedio ponderado móvil, balance y trazabilidad de carne.
  - `cycles`: utilidad, márgenes, flujo de caja, balance por cliente y reinversión.
- **Tipos de dominio** (`@agroemprende/types`) con identificadores de marca, `IsoDate`
  frente a `IsoDateTime`, `InsufficientData<T>` y catálogo de roles y permisos.
- **Validación** (`@agroemprende/validation`) con esquemas Zod reutilizables.
- **UI compartida** (`@agroemprende/ui`) con `Button`, `Card` y `MoneyDisplay`.
- **Clientes de Supabase** para web (SSR con cookies `httpOnly`) y móvil
  (`expo-secure-store`), con validación de variables de entorno al arranque.
- **Configuración local de Supabase** versionada, y verificación de migraciones con
  `pnpm tooling:check-migrations`.
- **Plantilla de variables de entorno** (`.env.example`) y reglas para no filtrar la
  service role key ni las API keys de IA al cliente.
- **CI** con verificaciones de formato, lint, tipos, pruebas, migraciones y build.

### Seguridad

- La anon key es pública por diseño y la autorización real está en RLS y en
  `private.assert_permission()` dentro de las funciones SQL, no en la UI.
- Toda escritura iniciada por el usuario lleva `idempotency_key` para evitar duplicados
  por reintento.

### Documentación

- `README.md`, `docs/README.md`, principios de negocio, estrategia de pruebas, reglas de
  migraciones, costeo, autenticación, RLS y seis ADR.
- `supabase/seed/README.md` con la clasificación `data_kind` para todo dato de
  referencia, de modo que ninguna pantalla presente un supuesto como un hecho medido.

### Notas técnicas

- `react-native-worklets@0.13.0` genera un aviso de peer dependency frente a lo que pide
  `expo-modules-core@57.0.19` (`^0.7.4 || ^0.8.0 || ^0.9.0 || ^0.10.0`). Es una
  dependencia transitiva de Expo y no se modifica a mano; se revisa al actualizar Expo.
- Los tipos públicos de estilo de React Native 0.87 rechazan estilos válidos en un caso
  conocido; `apps/mobile/src/styles.ts` centraliza el puente tipado para no desactivar
  la validación de propiedades.
- Los imports relativos van sin extensión: el bundler de Next no resuelve `../x.js`
  contra el fuente TypeScript.
- El esquema de base de datos empieza en la Fase 2, junto con las primeras migraciones.

[No publicado]: https://github.com/juan-camilo-tabares/agroemprende/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/juan-camilo-tabares/agroemprende/releases/tag/v0.1.0
