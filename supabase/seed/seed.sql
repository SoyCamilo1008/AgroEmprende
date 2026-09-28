-- Seed de PLANTILLA. Nunca datos reales.
--
-- Ver supabase/seed/README.md para las reglas y
-- docs/decisions/ADR-0011-datos-reales.md para el principio que las respalda.
--
-- Dos reglas que este archivo cumple y que el verificador comprueba:
--   * Todo INSERT lleva ON CONFLICT: `supabase db reset` y `supabase start`
--     ejecutan el seed más de una vez sobre la misma base.
--   * Nada de datos reales ni de ejemplo creíble. No hay nombres de granjas,
--     ni teléfonos, ni documentos de clientes, ni montos. Las cuentas se nombran
--     por su función contable, no por quién las escribió.
--
-- Verificación: pnpm db:reset
--              pnpm tooling:check-schema  (permisos y RLS)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Permisos
--
-- Réplica de `PERMISSIONS` en packages/types/src/auth.ts. La lista vive en
-- TypeScript porque el cliente la usa para tipar y para ocultar botones; aquí
-- se replica porque RLS la consulta por nombre. Un PR que agregue un permiso
-- actualiza los dos lados, y `pnpm tooling:check-schema` falla si se olvidan.
--
-- `category` es el prefijo antes del punto.
-- ─────────────────────────────────────────────────────────────────────────────

insert into core.permissions (code, category, description) values
  ('org.read', 'org', 'Ver la organización'),
  ('org.update', 'org', 'Editar los datos de la organización'),
  ('org.members.manage', 'org', 'Invitar, cambiar roles y desactivar miembros'),
  ('business_units.manage', 'org', 'Crear y editar unidades de negocio'),
  ('settings.manage', 'org', 'Administrar catálogos y parámetros del sistema'),
  ('audit.read', 'org', 'Leer el registro de auditoría'),

  ('customers.read', 'catalog', 'Ver clientes'),
  ('customers.write', 'catalog', 'Crear y editar clientes'),
  ('suppliers.read', 'catalog', 'Ver proveedores'),
  ('suppliers.write', 'catalog', 'Crear y editar proveedores'),
  ('products.read', 'catalog', 'Ver productos'),
  ('products.write', 'catalog', 'Crear y editar productos'),
  ('prices.write', 'catalog', 'Editar precios y costos'),

  ('finance.read', 'finance', 'Ver el módulo financiero'),
  ('finance.dashboard', 'finance', 'Ver el tablero financiero'),
  ('finance.sales.read', 'finance', 'Ver ventas'),
  ('finance.sales.create', 'finance', 'Registrar ventas'),
  ('finance.sales.void', 'finance', 'Anular ventas'),
  ('finance.payments.read', 'finance', 'Ver pagos'),
  ('finance.payments.create', 'finance', 'Registrar pagos'),
  ('finance.receivables.read', 'finance', 'Ver cartera'),
  ('finance.receivables.manage', 'finance', 'Gestionar cuentas por cobrar'),
  ('finance.expenses.read', 'finance', 'Ver gastos'),
  ('finance.expenses.create', 'finance', 'Registrar gastos'),
  ('finance.investments.read', 'finance', 'Ver inversiones'),
  ('finance.investments.create', 'finance', 'Registrar inversiones'),
  ('finance.reinvestments.read', 'finance', 'Ver reinversiones'),
  ('finance.reinvestments.create', 'finance', 'Registrar reinversiones'),
  ('finance.cashflow.read', 'finance', 'Ver el flujo de caja'),
  ('finance.profit.read', 'finance', 'Ver la utilidad consolidada'),
  ('finance.ledger.manage', 'finance', 'Administrar asientos y el plan de cuentas'),

  ('inventory.read', 'inventory', 'Ver inventarios'),
  ('inventory.purchases.create', 'inventory', 'Registrar compras'),
  ('inventory.movements.read', 'inventory', 'Ver movimientos de inventario'),
  ('inventory.adjust', 'inventory', 'Ajustar inventarios'),

  ('poultry.read', 'poultry', 'Ver lotes y producción de ponedoras'),
  ('poultry.flocks.manage', 'poultry', 'Crear y editar lotes'),
  ('poultry.production.create', 'poultry', 'Registrar producción diaria'),
  ('poultry.feed.record', 'poultry', 'Registrar consumo de alimento'),
  ('poultry.water.record', 'poultry', 'Registrar consumo de agua'),
  ('poultry.health.record', 'poultry', 'Registrar eventos de salud'),
  ('poultry.disposals.record', 'poultry', 'Registrar descartes y bajas'),

  ('swine.read', 'swine', 'Ver cerdos y ciclos'),
  ('swine.pigs.manage', 'swine', 'Crear y editar cerdos'),
  ('swine.weights.record', 'swine', 'Registrar pesajes'),
  ('swine.feed.record', 'swine', 'Registrar consumo de alimento'),
  ('swine.water.record', 'swine', 'Registrar consumo de agua'),
  ('swine.health.record', 'swine', 'Registrar eventos de salud'),
  ('swine.slaughters.record', 'swine', 'Registrar sacrificios y canal'),
  ('swine.cuts.record', 'swine', 'Registrar cortes'),
  ('swine.cycles.manage', 'swine', 'Crear y editar ciclos'),
  ('swine.cycles.close', 'swine', 'Cerrar ciclos'),

  ('ai.chat', 'ai', 'Conversar con AgroIA'),
  ('ai.actions.propose', 'ai', 'Pedir propuestas de acción a AgroIA'),
  ('ai.actions.execute', 'ai', 'Ejecutar una propuesta de AgroIA')
