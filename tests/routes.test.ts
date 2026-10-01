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

/** Filas que la base "ya tiene", para probar la fusion de estado de PR. */
const stored: Record<string, unknown[]> = {}

vi.mock('@/lib/db', () => {
  const table = (name: string) => {
    // Filtros acumulados de .eq(), para que maybeSingle() devuelva la fila justa.
    const filters: Record<string, unknown> = {}

    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters[column] = value
        return query
      },
      maybeSingle: () => {
        const rows = (stored[name] ?? []).filter((row) =>
          Object.entries(filters).every(
            ([k, v]) => (row as Record<string, unknown>)[k] === v,
          ),
        )
        return Promise.resolve({ data: rows[0] ?? null, error: null })
      },
      insert: (rows: unknown[]) => {
        written[name] = [...(written[name] ?? []), ...rows]
        return Promise.resolve({ error: null })
      },
      upsert: (rows: unknown[]) => {
        const list = Array.isArray(rows) ? rows : [rows]
        written[name] = [...(written[name] ?? []), ...list]
        return Promise.resolve({ error: null, count: list.length })
      },
    }
    return query
  }

  return { db: () => ({ from: table }), touchDevices: () => Promise.resolve() }
})

// El refresco del tablero se prueba aparte; aqui solo importa que la ruta lo
// pida cuando toca. Sin este mock, cada test escribia una traza de error al
// intentar refrescar contra la base simulada.
const requestRefresh = vi.fn(() => Promise.resolve('refreshed' as const))
vi.mock('@/lib/live', () => ({ requestRefresh }))

const { POST: otlpRoute } = await import('@/app/api/ingest/otlp/route')
const { POST: githubRoute } = await import('@/app/api/ingest/github/route')

const SECRET = 'secreto-de-prueba'
const CANARIO = 'CANARIO_NO_DEBE_LLEGAR_A_LA_BASE'

beforeEach(() => {
  requestRefresh.mockClear()
  for (const key of Object.keys(written)) delete written[key]
  for (const key of Object.keys(stored)) delete stored[key]
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

// La ruta usa el reloj real: los datos van fechados una hora antes de ahora.
const NANOS = String((Date.now() - 3_600_000) * 1e6)

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
    expect(await res.json()).toMatchObject({ stored: { git_events: 0 } })
    expect(written.git_events).toBeUndefined()
  })

  it('falla en claro si no hay secreto configurado', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET
    const res = await githubRoute(githubRequest('push', pushPayload))
    expect(res.status).toBe(500)
  })
})

