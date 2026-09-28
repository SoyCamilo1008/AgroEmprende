/**
 * Cliente Supabase para el navegador (componentes cliente de apps/web).
 *
 * La sesión se mantiene en cookies por `@supabase/ssr` para que el servidor
 * también pueda leerla. Este cliente se usa para consultas desde el cliente y
 * para Realtime; las ESCRITURAS de negocio pasan por funciones RPC, nunca por
 * `insert()` directo (ver docs/architecture/rls.md).
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
