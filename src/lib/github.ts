/**
 * Webhook de GitHub: verificacion de firma y traduccion a filas de git_events.
 *
 * Atribucion con cuentas compartidas: en el payload de `push`, `pusher` y
 * `sender` son la cuenta comun, pero `commits[].author.email` viene del git
 * local de cada maquina. Ese email es la clave real, y no requiere instalar
 * nada en los PCs: basta `git config --global user.email`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export type GitEventKind =
  | 'push'
  | 'force_push'
  | 'pr_opened'
  | 'pr_merged'
  | 'pr_closed'
  | 'review'

export interface GitEventRow {
  dedup_key: string
  delivery_id: string | null
  kind: GitEventKind
  repo: string
  actor_login: string | null
  author_email: string | null
  ref: string | null
  commit_count: number | null
  pr_number: number | null
  pr_created_at: string | null
  pr_merged_at: string | null
  first_review_at: string | null
  additions: number | null
  deletions: number | null
  changed_files: number | null
  review_state: string | null
  meta: Record<string, unknown>
  occurred_at: string
}

/**
 * Verifica X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secreto, cuerpo crudo).
 * La comparacion es en tiempo constante. Hay un vector de prueba oficial en las
 * docs de GitHub; la suite de tests lo usa.
 *
 * IMPORTANTE: `rawBody` tiene que ser el cuerpo tal como llego. Si se hace
 * JSON.parse y luego JSON.stringify, la firma no coincide.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false

  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // timingSafeEqual exige la misma longitud; distinta longitud es invalida.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

interface Commit {
  author?: { email?: string; name?: string; username?: string }
  distinct?: boolean
}

/**
 * Email del autor mayoritario de un push. Lo normal es un push = un autor; si
 * viene mezclado (merge de ramas de varios), se elige el mayoritario y se marca
 * en `meta.mixed_authors` para que el dato no se lea como si fuera limpio.
 *
 * Solo se cuentan los commits `distinct`: los que ya llegaron en un push
 * anterior (merges, rebases) volverian a contarse si no.
 */
export function dominantAuthor(commits: Commit[] | undefined): {
  email: string | null
  mixed: boolean
} {
  if (!Array.isArray(commits) || commits.length === 0) {
    return { email: null, mixed: false }
  }

  const tally = new Map<string, number>()
  for (const c of commits) {
    if (c?.distinct === false) continue
    const email = c?.author?.email
    if (typeof email !== 'string' || !email.includes('@')) continue
    const key = email.trim().toLowerCase()
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }

  if (tally.size === 0) return { email: null, mixed: false }

  let best: string | null = null
  let bestCount = 0
  for (const [email, count] of tally) {
    if (count > bestCount) {
      best = email
      bestCount = count
    }
  }

  return { email: best, mixed: tally.size > 1 }
}

function isoOrNull(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // `repository.pushed_at` llega como epoch en segundos en los eventos push.
    return new Date(v * 1000).toISOString()
  }
  if (typeof v !== 'string' || v.length === 0) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null
}

/**
 * Identidad de un push: repositorio + rama + sha resultante.
 *
 * Es la MISMA clave para el webhook y para la reconciliacion, y eso es lo
 * importante. Antes cada via usaba la suya (el id de entrega en un caso, el id de
 * actividad en el otro), asi que un mismo push que llegaba por las dos se contaba
 * dos veces, y la reconciliacion diaria repasa la ultima semana entera: cada push
 * acababa duplicado.
 *
 * La rama entra en la clave porque empujar el mismo commit a dos ramas son dos
 * push distintos.
 */
export function pushKey(repo: string, ref: string | null, afterSha: string): string {
  return `push:${repo}:${ref ?? ''}:${afterSha}`
}

/** Un login de bot de GitHub (dependabot[bot], github-actions[bot]...). */
export function isBotLogin(login: string | null | undefined): boolean {
  return typeof login === 'string' && login.endsWith('[bot]')
}

/**
 * Traduce un payload de webhook a cero o mas filas. Devuelve [] para eventos que
 * no interesan, en vez de lanzar: el webhook de organizacion puede recibir tipos
 * que no pedimos.
 */