describe('webhooks de estado: PR, CI, revisiones y despliegues', () => {
  const repo = { full_name: 'empresa/app' }

  it('guarda el estado de un PR abierto', async () => {
    await githubRoute(
      githubRequest('pull_request', {
        action: 'opened',
        repository: repo,
        sender: { login: 'ana' },
        pull_request: {
          number: 10,
          state: 'open',
          draft: false,
          user: { login: 'ana' },
          head: { sha: 'abc' },
          base: { ref: 'main' },
          created_at: '2026-09-20T09:00:00Z',
          updated_at: '2026-09-20T09:00:00Z',
          requested_reviewers: [{ login: 'luis' }],
          additions: 50,
          deletions: 5,
          changed_files: 2,
        },
      }),
    )

    expect(written.pull_requests).toHaveLength(1)
    expect(written.pull_requests![0]).toMatchObject({
      repo: 'empresa/app',
      number: 10,
      state: 'open',
      author_login: 'ana',
      head_sha: 'abc',
      requested_reviewers: 1,
      ready_at: '2026-09-20T09:00:00.000Z',
    })
  })

  it('fusiona sobre el estado que ya habia en la base', async () => {
    stored.pull_requests = [
      {
        repo: 'empresa/app',
        number: 10,
        state: 'open',
        draft: false,
        author_login: 'ana',
        head_sha: 'abc',
        mergeable_state: 'clean',
        additions: 50,
        created_at: '2026-09-20T09:00:00Z',
        first_review_at: null,
        approved_at: null,
        merged_at: null,
        closed_at: null,
        ready_at: '2026-09-20T09:00:00Z',
        base_ref: 'main',
        deletions: 5,
        changed_files: 2,
        commits: 1,
        mergeable: true,
        requested_reviewers: 1,
        last_review_state: null,
        event_ts: '2026-09-20T09:00:00Z',
      },
    ]

    await githubRoute(
      githubRequest('pull_request', {
        action: 'closed',
        repository: repo,
        sender: { login: 'ana' },
        pull_request: {
          number: 10,
          state: 'closed',
          merged: true,
          user: { login: 'ana' },
          created_at: '2026-09-20T09:00:00Z',
          updated_at: '2026-09-22T16:00:00Z',
          merged_at: '2026-09-22T16:00:00Z',
          // GitHub manda estos nulos a menudo; no deben borrar lo que ya habia.
          mergeable_state: null,
          additions: null,
        },
      }),
    )

    const row = written.pull_requests![0] as Record<string, unknown>
    expect(row).toMatchObject({
      state: 'merged',
      merged_at: '2026-09-22T16:00:00.000Z',
      // Conservados del estado anterior pese a llegar nulos.
      mergeable_state: 'clean',
      additions: 50,
      ready_at: '2026-09-20T09:00:00Z',
    })
  })

  it('guarda una revision y actualiza el veredicto del PR', async () => {
    await githubRoute(
      githubRequest('pull_request_review', {
        action: 'submitted',
        repository: repo,
        sender: { login: 'luis' },
        pull_request: { number: 10, user: { login: 'ana' } },
        review: {
          id: 555,
          user: { login: 'luis' },
          state: 'APPROVED',
          submitted_at: '2026-09-21T10:00:00Z',
        },
      }),
    )

    expect(written.reviews![0]).toMatchObject({
      repo: 'empresa/app',
      pr_number: 10,
      reviewer_login: 'luis',
      pr_author_login: 'ana',
      state: 'approved',
      external_id: '555',
    })
    expect(written.pull_requests![0]).toMatchObject({
      last_review_state: 'approved',
      first_review_at: '2026-09-21T10:00:00.000Z',
      approved_at: '2026-09-21T10:00:00.000Z',
    })
  })

  it('un comentario suelto no cambia el veredicto del PR', async () => {
    await githubRoute(
      githubRequest('pull_request_review', {
        action: 'submitted',
        repository: repo,
        sender: { login: 'luis' },
        pull_request: { number: 10, user: { login: 'ana' } },
        review: {
          id: 556,
          user: { login: 'luis' },
          state: 'COMMENTED',
          submitted_at: '2026-09-21T11:00:00Z',
        },
      }),
    )

    // Si un comentario contase como veredicto, el PR cambiaria de columna en el
    // tablero sin que nadie haya decidido nada.
    expect(written.pull_requests![0]).toMatchObject({ last_review_state: null })
    // Pero si cuenta como primera revision: alguien ya lo miro.
    expect(written.pull_requests![0]).toMatchObject({
      first_review_at: '2026-09-21T11:00:00.000Z',
    })
  })

  it('la revision de un bot se guarda pero no cuenta como primera revision', async () => {
    await githubRoute(
      githubRequest('pull_request_review', {
        action: 'submitted',
        repository: repo,
        sender: { login: 'coderabbitai[bot]' },
        pull_request: { number: 12, user: { login: 'ana' }, state: 'open' },
        review: {
          id: 557,
          user: { login: 'coderabbitai[bot]' },
          state: 'COMMENTED',
          submitted_at: '2026-09-21T10:00:30Z',
        },
      }),
    )

    expect(written.reviews![0]).toMatchObject({ reviewer_login: 'coderabbitai[bot]' })
    // Una sola escritura por PR aunque el evento traiga dos parches.
    expect(written.pull_requests).toHaveLength(1)
    expect(written.pull_requests![0]).toMatchObject({ first_review_at: null })
  })

  it('guarda los despliegues fallidos con su estado', async () => {
    await githubRoute(
      githubRequest('deployment_status', {
        repository: repo,
        sender: { login: 'vercel[bot]' },
        deployment: { id: 31, environment: 'Production', sha: 'abc', ref: 'main' },
        deployment_status: { state: 'failure', created_at: '2026-09-21T10:00:00Z' },
      }),
    )

    expect(written.deployments![0]).toMatchObject({ status: 'failure', sha: 'abc' })
  })

  it('guarda CI indexado por head_sha, no por el PR', async () => {
    await githubRoute(
      githubRequest('check_suite', {
        action: 'completed',
        repository: repo,
        sender: { login: 'github' },
        check_suite: {
          id: 900,
          head_sha: 'abc',
          // Nulo en pushes a forks: no debe impedir que se guarde.
          head_branch: null,
          status: 'completed',
          conclusion: 'failure',
          app: { name: 'GitHub Actions' },
          created_at: '2026-09-21T09:00:00Z',
          updated_at: '2026-09-21T09:06:00Z',
        },
      }),
    )

    expect(written.ci_runs![0]).toMatchObject({
      head_sha: 'abc',
      provider: 'check_suite',
      conclusion: 'failure',
      branch: null,
      duration_seconds: 360,
    })
  })

  it('acepta una conclusion que no esta en el esquema publicado', async () => {
    // GitHub emite `startup_failure`, que su propio esquema no documenta. Un enum
    // aqui rechazaria datos reales.
    await githubRoute(
      githubRequest('workflow_run', {
        action: 'completed',
        repository: repo,
        sender: { login: 'github' },
        workflow_run: {
          id: 1,
          name: 'CI',
          head_sha: 'abc',
          head_branch: 'main',
          status: 'completed',
          conclusion: 'startup_failure',
          run_attempt: 2,
          event: 'push',
          run_started_at: '2026-09-21T09:00:00Z',
          updated_at: '2026-09-21T09:01:00Z',
        },
      }),
    )

    expect(written.ci_runs![0]).toMatchObject({
      conclusion: 'startup_failure',
      attempt: 2,
      provider: 'workflow_run',
    })
  })

  it('registra un despliegue desde una release publicada', async () => {
    await githubRoute(
      githubRequest('release', {
        action: 'published',
        repository: repo,
        sender: { login: 'ana' },
        release: {
          id: 77,
          tag_name: 'v1.2.0',
          draft: false,
          prerelease: false,
          published_at: '2026-09-22T18:00:00Z',
        },
      }),
    )

    expect(written.deployments![0]).toMatchObject({
      repo: 'empresa/app',
      ref: 'v1.2.0',
      environment: 'production',
      source: 'release',
    })
  })

  it('ignora una release en borrador', async () => {
    await githubRoute(
      githubRequest('release', {
        action: 'published',
        repository: repo,
        sender: { login: 'ana' },
        release: { id: 78, tag_name: 'v9', draft: true, published_at: '2026-09-22T18:00:00Z' },
      }),
    )
    expect(written.deployments).toBeUndefined()
  })

  it('no guarda rutas de archivo sin sal configurada', async () => {
    delete process.env.FILE_HASH_SALT
    await githubRoute(
      githubRequest('push', {
        repository: { ...repo, pushed_at: 1790000000 },
        sender: { login: 'ana' },
        after: 'abc',
        commits: [
          {
            id: 'c1',
            distinct: true,
            timestamp: '2026-09-20T09:00:00Z',
            author: { email: 'ana@e.com' },
            modified: ['src/secreto.ts'],
          },
        ],
      }),
    )
    expect(written.commit_files).toBeUndefined()
  })

  it('con sal, guarda el hash y nunca la ruta', async () => {
    process.env.FILE_HASH_SALT = 'sal-de-prueba'
    await githubRoute(
      githubRequest('push', {
        repository: { ...repo, pushed_at: 1790000000 },
        sender: { login: 'ana' },
        after: 'abc',
        commits: [
          {
            id: 'c1',
            distinct: true,
            timestamp: '2026-09-20T09:00:00Z',
            author: { email: 'ana@e.com' },
            modified: ['src/rutas/muy/reveladoras.ts'],
          },
        ],
      }),
    )

    const serialized = JSON.stringify(written.commit_files)
    expect(written.commit_files).toHaveLength(1)
    expect(serialized).not.toContain('reveladoras')
    expect(serialized).not.toContain('src/')
    expect(written.commit_files![0]).toMatchObject({ change_type: 'modified' })
    delete process.env.FILE_HASH_SALT
  })
})

