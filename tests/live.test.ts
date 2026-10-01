/**
 * Tablero en vivo: recalculo aplazado y alertas.
 *
 * Lo delicado del aplazamiento es no perder el ultimo evento de una rafaga: si el
 * webhook descartara el recalculo en vez de marcarlo como pendiente, un PR recien
 * mergeado seguiria apareciendo como abierto hasta el siguiente evento.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Datos que devuelve cada tabla o vista en la base simulada. */
const tables: Record<string, unknown> = {}
/** Escrituras registradas: tabla, operacion y valores. */
const writes: { table: string; op: string; values: unknown }[] = []
const rpcs: string[] = []

vi.mock('@/lib/db', () => {
  const from = (table: string) => {
    const result = () => ({ data: tables[table] ?? [], error: null })
    const q: Record<string, unknown> = {}
    const chain = () => q
    Object.assign(q, {
      select: chain,
      eq: chain,
      not: chain,
      order: chain,
      limit: chain,
      gte: chain,
      update: (values: unknown) => {
        writes.push({ table, op: 'update', values })
        return q
      },
      upsert: (values: unknown) => {
        writes.push({ table, op: 'upsert', values })
        return Promise.resolve({ error: null })
      },
      maybeSingle: () =>
        Promise.resolve({ data: tables[table] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(ok, ko),
    })
    return q
  }
  return {
    db: () => ({
      from,
      rpc: (name: string) => {
        rpcs.push(name)
        return Promise.resolve({ data: 1, error: null })
      },
    }),
  }
})

const { computeSnapshot, readSnapshot, requestRefresh, MIN_REFRESH_INTERVAL_MS } =
  await import('@/lib/live')

const NOW = Date.parse('2026-10-01T15:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  writes.length = 0
  rpcs.length = 0
})

describe('requestRefresh', () => {
  it('si el tablero se calculo hace nada, solo lo marca como pendiente', async () => {
    tables.live_snapshot = { computed_at: iso(NOW - 3_000) }

    expect(await requestRefresh(NOW)).toBe('deferred')
    expect(rpcs).toEqual([])
    expect(writes).toEqual([
      { table: 'live_snapshot', op: 'update', values: { dirty_since: iso(NOW) } },
    ])
  })

  it('si el calculo es viejo, recalcula con el dia del equipo', async () => {
    tables.live_snapshot = { computed_at: iso(NOW - MIN_REFRESH_INTERVAL_MS - 1) }

    expect(await requestRefresh(NOW)).toBe('refreshed')
    // "Hoy" lo decide la base, en la zona horaria del equipo.
    expect(rpcs).toEqual(['rollup_today'])
    expect(writes.some((w) => w.table === 'live_snapshot' && w.op === 'upsert')).toBe(true)
  })

  it('sin calculo previo, recalcula', async () => {
    expect(await requestRefresh(NOW)).toBe('refreshed')
  })
})

describe('readSnapshot', () => {
  const payload = { computed_at: iso(NOW), open_prs: 3 }

  it('devuelve la foto si no hay nada pendiente', async () => {
    tables.live_snapshot = { payload, computed_at: iso(NOW), dirty_since: null }
    expect(await readSnapshot()).toEqual(payload)
  })

  it('devuelve null si llego un evento despues de calcularla', async () => {
    tables.live_snapshot = {
      payload,
      computed_at: iso(NOW),
      dirty_since: iso(NOW + 1_000),
    }
    expect(await readSnapshot()).toBeNull()
  })

  it('una marca anterior al calculo ya esta incluida', async () => {
    tables.live_snapshot = {
      payload,
      computed_at: iso(NOW),
      dirty_since: iso(NOW - 1_000),
    }
    expect(await readSnapshot()).toEqual(payload)
  })

  it('una foto vacia es como no tener foto', async () => {
    tables.live_snapshot = { payload: {}, computed_at: iso(NOW), dirty_since: null }
    expect(await readSnapshot()).toBeNull()
  })
})

describe('alertas', () => {
  const atascado = (number: number, author: string) => ({
    repo: 'empresa/app',
    number,
    author_login: author,
    draft: false,
    mergeable_state: 'clean',
    last_review_state: null,
    first_review_at: null,
    requested_reviewers: 1,
    head_sha: `sha${number}`,
    additions: 10,
    deletions: 2,
    created_at: iso(NOW - 200 * 3_600_000),
    ready_at: null,
    event_ts: iso(NOW - 100 * 3_600_000),
  })

  it('un PR de bot sale en el tablero pero no genera alertas', async () => {
    tables.pull_requests = [atascado(1, 'ana'), atascado(2, 'dependabot[bot]')]

    const s = await computeSnapshot(new Date(NOW))

    expect(s.blocked.map((b) => b.number).sort()).toEqual([1, 2])
    expect(s.alerts.some((a) => a.message.includes('#1 '))).toBe(true)
    expect(s.alerts.some((a) => a.message.includes('#2 '))).toBe(false)
  })

  it('computed_at es el instante de inicio del calculo', async () => {
    const s = await computeSnapshot(new Date(NOW))
    expect(s.computed_at).toBe(iso(NOW))
  })
})
