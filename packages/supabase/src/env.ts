/**
 * Configuración pública de Supabase.
 *
 * Estas dos variables son PÚBLICAS por diseño: viajan al navegador y al móvil.
 * No son un secreto SIEMPRE que RLS está activo: la anon key solo permite
 * iniciar sesión, y cada lectura pasa por las políticas de RLS.
 *
 * El service role key NUNCA aparece aquí: vive únicamente en Edge Functions y
 * scripts de servidor, y su presencia en este archivo sería un incidente.
 */
import { z } from 'zod';

const supabaseUrlSchema = z
  .string()
  .url('NEXT_PUBLIC_SUPABASE_URL debe ser una URL válida')
  .refine((value) => value.startsWith('https://'), 'La URL de Supabase debe usar https')
  .refine((value) => !value.includes('service_role'), 'Nunca uses una service role key aquí');

const anonKeySchema = z
  .string()
  .min(20, 'La anon key parece inválida')
  .refine(
    (value) => !value.includes('service_role'),
    'Nunca expongas la service role key al cliente',
  );

export interface SupabasePublicEnv {
  readonly url: string;
  readonly anonKey: string;
}

export const parseSupabasePublicEnv = (input: {
  url?: string | undefined;
  anonKey?: string | undefined;
}): SupabasePublicEnv => {
  const result = z
    .object({ url: supabaseUrlSchema, anonKey: anonKeySchema })
    .safeParse({ url: input.url, anonKey: input.anonKey });

  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(
      `Configuración de Supabase inválida o ausente.\n${detail.join('\n')}\n` +
        'Copia .env.example a .env.local y completa los valores.',
    );
  }
  return result.data;
};
