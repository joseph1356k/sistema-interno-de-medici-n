import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  ipFingerprint,
  passwordMatches,
} from '@/lib/session'

export const runtime = 'nodejs'

/** Fallos permitidos por origen en la ventana antes de bloquear. */
const MAX_FAILURES = 10
const FAILURE_WINDOW_MS = 15 * 60 * 1000

/**
 * IP del cliente. En Vercel `x-real-ip` y `x-forwarded-for` los pone la propia
 * plataforma, que sobrescribe lo que mande el cliente, asi que no se pueden
 * falsear para saltarse el limite.
 */
function clientIp(request: Request): string {
  return (
    request.headers.get('x-real-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'desconocida'
  )
}

/**
 * Cuantos fallos lleva este origen en la ventana. Si la base no responde (por
 * ejemplo, antes de configurar la clave de servicio) devuelve 0: es preferible
 * dejar entrar con la contrasena correcta que dejar a todo el equipo fuera por
 * un fallo de la base. Con una contrasena larga y aleatoria, el limite es una
 * segunda barrera, no la primera.
 */
async function recentFailures(ipHash: string): Promise<number> {
  try {
    const since = new Date(Date.now() - FAILURE_WINDOW_MS).toISOString()
    const { count, error } = await db()
      .from('login_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .eq('success', false)
      .gte('attempted_at', since)
    if (error) return 0
    return count ?? 0
  } catch {
    return 0
  }
}

async function recordAttempt(ipHash: string, success: boolean): Promise<void> {
  try {
    await db().from('login_attempts').insert({ ip_hash: ipHash, success })
  } catch {
    // Sin base configurada no hay donde apuntarlo; el acceso no debe fallar por eso.
  }
}

/** 303: tras un POST, el navegador debe pedir la pagina con GET. */
function redirect(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), 303)
}

export async function POST(request: Request) {
  if (!process.env.DASHBOARD_PASSWORD) {
    return NextResponse.json({ error: 'panel sin configurar' }, { status: 500 })
  }

  const ipHash = await ipFingerprint(clientIp(request))

  // El bloqueo se comprueba ANTES de mirar la contrasena: si no, un atacante
  // seguiria sabiendo si acerto aunque estuviera bloqueado.
  if ((await recentFailures(ipHash)) >= MAX_FAILURES) {
    return redirect(request, '/login?error=bloqueado')
  }

  const form = await request.formData()
  const given = String(form.get('password') ?? '')

  if (!(await passwordMatches(given))) {
    await recordAttempt(ipHash, false)
    return redirect(request, '/login?error=1')
  }

  await recordAttempt(ipHash, true)

  const token = await createSessionToken()
  const response = redirect(request, '/')
  response.cookies.set(SESSION_COOKIE, token!, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
  return response
}
