/**
 * Rutas del panel que escriben: el acceso y el borrado de los datos demo.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

let failures = 0
let dbBroken = false
let rpcError: string | null = null
const inserted: unknown[] = []
const rpcs: string[] = []

vi.mock('@/lib/db', () => ({
  db: () => {
    // Simula el primer despliegue, antes de pegar la clave de servicio.
    if (dbBroken) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY')
    return {
      from: () => {
        const q: Record<string, unknown> = {}
        Object.assign(q, {
          select: () => q,
          eq: () => q,
          gte: () => Promise.resolve({ count: failures, error: null }),
          insert: (row: unknown) => {
            inserted.push(row)
            return Promise.resolve({ error: null })
          },
        })
        return q
      },
      rpc: (name: string) => {
        rpcs.push(name)
        return Promise.resolve({
          data: rpcError ? null : { people: 4 },
          error: rpcError ? { message: rpcError } : null,
        })
      },
    }
  },
}))

const refreshSnapshot = vi.fn(() => Promise.resolve())
vi.mock('@/lib/live', () => ({ refreshSnapshot }))

const { POST: login } = await import('@/app/api/login/route')
const { POST: clearDemo } = await import('@/app/api/demo/clear/route')

beforeEach(() => {
  failures = 0
  dbBroken = false
  rpcError = null
  inserted.length = 0
  rpcs.length = 0
  refreshSnapshot.mockClear()
  process.env.DASHBOARD_PASSWORD = 'contrasena-larga-de-prueba'
  process.env.SESSION_SECRET = 'secreto-de-prueba'
})

function loginRequest(password: string): Request {
  return new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'x-real-ip': '203.0.113.7' },
    body: new URLSearchParams({ password }),
  })
}

describe('POST /api/login', () => {
  it('con la contrasena correcta abre una sesion firmada', async () => {
    const res = await login(loginRequest('contrasena-larga-de-prueba'))
    // 303: tras un POST, el navegador pide la pagina con GET.
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('http://localhost/')
    expect(res.headers.get('set-cookie')).toMatch(/medicion_sesion=v2\.\d+\.[0-9a-f]{64}/)
    expect(inserted).toEqual([expect.objectContaining({ success: true })])
  })

  it('con la incorrecta vuelve al formulario y apunta el fallo, sin la IP', async () => {
    const res = await login(loginRequest('otra'))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('http://localhost/login?error=1')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(inserted).toHaveLength(1)
    expect(JSON.stringify(inserted)).not.toContain('203.0.113.7')
  })

  it('tras 10 fallos bloquea, aunque la contrasena sea la correcta', async () => {
    failures = 10
    const res = await login(loginRequest('contrasena-larga-de-prueba'))
    expect(res.headers.get('location')).toBe('http://localhost/login?error=bloqueado')
    expect(res.headers.get('set-cookie')).toBeNull()
    // Bloqueado no se comprueba nada, asi que tampoco se apunta.
    expect(inserted).toEqual([])
  })

  it('si la base aun no esta configurada, deja entrar con la contrasena correcta', async () => {
    dbBroken = true
    const res = await login(loginRequest('contrasena-larga-de-prueba'))
    expect(res.headers.get('location')).toBe('http://localhost/')
  })

  it('sin contrasena configurada no sirve el panel', async () => {
    delete process.env.DASHBOARD_PASSWORD
    expect((await login(loginRequest(''))).status).toBe(500)
  })
})

function clearRequest(confirm: boolean, origin = 'http://localhost'): Request {
  return new Request('http://localhost/api/demo/clear', {
    method: 'POST',
    headers: { origin },
    body: new URLSearchParams(confirm ? { confirm: 'si' } : {}),
  })
}

describe('POST /api/demo/clear', () => {
  it('sin confirmar no borra nada', async () => {
    const res = await clearDemo(clearRequest(false))
    expect(res.status).toBe(303)
    expect(rpcs).toEqual([])
  })

  it('confirmado, borra y rehace el tablero', async () => {
    const res = await clearDemo(clearRequest(true))
    expect(rpcs).toEqual(['clear_demo_data'])
    expect(refreshSnapshot).toHaveBeenCalledTimes(1)
    expect(res.headers.get('location')).toBe('http://localhost/salud?demo=borrado')
  })

  it('rechaza un POST desde otro sitio', async () => {
    const res = await clearDemo(clearRequest(true, 'https://otro.example'))
    expect(res.status).toBe(403)
    expect(rpcs).toEqual([])
  })

  it('si la base falla, lo dice en vez de fingir que borro', async () => {
    rpcError = 'permission denied'
    const res = await clearDemo(clearRequest(true))
    expect(res.headers.get('location')).toBe('http://localhost/salud?demo=error')
    expect(refreshSnapshot).not.toHaveBeenCalled()
  })
})
