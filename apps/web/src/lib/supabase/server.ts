/**
 * Cliente Supabase para el SERVIDOR de Next.js (Server Components y Route
 * Handlers).
 *
 * ¿Por qué vive aquí y no en `@agroemprende/supabase`? Porque depende de
 * `next/headers`. Un paquete compartido no debe depender de un framework
 * concreto; de lo contrario la web, el móvil y las Edge Functions quedarían
 * atados a Next.js. El paquete compartido expone `browser`, `mobile` y `env`;
 * este archivo es el adaptador específico de Next.js.
 *
 * Importante: usa la anon key, NO el service role. El servidor web también
 * está sujeto a RLS, y cada consulta se ejecuta con el `auth.uid()` del
 * usuario que llegó en la cookie. Solo las Edge Functions legítimamente usan
 * el service role, y revalidan permisos por su cuenta.
 */
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseSupabasePublicEnv } from '@agroemprende/supabase/env';

export const createClient = async (): Promise<SupabaseClient> => {
  const cookieStore = await cookies();
  const env = parseSupabasePublicEnv({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });

  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (items) => {
        try {
          for (const item of items) {
            cookieStore.set(item.name, item.value, item.options);
          }
        } catch {
          // En Server Components las cookies son de solo lectura y `set` lanza.
          // El middleware refresca la sesión, así que no es un error fatal.
        }
      },
    },
  });
};
