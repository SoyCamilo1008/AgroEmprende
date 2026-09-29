# AgroEmprende

Software de gestión para pequeñas y medianas granjas avícolas y porcícolas de Colombia.
Registra producción, inventario, ventas, cartera y costos reales, y calcula utilidad
sin que el usuario tenga que hacer cuentas a mano.

El principio que gobierna todo el proyecto: **el sistema no inventa datos**. Si un valor
no se conoce, se pide o se marca como pendiente. Un número estimado nunca se presenta
como si fuera un hecho.

## Estado actual

Fase 3 — fundación financiera (libro mayor, ventas, cartera, pagos, gastos, inversiones).
Las fases 1 (arquitectura y motor de cálculo) y 2 (base multiusuario) siguen verificadas;
la tabla refleja el estado de todas.

| Componente                   | Estado                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `@agroemprende/types`        | Tipos de dominio compartidos, sin dependencias de framework                       |
| `@agroemprende/validation`   | Esquemas Zod reutilizables por web, móvil y base de datos                         |
| `@agroemprende/calculations` | Motor de cálculo puro: dinero, alimento, producción, ventas, inventario, utilidad |
| `@agroemprende/ui`           | Componentes compartidos entre web y móvil                                         |
| `@agroemprende/supabase`     | Clientes de Supabase (web con SSR, móvil) y validación de env                     |
| `apps/web`                   | Next.js 16 con App Router                                                         |
| `apps/mobile`                | Expo 57 con Expo Router                                                           |
| Base de datos                | Esquema, RLS, seed y pruebas escritos. **Sin aplicar ni probar** (ver abajo)      |

### La base de datos está escrita, no verificada

Trece migraciones en `supabase/migrations/`, un seed de plantilla y seis archivos de
pruebas pgTAP en `supabase/tests/`. Las cuatro últimas migraciones escriben el esquema
`finance`: libro mayor de doble partida, ventas, cartera, pagos, gastos, inversiones y
reinversiones, con la escritura restringida a funciones `SECURITY DEFINER` y las tablas
de solo lectura por RLS.

**No han sido aplicadas contra PostgreSQL.** Aplicarlas exige Docker, que no está
disponible en la máquina de desarrollo, así que hasta que el job `migrations` del CI pase
en verde el esquema no está verificado: el SQL podría tener un error de sintaxis o una
política que no se comporte como dice. Lo que sí se puede verificar sin Docker
(`pnpm tooling:check`) está en verde, y valida los nombres y el orden de las migraciones y
que los permisos del seed coincidan con los de TypeScript.

Esto no es un detalle: un esquema sin ejecutar es una hipótesis, no una base de datos.

Verificación local (debe quedar en verde antes de abrir un PR):

```bash
pnpm check   # format:check + lint + typecheck + test
pnpm build   # compila apps/web
```

## Requisitos

- Node.js `22.11.0` (ver `.nvmrc`; `engine-strict` lo exige)
- pnpm `12.6.0` (fijado en `package.json` con `packageManager`)
- Docker, solo si vas a levantar Postgres local con Supabase CLI

```bash
nvm use          # toma la versión de .nvmrc
corepack enable  # habilita la versión de pnpm fijada
pnpm install
```

## Estructura

```
apps/
  web/        Next.js 16 (App Router, Server Components, RSC)
  mobile/     Expo 57 / React Native 0.87 (Expo Router)
packages/
  types/      Tipos primitivos y de dominio. Sin React, sin Supabase, sin Deno.
  validation/ Esquemas Zod. Compartidos por el frontend y replicados en SQL.
  calculations/ Motor de cálculo puro. Funciones puras, sin IO, sin framework.
  ui/         Componentes compartidos entre las dos apps.
  supabase/   Clientes de Supabase y validación de variables de entorno.
  config/     ESLint, Tailwind y configuraciones compartidas.
supabase/     Configuración local, migraciones y seed.
tools/        Scripts de verificación del propio repositorio.
docs/         Documentación y registros de decisión (ADR).
```