on conflict (code) do update
  set category = excluded.category,
      description = excluded.description;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Roles
--
-- Réplica de `ROLES` y de la tabla de docs/architecture/auth.md. El `rank` es
-- el orden de autoridad; no se usa para decidir permisos (eso es la matriz de
-- abajo), sino para presentar y para impedir rebajar a alguien por debajo del
-- que lo administra.
-- ─────────────────────────────────────────────────────────────────────────────

insert into core.roles (code, name, description, rank, is_system) values
  ('owner', 'Propietario', 'Todo, incluido administrar la organización y sus miembros', 100, true),
  ('admin', 'Administrador', 'Todo excepto transferir la propiedad', 80, true),
  ('manager', 'Encargado', 'Opera su unidad de negocio: producción, ventas y pagos', 60, true),
  ('operator', 'Operador', 'Registra hechos operativos de su unidad, sin ver utilidad consolidada', 40, true),
  ('viewer', 'Observador', 'Solo lectura', 20, true)
on conflict (code) do update
  set name = excluded.name,
      description = excluded.description,
      rank = excluded.rank,
      is_system = excluded.is_system;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Matriz rol → permisos
--
-- Una sola sentencia a propósito. Los CTE de PostgreSQL viven solo dentro de
-- la sentencia que los declara: una lista de seis INSERT con un WITH cada uno
-- se leería como seis matrices, y el que no lo sepa solo lo descubre cuando la
-- tercera falla con «relation does not exist».
--
-- La matriz se lee por reglas, no fila por fila, para que se vea la decisión:
--
--   owner    → todos los permisos, siempre. Un permiso nuevo entra aquí solo.
--   admin    → todos. En la v1 no hay permiso de "borrar organización" ni de
--              "transferir propiedad", así que admin y owner coinciden; cuando
--              aparezcan, se restan en la regla de admin.
--   manager  → todos MENOS administrar la organización, sus miembros y leer la
  --              auditoría. Opera la granja sin ser quien la administra.
