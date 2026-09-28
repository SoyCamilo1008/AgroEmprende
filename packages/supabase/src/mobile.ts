/**
 * Cliente Supabase para la app móvil.
 *
 * A diferencia de la web, el móvil guarda la sesión en el almacén seguro del
 * dispositivo (Keychain en iOS, Keystore en Android) porque no hay cookies de
 * navegador. La sesión se refresca al volver a primer plano.
 */
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { parseSupabasePublicEnv } from './env';

let cached: SupabaseClient | null = null;

export const createClient = (): SupabaseClient => {
  if (cached) return cached;
  const env = parseSupabasePublicEnv({
    url: process.env.EXPO_PUBLIC_SUPABASE_URL,
    anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  });
  cached = createSupabaseClient(env.url, env.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      // supabase-js detecta el almacenamiento de React Native. Para usar
      // expo-secure-store, se pasa un adaptador en apps/mobile/src/lib/storage.
    },
  });
  return cached;
};
