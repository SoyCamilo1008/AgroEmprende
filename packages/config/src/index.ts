/**
 * @agroemprende/config
 *
 * Configuraciones compartidas por todos los paquetes y aplicaciones del monorepo.
 * Este archivo existe para que las importaciones de tipos resuelvan en editores
 * que no siguen `exports` de package.json.
 */
export type { DesignTokens } from '../tailwind/index';
export { designTokens } from '../tailwind/index';