Regla de dependencia: `types` no depende de nadie; `calculations` solo depende de
`types`; las apps dependen de los paquetes, nunca al revés. `@agroemprende/ui`
depende de `calculations` únicamente para formatear dinero, no para calcular.

## Comandos

| Comando                  | Qué hace                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| `pnpm dev`               | Levanta las apps en modo desarrollo                                          |
| `pnpm check`             | Formato, lint, tipos y pruebas (lo que exige el PR)                          |
| `pnpm format`            | Aplica Prettier                                                              |
| `pnpm lint` / `lint:fix` | ESLint con reglas tipadas                                                    |
| `pnpm typecheck`         | `tsc --noEmit` por paquete                                                   |
| `pnpm test`              | Vitest                                                                       |
| `pnpm test:coverage`     | Vitest con cobertura                                                         |
| `pnpm build`             | Build de producción                                                          |
| `pnpm db:start`          | Levanta Supabase local (Docker)                                              |
| `pnpm db:reset`          | Recrea la base desde migraciones y carga el seed                             |
| `pnpm db:lint`           | Analiza el esquema resultante                                                |
| `pnpm db:test`           | Pruebas pgTAP del aislamiento multiusuario y del negocio financiero (Docker) |
| `pnpm migrations:new`    | Crea una migración con el nombre y la cabecera correctos                     |
| `pnpm tooling:check`     | Reglas de migración y coherencia esquema/código                              |

## Variables de entorno

Copia `.env.example` a `.env.local` (web) o `.env` (Supabase CLI y Edge Functions).
Nunca se commitea el archivo resultante: está en `.gitignore`.

Las variables con prefijo `NEXT_PUBLIC_*` o `EXPO_PUBLIC_*` viajan al navegador o al
móvil, así que solo pueden contener la URL de Supabase y la anon key (protegidas por
RLS). Una service role key o una API key de IA nunca van ahí.

## Cómo se escribe el código

- **TypeScript estricto.** Nada de `any`. Los identificadores llevan marca de dominio
  (`FlockId`, `PigId`) para que no se puedan confundir en un `function f(a: Uuid)`.
- **El dinero es un entero de centavos.** Nunca `float`. `toMoney(pesos)` y
  `pesosToMoney(centavos)` son las únicas puertas de entrada, con redondeo
  `ROUND_HALF_UP` explícito. Ver `docs/decisions/ADR-0006`.
- **Las fechas de negocio son `IsoDate` (`YYYY-MM-DD`), nunca `Date`.** Un `Date`
  representa un instante y depende de la zona horaria del navegador. Ver ADR-0012.
- **Los cálculos no reciben valores por defecto.** Reciben `InsufficientData<T>`, que
  obliga a manejar el caso "no se sabe".
- **Las pantallas no recalculan.** Todo número de negocio sale de
  `@agroemprende/calculations`; las funciones son puras y están cubiertas por pruebas.
- **Importes relativos sin extensión.** `import { cn } from '../lib/cn'`. El bundler
  de Next no resuelve `../lib/cn.js` contra el fuente TypeScript.

## Documentación

- `docs/README.md` — índice de la documentación y orden de lectura sugerido
- `docs/testing.md` — qué se prueba y qué no
- `docs/database/migrations.md` — reglas de migraciones
- `docs/database/costing.md` — cómo se costea producción e inventario
- `docs/architecture/auth.md` — organizaciones, roles y multitenant
- `docs/architecture/rls.md` — modelo de seguridad
- `docs/decisions/` — registros de decisión (ADR)

## Commits y Pull Requests

Los mensajes siguen [Conventional Commits](https://www.conventionalcommits.org/) y se
validan en el hook `commit-msg`:

```
<tipo>(<ámbito>): <descripción>
```

Tipos: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`,
`revert`, `security`. El hook `pre-commit` ejecuta `lint-staged` sobre lo staged.

## Licencia

Propiedad privada. Todos los derechos reservados.
