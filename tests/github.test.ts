import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { dominantAuthor, parseWebhook, verifySignature } from '@/lib/github'

describe('verifySignature', () => {
  // Vector de prueba oficial de las docs de GitHub.
  const SECRET = "It's a Secret to Everybody"
  const BODY = 'Hello, World!'
  const EXPECTED =
    'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'

  it('acepta el vector de prueba oficial de GitHub', () => {
    expect(verifySignature(BODY, EXPECTED, SECRET)).toBe(true)
  })

  it('rechaza una firma de otro secreto', () => {
    const wrong =
      'sha256=' + createHmac('sha256', 'otro secreto').update(BODY).digest('hex')
    expect(verifySignature(BODY, wrong, SECRET)).toBe(false)
  })

  it('rechaza un cuerpo alterado con firma valida del original', () => {
    expect(verifySignature('Hello, World?', EXPECTED, SECRET)).toBe(false)
  })

  it('rechaza cabecera ausente, vacia o de longitud distinta', () => {
    expect(verifySignature(BODY, null, SECRET)).toBe(false)
    expect(verifySignature(BODY, '', SECRET)).toBe(false)
    expect(verifySignature(BODY, 'sha256=abc', SECRET)).toBe(false)
  })

  it('rechaza si no hay secreto configurado', () => {
    expect(verifySignature(BODY, EXPECTED, '')).toBe(false)
  })
})

describe('dominantAuthor', () => {
  const c = (email: string, distinct = true) => ({ author: { email }, distinct })

  it('atribuye al autor mayoritario', () => {
    const r = dominantAuthor([c('ana@e.com'), c('ana@e.com'), c('luis@e.com')])
    expect(r).toEqual({ email: 'ana@e.com', mixed: true })
  })

  it('marca mixed=false cuando hay un solo autor', () => {
    expect(dominantAuthor([c('ana@e.com'), c('ana@e.com')])).toEqual({
      email: 'ana@e.com',
      mixed: false,
    })
  })

  it('normaliza mayusculas y espacios', () => {
    expect(dominantAuthor([c('  Ana@E.com ')]).email).toBe('ana@e.com')
  })

  it('ignora los commits no distinct, que ya llegaron en otro push', () => {
    const r = dominantAuthor([c('ana@e.com', false), c('luis@e.com', true)])
    expect(r.email).toBe('luis@e.com')
  })

  it('devuelve null sin commits o sin emails validos', () => {
    expect(dominantAuthor([]).email).toBeNull()
    expect(dominantAuthor(undefined).email).toBeNull()
    expect(dominantAuthor([{ author: { email: 'no-es-email' } }]).email).toBeNull()
  })
})

const repo = { full_name: 'empresa/app', pushed_at: 1790000000 }
const sender = { login: 'cuenta-compartida' }

describe('parseWebhook: push', () => {
  it('atribuye por email de commit, no por la cuenta que empuja', () => {
    const rows = parseWebhook(
      'push',
      {
        repository: repo,
        sender,
        ref: 'refs/heads/main',
        after: 'abc123',
        commits: [
          { author: { email: 'ana@empresa.com' }, distinct: true },
          { author: { email: 'ana@empresa.com' }, distinct: true },
        ],
      },
      'delivery-1',
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'push',
      repo: 'empresa/app',
      // La cuenta compartida se guarda, pero no es la clave de atribucion.
      actor_login: 'cuenta-compartida',
      author_email: 'ana@empresa.com',
      commit_count: 2,
      ref: 'refs/heads/main',
    })
  })

  it('usa repository.pushed_at como hora del push', () => {
    const rows = parseWebhook(
      'push',
      { repository: repo, sender, commits: [], after: 'x' },
      'd',
    )
    expect(rows[0]!.occurred_at).toBe(new Date(1790000000 * 1000).toISOString())
  })

  it('cae a head_commit.timestamp si no hay pushed_at', () => {
    const rows = parseWebhook(
      'push',
      {
        repository: { full_name: 'empresa/app' },
        sender,
        after: 'x',
        head_commit: { timestamp: '2026-09-20T08:00:00Z' },
        commits: [],
      },
      'd',
    )
    expect(rows[0]!.occurred_at).toBe('2026-09-20T08:00:00.000Z')
  })

  it('distingue force push y marca autores mezclados', () => {
    const rows = parseWebhook(
      'push',
      {
        repository: repo,
        sender,
        after: 'x',
        forced: true,
        commits: [
          { author: { email: 'ana@e.com' }, distinct: true },
          { author: { email: 'luis@e.com' }, distinct: true },
        ],
      },
      'd',
    )
    expect(rows[0]!.kind).toBe('force_push')
    expect(rows[0]!.meta).toMatchObject({ mixed_authors: true, forced: true })
  })

  it('no cuenta dos veces los commits no distinct', () => {
    const rows = parseWebhook(
      'push',
      {
        repository: repo,
        sender,
        after: 'x',
        commits: [
          { author: { email: 'ana@e.com' }, distinct: true },
          { author: { email: 'ana@e.com' }, distinct: false },
        ],
      },
      'd',
    )
    expect(rows[0]!.commit_count).toBe(1)
  })
})

