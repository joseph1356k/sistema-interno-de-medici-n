/**
 * Test de integracion de las rutas de ingesta, con la base de datos simulada.
 *
 * Cubre lo que los tests de parseo no pueden: que lo que LLEGA A LA TABLA no
 * contiene contenido. Es la verificacion de extremo a extremo de la promesa de
 * PRIVACY.md.
 */

import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Captura de lo que se habria escrito en cada tabla. */
const written: Record<string, unknown[]> = {}

vi.mock('@/lib/db', () => ({
  db: () => ({
    from: (table: string) => ({
      insert: (rows: unknown[]) => {
        written[table] = [...(written[table] ?? []), ...rows]
        return Promise.resolve({ error: null })
      },
      upsert: (rows: unknown[]) => {
        written[table] = [...(written[table] ?? []), ...rows]
        return Promise.resolve({ error: null, count: rows.length })
      },
    }),
  }),
  touchDevices: () => Promise.resolve(),
}))

const { POST: otlpRoute } = await import('@/app/api/ingest/otlp/route')
const { POST: githubRoute } = await import('@/app/api/ingest/github/route')

const SECRET = 'secreto-de-prueba'
const CANARIO = 'CANARIO_NO_DEBE_LLEGAR_A_LA_BASE'

beforeEach(() => {
  for (const key of Object.keys(written)) delete written[key]
  process.env.INGEST_TOKEN = 'token-valido'
  process.env.GITHUB_WEBHOOK_SECRET = SECRET
})

function otlpRequest(body: unknown, token = 'token-valido'): Request {
  return new Request('http://localhost/api/ingest/otlp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

function githubRequest(
  event: string,
  payload: unknown,
  secret = SECRET,
): Request {
  const body = JSON.stringify(payload)
  const signature =
    'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  return new Request('http://localhost/api/ingest/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': 'delivery-abc',
      'x-hub-signature-256': signature,
    },
    body,
  })
}

const attr = (key: string, value: string | number | boolean) => ({
  key,
  value:
    typeof value === 'number'
      ? { doubleValue: value }
      : typeof value === 'boolean'
        ? { boolValue: value }
        : { stringValue: value },
})

const NANOS = String(Date.parse('2026-09-26T10:00:00Z') * 1e6)

describe('POST /api/ingest/otlp', () => {
  it('rechaza sin token y con token incorrecto', async () => {
    const sinToken = new Request('http://localhost/api/ingest/otlp', {
      method: 'POST',
      body: '{}',
    })
    expect((await otlpRoute(sinToken)).status).toBe(401)
    expect((await otlpRoute(otlpRequest({}, 'malo'))).status).toBe(401)
    expect(written.tool_metrics).toBeUndefined()
  })

  it('guarda metricas validas', async () => {
    const res = await otlpRoute(
      otlpRequest({
        resourceMetrics: [
          {
            resource: {
              attributes: [
                attr('host.name', 'PC-07'),
                attr('service.name', 'claude-code'),
              ],
            },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'claude_code.active_time.total',
                    unit: 's',
                    sum: {
                      dataPoints: [
                        {
                          timeUnixNano: NANOS,
                          asDouble: 900,
                          attributes: [attr('type', 'user')],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ metrics: 1, events: 0 })
    expect(written.tool_metrics).toHaveLength(1)
    expect(written.tool_metrics![0]).toMatchObject({
      hostname: 'pc-07',
      metric: 'claude_code.active_time.total',
      value: 900,
    })
  })

  it('lo que llega a la tabla no contiene contenido, ni siquiera de codex.tool_result', async () => {
    await otlpRoute(
      otlpRequest({
        resourceLogs: [
          {
            resource: {
              attributes: [attr('host.name', 'PC-07'), attr('service.name', 'codex')],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: NANOS,
                    body: { stringValue: `texto libre con ${CANARIO}` },
                    attributes: [
                      attr('event.name', 'codex.tool_result'),
                      attr('arguments', `cat .env ${CANARIO}`),
                      attr('output', `API_KEY=${CANARIO}`),
                      attr('prompt', CANARIO),
                      attr('file_path', `/src/${CANARIO}.ts`),
                      attr('user.email', `${CANARIO}@empresa.com`),
                      attr('success', true),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    )

    const stored = JSON.stringify(written.tool_events ?? [])
    expect(stored).not.toContain(CANARIO)
    expect(written.tool_events).toHaveLength(1)
    // Lo util si se conserva.
    expect(written.tool_events![0]).toMatchObject({
      event_name: 'codex.tool_result',
      attrs: { success: true },
    })
  })

  it('no escribe nada cuando no hay nada reconocible, y responde 200', async () => {
    const res = await otlpRoute(otlpRequest({ resourceMetrics: [] }))
    expect(res.status).toBe(200)
    expect(written.tool_metrics).toBeUndefined()
    expect(written.tool_events).toBeUndefined()
  })

  it('devuelve 400 con json invalido', async () => {
    const bad = new Request('http://localhost/api/ingest/otlp', {
      method: 'POST',
      headers: { authorization: 'Bearer token-valido' },
      body: 'no es json',
    })
    expect((await otlpRoute(bad)).status).toBe(400)
  })
})

describe('POST /api/ingest/github', () => {
  const pushPayload = {
    repository: { full_name: 'empresa/app', pushed_at: 1790000000 },
    sender: { login: 'cuenta-compartida' },
    ref: 'refs/heads/main',
    after: 'abc123',
    commits: [
      {
        author: { email: 'ana@empresa.com' },
        distinct: true,
        // Un mensaje de commit puede contener cualquier cosa: no debe guardarse.
        message: `arregla el bug ${CANARIO}`,
      },
    ],
  }

  it('rechaza una firma invalida', async () => {
    const res = await githubRoute(githubRequest('push', pushPayload, 'otro-secreto'))
    expect(res.status).toBe(401)
    expect(written.git_events).toBeUndefined()
  })

  it('responde al ping sin escribir nada', async () => {
    const res = await githubRoute(githubRequest('ping', { zen: 'hola' }))
    expect(res.status).toBe(200)
    expect(written.git_events).toBeUndefined()
  })

  it('guarda un push atribuido por email de commit', async () => {
    const res = await githubRoute(githubRequest('push', pushPayload))
    expect(res.status).toBe(200)
    expect(written.git_events).toHaveLength(1)
    expect(written.git_events![0]).toMatchObject({
      kind: 'push',
      author_email: 'ana@empresa.com',
      actor_login: 'cuenta-compartida',
      commit_count: 1,
    })
  })

  it('no guarda mensajes de commit', async () => {
    await githubRoute(githubRequest('push', pushPayload))
    expect(JSON.stringify(written.git_events)).not.toContain(CANARIO)
  })

  it('ignora eventos que no interesan', async () => {
    const res = await githubRoute(
      githubRequest('issues', { repository: { full_name: 'empresa/app' } }),
    )
    expect(await res.json()).toMatchObject({ stored: 0 })
    expect(written.git_events).toBeUndefined()
  })

  it('falla en claro si no hay secreto configurado', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET
    const res = await githubRoute(githubRequest('push', pushPayload))
    expect(res.status).toBe(500)
  })
})