--   operator → lista explícita (fail-closed). Si mañana se agrega un permiso
--              nuevo, NO se le concede por accidente.
--   viewer   → solo lectura, y sin `audit.read`.
--
-- El criterio para operator y viewer es la lista explícita y no la exclusión,
-- porque un permiso olvidado en una exclusión se concede solo. Un permiso
-- nuevo nace sin permisos y hay que decidir a quién le corresponde; ese es el
-- costo correcto de equivocarse.
-- ─────────────────────────────────────────────────────────────────────────────

with perms(code) as (
  select unnest(array[
    'org.read', 'org.update', 'org.members.manage', 'business_units.manage',
    'settings.manage', 'audit.read',
    'customers.read', 'customers.write', 'suppliers.read', 'suppliers.write',
    'products.read', 'products.write', 'prices.write',
    'finance.read', 'finance.dashboard', 'finance.sales.read', 'finance.sales.create',
    'finance.sales.void', 'finance.payments.read', 'finance.payments.create',
    'finance.receivables.read', 'finance.receivables.manage', 'finance.expenses.read',
    'finance.expenses.create', 'finance.investments.read', 'finance.investments.create',
    'finance.reinvestments.read', 'finance.reinvestments.create', 'finance.cashflow.read',
    'finance.profit.read', 'finance.ledger.manage',
    'inventory.read', 'inventory.purchases.create', 'inventory.movements.read',
    'inventory.adjust',
    'poultry.read', 'poultry.flocks.manage', 'poultry.production.create',
    'poultry.feed.record', 'poultry.water.record', 'poultry.health.record',
    'poultry.disposals.record',
    'swine.read', 'swine.pigs.manage', 'swine.weights.record', 'swine.feed.record',
    'swine.water.record', 'swine.health.record', 'swine.slaughters.record',
    'swine.cuts.record', 'swine.cycles.manage', 'swine.cycles.close',
    'ai.chat', 'ai.actions.propose', 'ai.actions.execute'
  ]) as code
),
matrix(role_code, permission_code) as (
  -- Owner: todo. Un permiso nuevo entra aquí sin tocar nada más.
  select 'owner', code from perms

  union all

  -- Admin: todo. Ver la nota de arriba sobre por qué coincide con owner en la v1.
  select 'admin', code from perms

  union all

  -- Manager: opera la granja, pero no administra a las personas ni la
  -- organización, y no ve la auditoría.
  select 'manager', code from perms
  where code not in (
    'org.update', 'org.members.manage', 'settings.manage', 'audit.read'
  )

  union all

  -- Operator: registra hechos operativos de su unidad. NO ve `finance.profit.read`
  -- (la utilidad consolidada es del dueño) ni `finance.ledger.manage`, ni
  -- `ai.actions.execute` (ejecutar una acción de AgroIA escribe en los libros y
  -- ADR-0011 exige confirmación humana: proponer sí, ejecutar no).
  select 'operator', unnest(array[
    'org.read',
    'customers.read', 'customers.write',
    'suppliers.read', 'suppliers.write',
    'products.read',
    'finance.read', 'finance.sales.read', 'finance.sales.create',
    'finance.payments.read', 'finance.payments.create',
    'finance.receivables.read',
    'finance.expenses.read', 'finance.expenses.create',
    'finance.investments.read',
    'inventory.read', 'inventory.purchases.create', 'inventory.movements.read',
    'poultry.read', 'poultry.flocks.manage', 'poultry.production.create',
    'poultry.feed.record', 'poultry.water.record', 'poultry.health.record',
    'poultry.disposals.record',
    'swine.read', 'swine.pigs.manage', 'swine.weights.record', 'swine.feed.record',
    'swine.water.record', 'swine.health.record', 'swine.slaughters.record',
    'swine.cuts.record', 'swine.cycles.manage',
    'ai.chat'
  ])

  union all

  -- Viewer: solo lectura. Sin `audit.read`: leer quién borró o desactivó un
  -- registro es un permiso de dirección, no de consulta.
  select 'viewer', unnest(array[
    'org.read',
    'customers.read', 'suppliers.read', 'products.read',
    'finance.read', 'finance.sales.read', 'finance.payments.read',
    'finance.receivables.read', 'finance.expenses.read',
    'finance.investments.read', 'finance.reinvestments.read', 'finance.cashflow.read',
    'inventory.read', 'inventory.movements.read',
    'poultry.read', 'swine.read',
    'ai.chat'
  ])
)
insert into core.role_permissions (role_code, permission_code)
select role_code, permission_code
from matrix
on conflict (role_code, permission_code) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Unidades de medida
--
-- Los códigos replican `MEASURE_UNITS` de @agroemprende/types. Los FACTORES
-- son datos reales de conversión (1 kg = 1000 g, 1 lb = 453.592 g) y por eso
-- viven aquí y no como constantes en el código: corregirlos es un UPDATE, no un
-- despliegue (packages/types/src/units.ts).
--
-- Primero las unidades base (factor 1 hacia sí mismas), después las derivadas:
-- la FK `base_code` se referencia a sí misma, así que el orden importa.
-- ─────────────────────────────────────────────────────────────────────────────

