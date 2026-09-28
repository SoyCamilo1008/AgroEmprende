/**
 * Roles y permisos.
 *
 * La BASE DE DATOS es la autoridad. Estos códigos son la fuente de verdad que
 * se carga en `core.permissions` y se asocian a `core.roles` en el seed.
 *
 * La UI oculta botones por permisos (UX), pero la seguridad real está en RLS y
 * en `private.assert_permission()` dentro de las funciones SQL. Ver
 * docs/architecture/rls.md.
 */

export const ROLES = ['owner', 'admin', 'manager', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // Organización y configuración
  'org.read',
  'org.update',
  'org.members.manage',
  'business_units.manage',
  'settings.manage',
  'audit.read',

  // Catálogo
  'customers.read',
  'customers.write',
  'suppliers.read',
  'suppliers.write',
  'products.read',
  'products.write',
  'prices.write',

  // Finanzas
  'finance.read',
  'finance.dashboard',
  'finance.sales.read',
  'finance.sales.create',
  'finance.sales.void',
  'finance.payments.read',
  'finance.payments.create',
  'finance.receivables.read',
  'finance.receivables.manage',
  'finance.expenses.read',
  'finance.expenses.create',
  'finance.investments.read',
  'finance.investments.create',
  'finance.reinvestments.read',
  'finance.reinvestments.create',
  'finance.cashflow.read',
  'finance.profit.read', // utilidad consolidada: no la ve un operator
  'finance.ledger.manage', // asientos manuales / void

  // Inventarios
  'inventory.read',
  'inventory.purchases.create',
  'inventory.movements.read',
  'inventory.adjust',

  // Ponedoras
  'poultry.read',
  'poultry.flocks.manage',
  'poultry.production.create',
  'poultry.feed.record',
  'poultry.water.record',
  'poultry.health.record',
  'poultry.disposals.record',

  // Cerdos
  'swine.read',
  'swine.pigs.manage',
  'swine.weights.record',
  'swine.feed.record',
  'swine.water.record',
  'swine.health.record',
  'swine.slaughters.record',
  'swine.cuts.record',
  'swine.cycles.manage',
  'swine.cycles.close',

  // AgroIA
  'ai.chat',
  'ai.actions.propose',
  'ai.actions.execute',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface RoleDefinition {
  readonly code: Role;
  readonly name: string;
  readonly description: string;
  readonly rank: number;
  readonly isSystem: boolean;
}