describe('parseWebhook: pull_request', () => {
  const pr = {
    number: 42,
    user: { login: 'ana' },
    created_at: '2026-09-20T08:00:00Z',
    additions: 100,
    deletions: 20,
    changed_files: 5,
    commits: 3,
  }

  it('registra la apertura', () => {
    const rows = parseWebhook(
      'pull_request',
      { action: 'opened', repository: repo, sender, pull_request: pr },
      'd',
    )
    expect(rows[0]).toMatchObject({
      kind: 'pr_opened',
      pr_number: 42,
      actor_login: 'ana',
      occurred_at: '2026-09-20T08:00:00.000Z',
    })
  })

  it('un merge es closed con merged=true', () => {
    const rows = parseWebhook(
      'pull_request',
      {
        action: 'closed',
        repository: repo,
        sender,
        pull_request: {
          ...pr,
          merged: true,
          merged_at: '2026-09-22T12:00:00Z',
          merged_by: { login: 'luis' },
        },
      },
      'd',
    )
    expect(rows[0]).toMatchObject({
      kind: 'pr_merged',
      pr_merged_at: '2026-09-22T12:00:00.000Z',
      occurred_at: '2026-09-22T12:00:00.000Z',
      additions: 100,
    })
    expect(rows[0]!.meta).toMatchObject({ merged_by: 'luis' })
  })

  it('distingue cerrado sin merge', () => {
    const rows = parseWebhook(
      'pull_request',
      {
        action: 'closed',
        repository: repo,
        sender,
        pull_request: { ...pr, merged: false, closed_at: '2026-09-21T10:00:00Z' },
      },
      'd',
    )
    expect(rows[0]!.kind).toBe('pr_closed')
  })

  it('ignora las acciones que no interesan', () => {
    for (const action of ['synchronize', 'labeled', 'edited', 'assigned']) {
      const rows = parseWebhook(
        'pull_request',
        { action, repository: repo, sender, pull_request: pr },
        'd',
      )
      expect(rows, action).toHaveLength(0)
    }
  })
})

describe('parseWebhook: review y casos borde', () => {
  it('registra una revision enviada', () => {
    const rows = parseWebhook(
      'pull_request_review',
      {
        action: 'submitted',
        repository: repo,
        sender,
        pull_request: { number: 42 },
        review: {
          id: 9,
          user: { login: 'luis' },
          state: 'APPROVED',
          submitted_at: '2026-09-21T09:00:00Z',
        },
      },
      'd',
    )
    expect(rows[0]).toMatchObject({
      kind: 'review',
      actor_login: 'luis',
      review_state: 'approved',
      pr_number: 42,
      occurred_at: '2026-09-21T09:00:00.000Z',
    })
  })

  it('ignora tipos de evento no solicitados', () => {
    expect(parseWebhook('issues', { repository: repo, sender }, 'd')).toHaveLength(0)
    expect(parseWebhook('star', { repository: repo, sender }, 'd')).toHaveLength(0)
  })

  it('ignora un payload sin repositorio', () => {
    expect(parseWebhook('push', { sender }, 'd')).toHaveLength(0)
  })

  it('genera dedup_key estable para el mismo delivery', () => {
    const payload = { repository: repo, sender, after: 'abc', commits: [] }
    const a = parseWebhook('push', payload, 'delivery-1')[0]!
    const b = parseWebhook('push', payload, 'delivery-1')[0]!
    expect(a.dedup_key).toBe(b.dedup_key)
  })

  it('genera dedup_key distinto para deliveries distintos', () => {
    const payload = { repository: repo, sender, after: 'abc', commits: [] }
    const a = parseWebhook('push', payload, 'delivery-1')[0]!
    const b = parseWebhook('push', payload, 'delivery-2')[0]!
    expect(a.dedup_key).not.toBe(b.dedup_key)
  })

  it('sin delivery_id la clave sale de campos estables, para backfill idempotente', () => {
    const payload = { repository: repo, sender, after: 'abc', commits: [] }
    const a = parseWebhook('push', payload, null)[0]!
    const b = parseWebhook('push', payload, null)[0]!
    expect(a.dedup_key).toBe(b.dedup_key)
    expect(a.dedup_key).toContain('empresa/app')
  })
})
