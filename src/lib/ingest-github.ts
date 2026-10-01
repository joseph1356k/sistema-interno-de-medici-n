/**
 * Despacho de webhooks de GitHub a la base de datos.
 *
 * Vive aparte de la ruta para poder probarse con la base simulada: es donde se
 * decide que se guarda, y eso merece tests.
 */

import { db } from './db'
import { parseWebhook } from './github'
import {
  parseCheckSuiteEvent,
  parseDeploymentStatusEvent,
  parsePullRequestState,
  parsePushFiles,
  parseReleaseEvent,
  parseReviewCommentEvent,
  parseReviewEvent,
  parseStatusEvent,
  parseWorkflowRunEvent,
} from './github-events'
import { mergePrState, type PrPatch, type PrSnapshot } from './pr-state'

export interface IngestResult {
  git_events: number
  pull_requests: number
  reviews: number
  review_comments: number
  ci_runs: number
  deployments: number
  commit_files: number
}

const empty: IngestResult = {
  git_events: 0,
  pull_requests: 0,
  reviews: 0,
  review_comments: 0,
  ci_runs: 0,
  deployments: 0,
  commit_files: 0,
}

const PR_COLUMNS =
  'repo, number, author_login, state, draft, head_sha, head_ref, base_ref, additions, ' +
  'deletions, changed_files, commits, mergeable, mergeable_state, ' +
  'requested_reviewers, last_review_state, created_at, ready_at, ' +
  'first_review_at, approved_at, merged_at, closed_at, event_ts'

/**
 * Aplica actualizaciones de estado de PR: por cada PR lee la fila, fusiona en
 * memoria TODOS sus parches, en orden, y la escribe una sola vez.
 *
 * La logica de eventos desordenados es demasiado delicada para un solo upsert, asi
 * que se lee y se escribe. Agrupar importa porque un mismo evento puede traer
 * varios parches del mismo PR (una revision trae la revision y el PR): sin
 * agrupar, eran dos lecturas y dos escrituras por evento.
 *
 * Devuelve cuantos PR escribio.
 */
export async function applyPrPatches(patches: PrPatch[]): Promise<number> {
  if (patches.length === 0) return 0
  const client = db()

  const byPr = new Map<string, PrPatch[]>()
  for (const patch of patches) {
    const key = `${patch.repo}#${patch.number}`
    byPr.set(key, [...(byPr.get(key) ?? []), patch])
  }

  for (const group of byPr.values()) {
    const first = group[0]!
    const { data: existing, error: readError } = await client
      .from('pull_requests')
      .select(PR_COLUMNS)
      .eq('repo', first.repo)
      .eq('number', first.number)
      .maybeSingle()
    // Sin la fila actual no se puede fusionar: escribir a ciegas podria pisar un
    // estado mas nuevo con uno viejo.
    if (readError) throw new Error(`pull_requests: ${readError.message}`)

    let merged = (existing as PrSnapshot | null) ?? null
    for (const patch of group) merged = mergePrState(merged, patch)

    const { error } = await client
      .from('pull_requests')
      .upsert({ ...merged!, updated_at: new Date().toISOString() }, {
        onConflict: 'repo,number',
      })
    if (error) throw new Error(`pull_requests: ${error.message}`)
  }

  return byPr.size
}

/** Un solo parche. La usa la reconciliacion, que sincroniza PR a PR. */
export async function applyPrPatch(patch: PrPatch): Promise<void> {
  await applyPrPatches([patch])
}

/** Despacha un webhook ya verificado. Devuelve cuantas filas escribio por tabla. */
export async function ingestWebhook(
  eventType: string,
  payload: Record<string, unknown>,
  deliveryId: string | null,
): Promise<IngestResult> {
  const client = db()
  const result: IngestResult = { ...empty }

  // Hechos historicos: push, apertura y cierre de PR, revisiones. Sigue igual que
  // en la v1 y alimenta las metricas de actividad por persona.
  const gitRows = parseWebhook(eventType, payload, deliveryId)
  if (gitRows.length > 0) {
    const { error } = await client
      .from('git_events')
      .upsert(gitRows, { onConflict: 'dedup_key', ignoreDuplicates: true })
    if (error) throw new Error(`git_events: ${error.message}`)
    result.git_events = gitRows.length
  }

  const patches: PrPatch[] = []

  switch (eventType) {
    case 'push': {
      const files = parsePushFiles(payload)
      if (files.length > 0) {
        const { error } = await client
          .from('commit_files')
          .upsert(files, { onConflict: 'dedup_key', ignoreDuplicates: true })
        if (error) throw new Error(`commit_files: ${error.message}`)
        result.commit_files = files.length
      }
      break
    }

    case 'pull_request': {
      const patch = parsePullRequestState(payload)
      if (patch) patches.push(patch)
      break
    }

    case 'pull_request_review': {
      const parsed = parseReviewEvent(payload)
      if (parsed) {
        const { error } = await client
          .from('reviews')
          .upsert([parsed.review], { onConflict: 'dedup_key', ignoreDuplicates: true })
        if (error) throw new Error(`reviews: ${error.message}`)
        result.reviews = 1
        patches.push(...parsed.pr)
      }
      break
    }

    case 'pull_request_review_comment': {
      const row = parseReviewCommentEvent(payload)
      if (row) {
        const { error } = await client
          .from('review_comments')
          .upsert([row], { onConflict: 'dedup_key', ignoreDuplicates: true })
        if (error) throw new Error(`review_comments: ${error.message}`)
        result.review_comments = 1
      }
      break
    }

    case 'check_suite':
    case 'workflow_run':
    case 'status': {
      const row =
        eventType === 'check_suite'
          ? parseCheckSuiteEvent(payload)
          : eventType === 'workflow_run'
            ? parseWorkflowRunEvent(payload)
            : parseStatusEvent(payload)
      if (row) {
        const { error } = await client
          .from('ci_runs')
          .upsert([row], { onConflict: 'dedup_key' })
        if (error) throw new Error(`ci_runs: ${error.message}`)
        result.ci_runs = 1
      }
      break
    }

    case 'release':
    case 'deployment_status': {
      const row =
        eventType === 'release'
          ? parseReleaseEvent(payload)
          : parseDeploymentStatusEvent(payload)
      if (row) {
        // Sin ignoreDuplicates: un despliegue que falla y luego se reintenta con
        // exito debe quedar con su estado final.
        const { error } = await client
          .from('deployments')
          .upsert([row], { onConflict: 'dedup_key' })
        if (error) throw new Error(`deployments: ${error.message}`)
        result.deployments = 1
      }
      break
    }
  }

  result.pull_requests = await applyPrPatches(patches)

  return result
}

/**
 * Tipos de evento que cambian el tablero en vivo y por tanto obligan a
 * recalcularlo. Un `push` no entra: no altera el estado de ningun PR abierto, y
 * refrescar en cada push seria trabajo tirado.
 */
const AFFECTS_BOARD = new Set([
  'pull_request',
  'pull_request_review',
  'check_suite',
  'workflow_run',
  'status',
])

export function affectsBoard(eventType: string): boolean {
  return AFFECTS_BOARD.has(eventType)
}

/** Tipos de evento que el webhook de la organizacion deberia tener marcados. */
export const SUBSCRIBED_EVENTS = [
  'push',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_suite',
  'workflow_run',
  'status',
  'release',
  'deployment_status',
] as const
