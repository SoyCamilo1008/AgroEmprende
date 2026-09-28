/**
 * @agroemprende/supabase
 *
 * Fábricas de cliente Supabase. Centralizar el acceso a la base de datos
 * permite cambiar de proveedor (o de versión de SDK) en un solo lugar, en vez
 * de dispersar `createClient` por todas las pantallas.
 *
 * El cliente de SERVIDOR no vive aquí a propósito: depende de `next/headers` y
 * un paquete compartido no debe atarse a un framework concreto. El adaptador de
 * Next.js está en `apps/web/src/lib/supabase/server.ts`.
 */
export { parseSupabasePublicEnv, type SupabasePublicEnv } from './env';
export { createClient as createBrowserClient } from './browser';
export { createClient as createMobileClient } from './mobile';
