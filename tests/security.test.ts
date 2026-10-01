/**
 * Puerta del panel y del cron.
 *
 * La sesion antes era un SHA-256 de la contrasena: no caducaba y, si se filtraba,
 * permitia probar contrasenas fuera de linea sin limite. Estos tests fijan que la
 * nueva caduca, no se puede alargar ni falsificar, y que cambiar la contrasena o
 * el secreto cierra todas las sesiones.
 */

import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authorizeCron } from '@/lib/jobs'
import {
  SESSION_TTL_SECONDS,
  createSessionToken,
  ipFingerprint,
  isValidSession,
  passwordMatches,
} from '@/lib/session'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const saved = { ...process.env }

beforeEach(() => {
  process.env.DASHBOARD_PASSWORD = 'contrasena-de-prueba'
  process.env.SESSION_SECRET = 'secreto-de-prueba'
  process.env.CRON_SECRET = 'cron-de-prueba'
})

afterEach(() => {
  process.env = { ...saved }
})

describe('sesion firmada', () => {
  it('una sesion recien creada es valida', async () => {
    const token = await createSessionToken(NOW)
    expect(token).toMatch(/^v2\.\d+\.[0-9a-f]{64}$/)
    expect(await isValidSession(token!, NOW)).toBe(true)
  })

  it('caduca a los 30 dias', async () => {
    const token = await createSessionToken(NOW)
    const ttl = SESSION_TTL_SECONDS * 1000
    expect(await isValidSession(token!, NOW + ttl - 60_000)).toBe(true)
    expect(await isValidSession(token!, NOW + ttl + 60_000)).toBe(false)
  })

  it('no se puede alargar la caducidad a mano', async () => {
    const token = await createSessionToken(NOW)
    const [, exp, sig] = token!.split('.')
    const alargada = `v2.${Number(exp) + 10 * 365 * 86400}.${sig}`
    expect(await isValidSession(alargada, NOW)).toBe(false)
  })

  it('una firma manipulada no vale', async () => {
    const token = await createSessionToken(NOW)
    const ultimo = token!.at(-1) === '0' ? '1' : '0'
    expect(await isValidSession(token!.slice(0, -1) + ultimo, NOW)).toBe(false)
  })

  it('la cookie antigua, un hash de la contrasena, ya no vale', async () => {
    const vieja = createHash('sha256')
      .update(`medicion:v1:${process.env.DASHBOARD_PASSWORD}`)
      .digest('hex')
    expect(await isValidSession(vieja, NOW)).toBe(false)
  })

  it('cambiar la contrasena cierra las sesiones abiertas', async () => {
    const token = await createSessionToken(NOW)
    process.env.DASHBOARD_PASSWORD = 'otra-contrasena'
    expect(await isValidSession(token!, NOW)).toBe(false)
  })

  it('cambiar el secreto de sesion tambien', async () => {
    const token = await createSessionToken(NOW)
    process.env.SESSION_SECRET = 'otro-secreto'
    expect(await isValidSession(token!, NOW)).toBe(false)
  })

  it('sin contrasena configurada no hay sesiones', async () => {
    const token = await createSessionToken(NOW)
    delete process.env.DASHBOARD_PASSWORD
    expect(await createSessionToken(NOW)).toBeNull()
    expect(await isValidSession(token!, NOW)).toBe(false)
  })

  it('rechaza valores vacios o con forma rara', async () => {
    for (const raro of [undefined, '', 'v2', 'v2..', 'v2.abc.def', 'v3.1.2', 'v2.1.2.3']) {
      expect(await isValidSession(raro, NOW)).toBe(false)
    }
  })
})

describe('contrasena', () => {
  it('acepta la correcta y rechaza el resto', async () => {
    expect(await passwordMatches('contrasena-de-prueba')).toBe(true)
    expect(await passwordMatches('contrasena-de-prueb')).toBe(false)
    expect(await passwordMatches('')).toBe(false)
  })

  it('sin contrasena configurada no acepta ninguna', async () => {
    delete process.env.DASHBOARD_PASSWORD
    expect(await passwordMatches('')).toBe(false)
  })
})

describe('huella de IP para el limite de intentos', () => {
  it('es estable, distingue IPs y no contiene la IP', async () => {
    const a = await ipFingerprint('203.0.113.7')
    expect(a).toHaveLength(32)
    expect(await ipFingerprint('203.0.113.7')).toBe(a)
    expect(await ipFingerprint('203.0.113.8')).not.toBe(a)
    expect(a).not.toContain('203')
  })
})

describe('authorizeCron', () => {
  const req = (authorization?: string) =>
    new Request('http://localhost/api/cron/daily', {
      headers: authorization ? { authorization } : {},
    })

  it('acepta el secreto correcto', () => {
    expect(authorizeCron(req('Bearer cron-de-prueba'))).toBe(true)
  })

  it('rechaza un secreto incorrecto o ausente', () => {
    expect(authorizeCron(req('Bearer otro'))).toBe(false)
    expect(authorizeCron(req())).toBe(false)
  })

  it('sin secreto configurado lo rechaza TODO', () => {
    // Antes dejaba pasar: cualquiera con la URL podia lanzar la reconciliacion y
    // gastar la cuota de la API de GitHub.
    delete process.env.CRON_SECRET
    expect(authorizeCron(req())).toBe(false)
    expect(authorizeCron(req('Bearer '))).toBe(false)
    expect(authorizeCron(req('Bearer undefined'))).toBe(false)
  })
})