export function parseWebhook(
  eventType: string,
  payload: Record<string, unknown>,
  deliveryId: string | null,
  receivedAt: Date = new Date(),
): GitEventRow[] {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name
  if (typeof repo !== 'string') return []

  const sender = (payload.sender as { login?: string } | undefined)?.login ?? null

  // Con delivery_id la clave es el propio delivery mas el discriminante del
  // evento. Sin el (backfill por API), se construye de campos estables del
  // evento, para que reejecutar el backfill no duplique filas.
  const keyFor = (kind: string, discriminator: string): string =>
    deliveryId
      ? `d:${deliveryId}:${kind}:${discriminator}`
      : `b:${repo}:${kind}:${discriminator}`

  const base = {
    delivery_id: deliveryId,
    repo,
    actor_login: sender,
    author_email: null as string | null,
    ref: null as string | null,
    commit_count: null as number | null,
    pr_number: null as number | null,
    pr_created_at: null as string | null,
    pr_merged_at: null as string | null,
    first_review_at: null as string | null,
    additions: null as number | null,
    deletions: null as number | null,
    changed_files: null as number | null,
    review_state: null as string | null,
  }

  if (eventType === 'push') {
    // Borrar una rama tambien llega como push, sin commits. No es trabajo, y
    // contarlo inflaria los push de quien limpia ramas viejas.
    if (payload.deleted === true) return []

    const commits = payload.commits as Commit[] | undefined
    const { email, mixed } = dominantAuthor(commits)
    const forced = payload.forced === true
    const repoObj = payload.repository as { pushed_at?: unknown } | undefined
    const head = payload.head_commit as { timestamp?: unknown } | undefined

    // Prioridad para la hora del push: `repository.pushed_at` es el momento del
    // push; `head_commit.timestamp` es el momento del commit (puede ser muy
    // anterior). La hora de recepcion es el ultimo recurso.
    const occurredAt =
      isoOrNull(repoObj?.pushed_at) ??
      isoOrNull(head?.timestamp) ??
      receivedAt.toISOString()

    const ref = typeof payload.ref === 'string' ? payload.ref : null
    const after = typeof payload.after === 'string' ? payload.after : null

    return [
      {
        ...base,
        // Sin sha no hay identidad estable: se cae a la clave por entrega, que al
        // menos absorbe los reenvios.
        dedup_key: after
          ? pushKey(repo, ref, after)
          : keyFor(forced ? 'force_push' : 'push', ref ?? ''),
        kind: forced ? 'force_push' : 'push',
        author_email: email,
        ref,
        commit_count: Array.isArray(commits)
          ? commits.filter((c) => c?.distinct !== false).length
          : 0,
        meta: {
          mixed_authors: mixed,
          created: payload.created === true,
          forced,
          bot: isBotLogin(sender),
          // `commits[]` se corta en 2048; si llega al tope, el conteo es un piso.
          commits_truncated: Array.isArray(commits) && commits.length >= 2048,
        },
        occurred_at: occurredAt,
      },
    ]
  }

  if (eventType === 'pull_request') {
    const action = payload.action
    const pr = payload.pull_request as Record<string, unknown> | undefined
    if (!pr) return []

    const merged = pr.merged === true
    let kind: GitEventKind | null = null
    let occurredAt: string | null = null

    if (action === 'opened') {
      kind = 'pr_opened'
      occurredAt = isoOrNull(pr.created_at)
    } else if (action === 'closed') {
      kind = merged ? 'pr_merged' : 'pr_closed'
      occurredAt = isoOrNull(merged ? pr.merged_at : pr.closed_at)
    } else {
      return []
    }

    const author = (pr.user as { login?: string } | undefined)?.login ?? sender

    return [
      {
        ...base,
        dedup_key: keyFor(kind, String(intOrNull(pr.number) ?? '')),
        kind,
        // En PRs no hay email de autor en el payload; la atribucion va por login.
        actor_login: author,
        pr_number: intOrNull(pr.number),
        pr_created_at: isoOrNull(pr.created_at),
        pr_merged_at: isoOrNull(pr.merged_at),
        additions: intOrNull(pr.additions),
        deletions: intOrNull(pr.deletions),
        changed_files: intOrNull(pr.changed_files),
        meta: {
          draft: pr.draft === true,
          commits: intOrNull(pr.commits),
          merged_by:
            (pr.merged_by as { login?: string } | null | undefined)?.login ?? null,
        },
        occurred_at: occurredAt ?? receivedAt.toISOString(),
      },
    ]
  }

  if (eventType === 'pull_request_review') {
    if (payload.action !== 'submitted') return []
    const review = payload.review as Record<string, unknown> | undefined
    const pr = payload.pull_request as Record<string, unknown> | undefined
    if (!review) return []

    const state = typeof review.state === 'string' ? review.state.toLowerCase() : null

    return [
      {
        ...base,
        dedup_key: keyFor(
          'review',
          `${intOrNull(pr?.number) ?? ''}:${(review.id as number | undefined) ?? ''}`,
        ),
        kind: 'review',
        actor_login: (review.user as { login?: string } | undefined)?.login ?? sender,
        pr_number: intOrNull(pr?.number),
        review_state: state,
        meta: {},
        occurred_at: isoOrNull(review.submitted_at) ?? receivedAt.toISOString(),
      },
    ]
  }

  return []
}