insert into catalog.measure_units (code, name, base_code, factor_to_base, is_pack) values
  -- Conteo.
  ('unit', 'Unidad', 'unit', 1, false),
  ('dozen', 'Docena', 'unit', 12, true),
  ('tray', 'Bandeja', 'unit', 30, true),
  -- Masa. `kg` es la base; `g`, `ton` y `lb` cuelgan de ella.
  ('kg', 'Kilogramo', 'kg', 1, false),
  ('g', 'Gramo', 'kg', 0.001, false),
  ('ton', 'Tonelada', 'kg', 1000, true),
  ('lb', 'Libra', 'kg', 0.453592, false),
  -- Volumen.
  ('liter', 'Litro', 'liter', 1, false),
  ('m3', 'Metro cúbico', 'liter', 1000, false),
  -- Empaque.
  ('bag', 'Saco', 'kg', 40, true),
  -- Tiempo: la antigüedad de un lote se cuenta en días.
  ('day', 'Día', 'day', 1, false)
on conflict (code) do update
  set name = excluded.name,
      base_code = excluded.base_code,
      factor_to_base = excluded.factor_to_base,
      is_pack = excluded.is_pack;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Modelo de cuentas base
--
-- Estas filas son PLANTILLA GLOBAL (`core.account_templates`), no el plan de
-- cuentas de ninguna granja: `core.accounts` exige `organization_id` y al
-- arrancar el entorno no existe ninguna. El alta de la organización copia este
-- modelo y a partir de ahí la granja es dueña de su plan de cuentas.
--
-- Los códigos son los grupos estándar del NIF y los nombres son POR FUNCIÓN
-- ("Caja", "Cuentas por cobrar"), no por quién los escribió. El plan completo
-- lo define el contador con cada granja; esto es el punto de partida, y por eso
-- `is_system` travela en la copia para que la app sepa qué puede sugerir y qué
-- no.
--
-- Orden de inserción: los padres antes que los hijos, porque
-- `parent_template_code` es una FK a esta misma tabla.
-- ─────────────────────────────────────────────────────────────────────────────