describe('POST /api/ingest/otlp: idempotencia y limites', () => {
  const lote = () => ({
    resourceMetrics: [
      {
        resource: {
          attributes: [attr('host.name', 'pc-01'), attr('service.name', 'claude-code')],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.active_time.total',
                sum: { dataPoints: [{ timeUnixNano: NANOS, asDouble: 60 }] },
              },
            ],
          },
        ],
      },
    ],
  })

  it('escribe con clave de deduplicacion, para que un reintento no sume dos veces', async () => {
    await otlpRoute(otlpRequest(lote()))
    await otlpRoute(otlpRequest(lote()))

    const rows = written.tool_metrics as { dedup_key: string }[]
    expect(rows).toHaveLength(2) // el mock no deduplica: registra lo que se envio
    // ...pero las dos filas llevan la misma clave, y en la base real el upsert con
    // ignoreDuplicates descarta la segunda.
    expect(rows[0]!.dedup_key).toBe(rows[1]!.dedup_key)
  })

  it('rechaza un lote mayor del limite por la cabecera', async () => {
    const req = new Request('http://localhost/api/ingest/otlp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token-valido',
        'content-length': String(10 * 1024 * 1024),
      },
      body: '{}',
    })
    expect((await otlpRoute(req)).status).toBe(413)
  })

  it('rechaza un lote mayor del limite aunque la cabecera mienta', async () => {
    const enorme = JSON.stringify({ relleno: 'x'.repeat(6 * 1024 * 1024) })
    const req = new Request('http://localhost/api/ingest/otlp', {
      method: 'POST',
      headers: { authorization: 'Bearer token-valido', 'content-length': '10' },
      body: enorme,
    })
    expect((await otlpRoute(req)).status).toBe(413)
    expect(written.tool_metrics).toBeUndefined()
  })
})

describe('el webhook refresca el tablero solo cuando hace falta', () => {
  it('lo refresca tras un evento de PR', async () => {
    await githubRoute(
      githubRequest('pull_request', {
        action: 'opened',
        repository: { full_name: 'empresa/app' },
        sender: { login: 'ana' },
        pull_request: {
          number: 77,
          state: 'open',
          user: { login: 'ana' },
          created_at: '2026-09-20T09:00:00Z',
          updated_at: '2026-09-20T09:00:00Z',
        },
      }),
    )
    expect(requestRefresh).toHaveBeenCalledTimes(1)
  })

  it('no lo refresca tras un push, que no cambia ningun PR abierto', async () => {
    await githubRoute(
      githubRequest('push', {
        repository: { full_name: 'empresa/app', pushed_at: 1790000000 },
        sender: { login: 'ana' },
        ref: 'refs/heads/main',
        after: 'abc',
        commits: [],
      }),
    )
    expect(requestRefresh).not.toHaveBeenCalled()
  })
})
