# Changelog

Todas las novedades de AgroEmprende se registran aquí.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el
versionado es [SemVer](https://semver.org/lang/es/). Los mensajes de commit siguen
Conventional Commits, y es el commit el que decide en qué sección entra el cambio.

## [No publicado]

Cambios en `main` que todavía no tienen versión.

### Añadido

- **Base de datos (Fase 3, fundación financiera)**: cuatro migraciones que escriben el
  esquema `finance`.
  - **Libro mayor de doble partida**: `ledger_entries` y `ledger_lines` inmutables con
    RLS de solo lectura. La invariante `sum(débitos) = sum(créditos)` la garantiza la
    base dos veces: `private.post_ledger_entry` valida antes de escribir y un trigger de
    restricción **diferido** (`ledger_lines_balance_invariant`) la exige aunque alguien
    escriba líneas directo. Un error contable se corrige con un contra-asiento
    (`reversal`), nunca editando la historia.
  - **Ventas y cartera**: `create_sale` (documento, líneas, cartera y asiento 1305/4105
    en una sola transacción; número de factura secuencial por organización, cliente y
    método validados) y `void_sale` (reversa 4190/1305, bloqueada si la venta tiene
    pagos aplicados).
  - **Gastos, inversiones y reinversiones**: `create_expense` (cuenta derivada del tipo
    de gasto; a crédito crea el pagable y abona 2105, de contado abona caja/bancos),
    `create_investment` (capitaliza en 1590) y `create_reinvestment` (3110 → 3120).
  - **Pagos**: `register_payment` aplica por vencimiento (FIFO) o por asignación
    explícita; el exceso de un cobro queda como dinero del cliente (2210) y el de un
    pago de salida como cuenta por cobrar al proveedor (1310), nunca como caja sin
    explicación. Un pago sin deuda abierta se descarta completo.
  - **Escritura por funciones nada más**: las tablas de `finance` son de solo lectura por
    RLS; toda escritura exige permiso (`finance.*`) y alcance sobre la unidad
    (`can_write_business_unit`), el mismo patrón de la Fase 2. `finance` quedó en
    `[api].schemas`; `private` sigue deliberadamente fuera.
  - Pruebas pgTAP nuevas: `05_finance_ledger.test.sql` (asientos, ventas, gastos,
    inversiones, reinversiones y anulación) y `06_finance_payments.test.sql` (FIFO,
    sobrepago → 2210, gasto a crédito y asignaciones). Modo sin Docker, se ejecutan en
    el job `migrations` del CI.
- **Base de datos (Fase 2)**: nueve migraciones que crean la base multiusuario.
  - Esquemas `core`, `catalog` y `private`. `private` aloja las funciones de decisión de
    RLS y queda fuera de `[api].schemas` a propósito.
  - Organizaciones, membresías, roles, permisos, unidades de negocio, unidades de
    medida, cuentas base, parámetros de referencia, auditoría, clientes, contactos y
    proveedores.
  - RLS en todas las tablas de negocio, con contexto de organización que **falla
    cerrado** cuando el usuario pertenece a más de una y no ha elegido.
  - `public.create_organization_with_business_unit()` e invitaciones
    (`create_organization_invitation`, `accept_organization_invitation`): funciones
    `SECURITY DEFINER` transaccionales e idempotentes. El token de invitación son 32
    bytes criptográficos, de un solo uso y atado al correo del invitado.
  - **Propiedad de la organización**: la invariante de "exactamente un propietario
    activo" la garantiza la base de datos. El índice único parcial cubre el "como máximo
    uno" y un trigger de restricción diferido cubre el "al menos uno", que es lo que
    permite transferir la propiedad escribiendo los dos lados en una sola transacción.
    `public.transfer_organization_ownership()` hace la transferencia: comprueba sesión,
    bloquea la fila de la organización para serializar transferencias simultáneas, exige
    que quien llama sea el propietario actual (un `admin` no puede tomársela), valida que
    el destinatario exista, pertenezca a la granja y esté activo, degrada al anterior a
    `admin` y audita el cambio.
  - **Integridad multitenant en la propia base**: las referencias entre granjas se
    declaran con la organización dentro de la clave foránea
    (`(organization_id, id)`), no solo por `id`. RLS decide qué filas puede ver un rol,
    no qué filas pueden existir: una fila colgada de otra granja es ilegible pero sigue
    siendo válida. Aplica a `member_business_units` (que además cuelga de la
    _membresía_, no de un `user_id` suelto), `accounts.parent_id` y
    `reference_parameters.business_unit_id`.
  - Seed de plantilla: 55 permisos, 5 roles, matriz rol→permiso, unidades de medida y
    plan de cuentas base. Sin datos reales y sin parámetros de referencia.
  - Pruebas pgTAP en `supabase/tests/`: aislamiento entre organizaciones, denegaciones
    por permiso, las cuatro propiedades del token de invitación, la invariante del
    propietario y la integridad multitenant.
- **`tools/check-schema.mjs`** (`pnpm tooling:check-schema`): compara el seed contra
  `packages/types/src`, exige RLS en toda tabla y **simula los `GRANT`/`REVOKE` de las
  migraciones en orden** para detectar dos fallos que ninguna otra capa ve: una migración
  que borra los permisos que otra ya concedió, y una tabla con RLS que queda
  inalcanzable. Sin esto, un permiso agregado en TypeScript y olvidado en el seed se
  deniega en silencio, y un `revoke` global deja la base entera inaccesible sin que nada
  falle al escribir el SQL.
- **CI**: el job `migrations` ahora ejecuta `db:test` después de `db:reset` y `db:lint`,
  y el job `verify` ejecuta `tooling:check-schema`.

### Cambiado

- **`paid_at` pasa a ser la fecha de liquidación, no la del primer abono.** En
  `finance.receivables` y `finance.payables` la columna se llenaba en cuanto
  entraba el primer peso, así que una cuenta con saldo pendiente aparecía como
  fechada y no se distinguía una deuda _tocada_ de una deuda _saldada_. Ahora
  solo se escribe cuando `paid_amount = original_amount` y hay un
  `check` que ata ambos hechos: `paid_at is not null` es cierto **si y solo si**
  la deuda quedó totalmente cubierta (con `original_amount > 0` aparte, porque
  un importe de cero ya está liquidado y no tiene fecha que registrar).
  - Parcial → `paid_at` sigue en `NULL`; el saldo y el estado se derivan del
    monto, nunca de esta marca. Cobertura: pgTAP `25: una deuda parcial no se
marca como pagada`.
  - Para mostrar _cuándo se recibió el último abono_ se usa el historial de
    pagos (`finance.payments.payment_date`), no `paid_at`.
  - No hay ruptura de datos: la columna nunca se ha leído para deducir estado, ni
    en la aplicación ni en SQL, y el estado visible siempre se derivó del saldo
    (ADR-0003).

### Corregido

- **El CI moría antes de ejecutar una sola prueba.** La versión de Node fijada
  (`.nvmrc` y `engines`: `22.11.0`) no cumplía el requisito de vitest 5
  (`node: ^22.12.0 || ^24.0.0 || >=26.0.0`), así que `pnpm test` terminaba con
  código 1 de inmediato en el job `Verificar`, sin llegar a ejecutar un solo
  archivo de pruebas. En verde local porque la máquina tenía Node 26: el fallo
  solo existía donde la versión se respeta, que es el CI. Ahora se fija `22.12.0`,
  el mínimo que acepta la cadena de herramientas, en `.nvmrc`, `engines` y el
  README.
- **El job `Migraciones aplicables` moría en `supabase start`.** La CLI es una
  `devDependency` del repositorio, y un paso `run:` no hereda el `node_modules/.bin`
  que arma pnpm: el runner respondía `command not found` y las migraciones nunca
  llegaban a ejecutarse. El paso ahora invoca el script declarado (`pnpm db:start`),
  que es el mismo comando con el PATH correcto.

- **Una organización podía quedarse sin propietario.** El índice único parcial
  `organization_members_one_active_owner` solo decía "como máximo un owner": nada
  impedía que un `admin` degradara o desactivara al único propietario, y una organización
  sin dueño no se puede recuperar desde la propia base de datos. Ahora un trigger de
  restricción diferido exige **exactamente** un propietario activo al cerrar la
  transacción.
- **Filas que podían colgar de otra granja.** `member_business_units.business_unit_id`,
  `member_business_units.user_id`, `accounts.parent_id` y
  `reference_parameters.business_unit_id` apuntaban solo por `id`, así que una fila podía
  referenciar algo de otra organización. Las políticas de RLS filtraban la lectura, no la
  escritura: la fila era ilegible pero no inválida. Ahora las cuatro son claves foráneas
  compuestas con `organization_id`, y el alcance por unidad cuelga de la membresía, de
  modo que desaparece con ella en vez de sobrevivir a una baja.
- **Los permisos de la base de datos se anulaban entre migraciones.** M3 a M8 ejecutaban
  `revoke all on all tables in schema core` después de que M2 concediera los permisos, y
  como cada migración no puede saber qué concedió la anterior, el revoke se llevaba
  todo: al final solo `core.organization_invitations` era alcanzable y ninguna otra tabla
  de `core` tenía `GRANT` para `anon` ni `authenticated`. El esquema era correcto y
  estaba documentado, y a la vez inaccesible. Ahora cada migración revoca solo sus
  propias tablas, y `tooling:check-schema` falla si alguien repite el patrón.
- **Un usuario invitado no podía crear su propia organización.** La idempotencia sin
  llave buscaba la primera membresía activa del usuario, así que a un `viewer` invitado a
  la granja de otro le devolvía esa granja como si fuera suya. Ahora se pregunta por
  `organizations.created_by`: "ya tengo organización" significa "esta es la mía".
- **`private.write_audit_log()` colgaba la auditoría de la organización más antigua a la
  que se había unido el usuario**, no de la del contexto, que es lo que hace todo lo
  demás. En un usuario con dos organizaciones eso significaba auditar en una
  organización una operación de la otra.
- `create_organization_invitation()` con un usuario en varias organizaciones y sin
  contexto devolvía `Permiso requerido: org.members.manage`, un error de rol donde el
  problema es que la petición no dijo de qué organización se trata. Ahora dice eso, con su
  propio código.
- `supabase/tests/`: el esquema donde la CLI instala `pgtap` se añade al `search_path`.
  Sin eso, las aserciones no se resuelven y la suite muere con `function is(...) does not
exist`, que dice bastante menos que la causa real.
- `packages/types/src/business-units.ts`: `la vistaRequested` → `la vista solicitada`.
- `docs/database/costing.md`: `para no acumulado error` → `para no acumular error`.
- Comentario engañoso en `accept_organization_invitation`: decía que aceptar dos veces no
  fallaba, cuando el token es de un solo uso por diseño. El comentario ahora describe el
  comportamiento real.
- `apps/mobile`: `expo-env.d.ts` pasa a estar ignorado y fuera del índice, en vez de
  generar un diff en cada arranque de Expo.

### Sin verificar

- **El esquema no se ha aplicado contra PostgreSQL.** Docker no está disponible en la
  máquina de desarrollo, así que las trece migraciones, el seed y los seis archivos de
  pruebas pgTAP no se han ejecutado. Hasta que el job `migrations` del CI pase, el SQL
  puede tener errores de sintaxis o políticas que no se comporten como dicen los
  comentarios.

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