insert into core.account_templates (code, name, type, parent_template_code, description) values
  -- Activo.
  ('1105', 'Caja', 'asset', null, 'Efectivo disponible'),
  ('1110', 'Bancos', 'asset', null, 'Depósitos y cuentas bancarias'),
  ('1305', 'Cuentas por cobrar', 'asset', null, 'Saldo por cobrar a clientes (ADR-0003)'),
  ('1310', 'Anticipos a proveedores', 'asset', null, 'Dinero entregado antes de recibir'),
  ('1405', 'Inventarios', 'asset', null, 'Existencias valoradas a costo promedio (ADR-0008)'),
  ('1505', 'Propiedad, planta y equipo', 'asset', null, 'Galpones, equipos y herramientas'),
  ('1590', 'Activos fijos no depreciados', 'asset', null, 'Bienes sin depreciar todavía'),

  -- Pasivo.
  ('2105', 'Cuentas por pagar', 'liability', null, 'Saldo que se le debe a proveedores'),
  ('2205', 'Impuestos por pagar', 'liability', null, 'Retenciones e impuestos, cuando apliquen'),
  ('2240', 'Aportes pendientes', 'liability', null, 'Aportes acordados y no entregados'),

  -- Patrimonio.
  ('3105', 'Capital social', 'equity', null, 'Aportes de los socios'),
  ('3110', 'Utilidad del ejercicio', 'equity', null, 'Resultado del periodo en curso'),
  ('3120', 'Utilidad retenida', 'equity', null, 'Resultados de periodos anteriores'),
  ('3130', 'Ajustes de capital', 'equity', null, 'Aportes y retiros extraordinarios'),

  -- Ingreso.
  ('4105', 'Ventas de productos', 'income', null, 'Ingreso por venta de huevos, carne y subproductos'),
  ('4110', 'Otros ingresos', 'income', null, 'Renta, subsidios y otros ingresos no operativos'),
  ('4190', 'Ajustes de ingresos', 'income', null, 'Devoluciones, descuentos y anulaciones'),

  -- Gasto y costo.
  --
  -- "Sanidad" es el nombre que usa la contabilidad colombiana para los costos de
  -- salud animal, y agrupa vacunas, medicamentos y veterinario en una sola
  -- cuenta: separarlos obliga al contador a decidir en cada registro en cuál
  -- va, y el resultado depende de quién registró.
  ('5105', 'Costo de productos vendidos', 'expense', null, 'Costo de lo vendido, a costo promedio'),
  ('5205', 'Alimento', 'expense', null, 'Consumo de alimento de lotes y cerdos'),
  ('5210', 'Agua', 'expense', null, 'Consumo de agua'),
  ('5220', 'Sanidad', 'expense', null, 'Medicamentos, vacunas y veterinario'),
  ('5230', 'Mano de obra directa', 'expense', null, 'Salarios del personal de campo'),
  ('5290', 'Otros costos directos', 'expense', null, 'Costos directos no clasificados antes'),
  ('5305', 'Gastos de administración', 'expense', null, 'Papelería, contabilidad y servicios'),
  ('5310', 'Gastos de venta', 'expense', null, 'Transporte y comercialización'),
  ('5320', 'Depreciación', 'expense', null, 'Depreciación de activos fijos'),
  ('5390', 'Gastos financieros', 'expense', null, 'Intereses y comisiones bancarias')
on conflict (code) do update
  set name = excluded.name,
      type = excluded.type,
      parent_template_code = excluded.parent_template_code,
      description = excluded.description;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Lo que este seed NO inserta, y por qué
--
-- `core.reference_parameters`: no lleva filas. Su CHECK obliga a que un
-- parámetro tenga valor (`reference_parameters_has_value`), y sus valores son
-- datos de la granja: el precio del alimento, el rendimiento del lote, el
-- precio del agua. Sembrarlos sería inventar exactamente lo que ADR-0011
-- prohíbe, y un "18.000 COP" en el seed termina en el reporte de una granja que
-- nunca lo pagó.
--
-- La app los da de alta con `data_kind` explícito (`measured`, `historical`,
-- `reference`, `planned`, `configured`) en cuanto el usuario conoce el valor. La
-- columna `data_kind` es el contrato que el documento declara parte de la v1.
--
-- Unidades de negocio, clientes y proveedores: tampoco. Son de una
-- organización concreta y una granja real tiene las suyas. El modelo de
-- unidades de negocio se crea en el alta de la organización con el nombre que
-- el usuario escribe.
-- ─────────────────────────────────────────────────────────────────────────────
