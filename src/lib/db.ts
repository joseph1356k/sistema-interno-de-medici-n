import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null = null

/**
 * Cliente de Supabase con service role. Solo para codigo de servidor: la clave
 * salta las politicas RLS.
 *
 * Se crea de forma perezosa para que los tests puedan importar los modulos de
 * parseo sin necesidad de variables de entorno.
 */
export function db(): SupabaseClient {
  if (cached) return cached

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}

/** Registra los equipos vistos, para que aparezcan en el panel sin asignar. */
export async function touchDevices(hostnames: string[]): Promise<void> {
  const unique = [...new Set(hostnames)]
  if (unique.length === 0) return

  const now = new Date().toISOString()
  await db()
    .from('devices')
    .upsert(
      unique.map((hostname) => ({ hostname, last_seen: now })),
      { onConflict: 'hostname' },
    )
}
