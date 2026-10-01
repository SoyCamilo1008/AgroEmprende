/**
 * Cliente Supabase para el navegador (componentes cliente de apps/web).
 *
 * La sesión se mantiene en cookies por `@supabase/ssr` para que el servidor
 * también pueda leerla. Este cliente se usa para consultas desde el cliente y
 * para Realtime.
 *
 * Las escrituras van por dos caminos, según lo que toque la operación:
 * - Las que tocan varias tablas o necesitan cálculo (ventas, pagos, gastos,
 *   movimientos de inventario) van por funciones RPC `SECURITY DEFINER`, para que
 *   todo ocurra en la misma transacción.
 * - Las que son de una sola fila (clientes y contactos) van por DML directo
 *   (`insert`/`update`) contra `core`, protegidas por RLS. No necesitan función:
 *   no hay nada que atomicidad ni cálculo que preservar.
 *
 * En los dos casos PostgreSQL es quien autoriza: esto no decide permisos.
 */
import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseSupabasePublicEnv } from './env';

let cached: SupabaseClient | null = null;

export const createClient = (): SupabaseClient => {
  if (cached) return cached;
  const env = parseSupabasePublicEnv({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  cached = createBrowserClient(env.url, env.anonKey);
  return cached;
};
