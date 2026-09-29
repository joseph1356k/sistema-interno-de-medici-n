/**
 * Parsers de los eventos de webhook que alimentan el tablero en vivo y las
 * metricas de entrega.
 *
 * `github.ts` sigue encargandose de la firma y de los hechos historicos de
 * `git_events`. Aqui vive lo que produce ESTADO: PRs, CI, revisiones y despliegues.
 *
 * Dos decisiones que vienen de la documentacion de GitHub y no son negociables:
 *
 *  - **CI se indexa por `head_sha`, nunca por `pull_requests[]`.** En pushes a una
 *    rama de un fork ese array llega vacio y `head_branch` nulo, asi que atribuir
 *    por ahi perderia silenciosamente el CI de las contribuciones externas. El sha
 *    se resuelve a PR contra nuestra propia tabla.
 *  - **`conclusion` se trata como texto libre.** El esquema publicado no incluye
 *    `startup_failure`, que GitHub si emite. Un enum aqui rechazaria datos reales.
 */

import { createHmac } from 'node:crypto'
import type { PrPatch, PrState } from './pr-state'

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function iso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000).toISOString()
  if (typeof v !== 'string' || v === '') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null
}

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
}

function login(v: unknown): string | null {
  return str(v, 100)
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/**
 * Traduce cualquier accion de `pull_request` a una actualizacion de estado.
 *
 * No se filtra por accion: hasta `labeled` trae el objeto `pull_request` completo,
 * y aprovecharlo mantiene la fila fresca sin coste. La fusion se encarga de que un
 * evento viejo no estropee nada.
 */
export function parsePullRequestState(
  payload: Record<string, unknown>,
): PrPatch | null {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name
  const pr = payload.pull_request as Record<string, unknown> | undefined
  if (typeof repo !== 'string' || !pr) return null

  const number = int(pr.number)
  if (number === null) return null

  const merged = pr.merged === true || iso(pr.merged_at) !== null
  const closedAt = iso(pr.closed_at)

  let state: PrState = 'open'
  if (merged) state = 'merged'
  else if (pr.state === 'closed' || closedAt) state = 'closed'

  // `updated_at` es cuando GitHub toco el PR: la mejor marca disponible para
  // ordenar eventos del mismo PR entre si.
  const eventTs = iso(pr.updated_at) ?? iso(pr.created_at) ?? new Date().toISOString()

  const reviewers = Array.isArray(pr.requested_reviewers)
    ? pr.requested_reviewers.length
    : null

  return {
    repo,
    number,
    event_ts: eventTs,
    state,
    author_login: login((pr.user as { login?: string } | undefined)?.login),
    draft: pr.draft === true,
    head_sha: str((pr.head as { sha?: string } | undefined)?.sha, 64),
    base_ref: str((pr.base as { ref?: string } | undefined)?.ref),
    additions: int(pr.additions),
    deletions: int(pr.deletions),
    changed_files: int(pr.changed_files),
    commits: int(pr.commits),
    // GitHub calcula la mergeabilidad aparte, asi que aqui suele venir nula. La
    // fusion no deja que un nulo borre un valor bueno del job de sincronizacion.
    mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
    mergeable_state: str(pr.mergeable_state, 40),
    requested_reviewers: reviewers ?? 0,
    created_at: iso(pr.created_at),
    // `ready_at` solo se fija en dos casos: al salir de borrador, o al abrirse un
    // PR que nunca fue borrador. Deducirlo de `draft === false` en cualquier otra
    // accion lo fechaba en `created_at`, y como la fusion conserva el valor mas
    // antiguo, eso sobrescribia la fecha real de salida de borrador.
    ready_at:
      payload.action === 'ready_for_review'
        ? eventTs
        : payload.action === 'opened' && pr.draft !== true
          ? iso(pr.created_at)
          : undefined,
    merged_at: iso(pr.merged_at),
    closed_at: closedAt,
  }
}

// ---------------------------------------------------------------------------
// Revisiones
// ---------------------------------------------------------------------------

export interface ReviewRow {
  dedup_key: string
  repo: string
  pr_number: number
  reviewer_login: string | null
  pr_author_login: string | null
  state: string | null
  submitted_at: string
  external_id: string | null
}

export function parseReviewEvent(
  payload: Record<string, unknown>,
): { review: ReviewRow; pr: PrPatch } | null {
  if (payload.action !== 'submitted') return null

  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name
  const review = payload.review as Record<string, unknown> | undefined
  const pr = payload.pull_request as Record<string, unknown> | undefined
  if (typeof repo !== 'string' || !review || !pr) return null

  const number = int(pr.number)
  const submittedAt = iso(review.submitted_at)
  if (number === null || !submittedAt) return null

  const state = str(review.state, 40)?.toLowerCase() ?? null
  const externalId = review.id !== undefined ? String(review.id) : null

  return {
    review: {
      dedup_key: `rv:${repo}:${number}:${externalId ?? submittedAt}`,
      repo,
      pr_number: number,
      reviewer_login: login((review.user as { login?: string } | undefined)?.login),
      pr_author_login: login((pr.user as { login?: string } | undefined)?.login),
      state,
      submitted_at: submittedAt,
      external_id: externalId,
    },
    pr: {
      repo,
      number,
      event_ts: submittedAt,
      // `commented` no cambia el veredicto: un comentario suelto no es ni
      // aprobacion ni peticion de cambios, y tratarlo como tal moveria el PR de
      // columna en el tablero sin que nadie haya decidido nada.
      last_review_state: state === 'commented' ? undefined : state,
      first_review_at: submittedAt,
      approved_at: state === 'approved' ? submittedAt : undefined,
    },
  }
}

export interface ReviewCommentRow {
  dedup_key: string
  repo: string
  pr_number: number
  review_id: string | null
  commenter_login: string | null
  created_at: string
}

/** Solo metadatos: quien y cuando. El cuerpo del comentario NO se guarda. */
export function parseReviewCommentEvent(
  payload: Record<string, unknown>,
): ReviewCommentRow | null {
  if (payload.action !== 'created') return null

  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name
  const comment = payload.comment as Record<string, unknown> | undefined
  const pr = payload.pull_request as Record<string, unknown> | undefined
  if (typeof repo !== 'string' || !comment || !pr) return null

  const number = int(pr.number)
  const createdAt = iso(comment.created_at)
  if (number === null || !createdAt) return null

  return {
    dedup_key: `rc:${repo}:${number}:${String(comment.id ?? createdAt)}`,
    repo,
    pr_number: number,
    review_id:
      comment.pull_request_review_id !== undefined &&
      comment.pull_request_review_id !== null
        ? String(comment.pull_request_review_id)
        : null,
    commenter_login: login((comment.user as { login?: string } | undefined)?.login),
    created_at: createdAt,
  }
}

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

export interface CiRunRow {
  dedup_key: string
  repo: string
  head_sha: string
  provider: string
  external_id: string | null
  name: string | null
  branch: string | null
  status: string | null
  conclusion: string | null
  attempt: number | null
  trigger_event: string | null
  started_at: string | null
  completed_at: string | null
  duration_seconds: number | null
}

function durationSeconds(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  const d = Math.round((Date.parse(to) - Date.parse(from)) / 1000)
  return Number.isFinite(d) && d >= 0 ? d : null
}

/**
 * `check_suite` es el evento mas eficiente para saber si un commit esta verde: uno
 * por aplicacion y por sha, y ya trae la conclusion. El webhook de organizacion
 * solo entrega la accion `completed`, que es justo la que interesa.
 */
export function parseCheckSuiteEvent(
  payload: Record<string, unknown>,
): CiRunRow | null {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name
  const suite = payload.check_suite as Record<string, unknown> | undefined
  if (typeof repo !== 'string' || !suite) return null

  const headSha = str(suite.head_sha, 64)
  if (!headSha) return null

  const startedAt = iso(suite.created_at)
  const completedAt = iso(suite.updated_at)

  return {
    dedup_key: `cs:${repo}:${String(suite.id ?? headSha)}`,
    repo,
    head_sha: headSha,
    provider: 'check_suite',
    external_id: suite.id !== undefined ? String(suite.id) : null,
    // El nombre de la aplicacion que corrio los checks, no contenido de nadie.
    name: str((suite.app as { name?: string } | undefined)?.name),
    // Nulo en pushes a forks: se acepta, y el sha sigue siendo la clave.
    branch: str(suite.head_branch, 255),
    status: str(suite.status, 40),
    conclusion: str(suite.conclusion, 40),
    attempt: null,
    trigger_event: null,
    started_at: startedAt,
    completed_at: suite.status === 'completed' ? completedAt : null,
    duration_seconds:
      suite.status === 'completed' ? durationSeconds(startedAt, completedAt) : null,
  }
}

/** `workflow_run` da duracion e intento, que `check_suite` no tiene. */
export function parseWorkflowRunEvent(
  payload: Record<string, unknown>,
): CiRunRow | null {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name
  const run = payload.workflow_run as Record<string, unknown> | undefined
  if (typeof repo !== 'string' || !run) return null

  const headSha = str(run.head_sha, 64)
  if (!headSha) return null

  const startedAt = iso(run.run_started_at) ?? iso(run.created_at)
  const completedAt = iso(run.updated_at)
  const completed = run.status === 'completed'

  return {
    // El intento entra en la clave: un re-run es una ejecucion distinta, y es
    // justo lo que mide "iteraciones hasta verde".
    dedup_key: `wr:${repo}:${String(run.id ?? headSha)}:${int(run.run_attempt) ?? 1}`,
    repo,
    head_sha: headSha,
    provider: 'workflow_run',
    external_id: run.id !== undefined ? String(run.id) : null,
    name: str(run.name),
    branch: str(run.head_branch, 255),
    status: str(run.status, 40),
    conclusion: str(run.conclusion, 40),
    attempt: int(run.run_attempt),
    trigger_event: str(run.event, 40),
    started_at: startedAt,
    completed_at: completed ? completedAt : null,
    duration_seconds: completed ? durationSeconds(startedAt, completedAt) : null,
  }
}

/** Commit status, para repos con integraciones antiguas. */
export function parseStatusEvent(payload: Record<string, unknown>): CiRunRow | null {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name
  const sha = str(payload.sha, 64)
  const state = str(payload.state, 40)
  if (typeof repo !== 'string' || !sha || !state) return null

  // `pending` no dice nada todavia; solo interesan los resultados.
  if (state === 'pending') return null

  const branches = payload.branches as { name?: string }[] | undefined
  const updatedAt = iso(payload.updated_at) ?? iso(payload.created_at)

  return {
    dedup_key: `st:${repo}:${sha}:${str(payload.context, 200) ?? 'default'}`,
    repo,
    head_sha: sha,
    provider: 'status',
    external_id: payload.id !== undefined ? String(payload.id) : null,
    name: str(payload.context, 200),
    branch: str(branches?.[0]?.name, 255),
    status: 'completed',
    // `error` y `failure` son ambos fallo para lo que aqui se mide.
    conclusion: state === 'success' ? 'success' : 'failure',
    attempt: null,
    trigger_event: null,
    started_at: iso(payload.created_at),
    completed_at: updatedAt,
    duration_seconds: durationSeconds(iso(payload.created_at), updatedAt),
  }
}

// ---------------------------------------------------------------------------
// Despliegues (DORA)
// ---------------------------------------------------------------------------

export interface DeploymentRow {
  dedup_key: string
  repo: string
  environment: string | null
  ref: string | null
  sha: string | null
  source: string
  deployed_at: string
  is_rollback: boolean
  external_id: string | null
}

export function parseReleaseEvent(
  payload: Record<string, unknown>,
): DeploymentRow | null {
  if (payload.action !== 'published') return null

  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name
  const release = payload.release as Record<string, unknown> | undefined
  if (typeof repo !== 'string' || !release) return null
  if (release.draft === true) return null

  const publishedAt = iso(release.published_at) ?? iso(release.created_at)
  if (!publishedAt) return null

  return {
    dedup_key: `rel:${repo}:${String(release.id ?? publishedAt)}`,
    repo,
    environment: release.prerelease === true ? 'prerelease' : 'production',
    ref: str(release.tag_name, 255),
    sha: null,
    source: 'release',
    deployed_at: publishedAt,
    is_rollback: false,
    external_id: release.id !== undefined ? String(release.id) : null,
  }
}

/** `deployment_status` con estado `success` es la senal mas fiable si la usan. */
export function parseDeploymentStatusEvent(
  payload: Record<string, unknown>,
): DeploymentRow | null {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name
  const status = payload.deployment_status as Record<string, unknown> | undefined
  const deployment = payload.deployment as Record<string, unknown> | undefined
  if (typeof repo !== 'string' || !status || !deployment) return null
  if (status.state !== 'success') return null

  const at = iso(status.created_at) ?? iso(deployment.created_at)
  if (!at) return null

  return {
    dedup_key: `dep:${repo}:${String(deployment.id ?? at)}`,
    repo,
    environment: str(deployment.environment, 100),
    ref: str(deployment.ref, 255),
    sha: str(deployment.sha, 64),
    source: 'deployment_status',
    deployed_at: at,
    is_rollback: false,
    external_id: deployment.id !== undefined ? String(deployment.id) : null,
  }
}

// ---------------------------------------------------------------------------
// Archivos tocados, con la ruta convertida en hash
// ---------------------------------------------------------------------------

export interface CommitFileRow {
  dedup_key: string
  repo: string
  sha: string
  path_hash: string
  change_type: string
  committed_at: string
}

/**
 * Convierte la ruta en HMAC-SHA256 con una sal secreta. Permite medir retrabajo
 * ("cuantos archivos se vuelven a tocar") sin que la base de datos contenga
 * ninguna ruta.
 *
 * Sin `FILE_HASH_SALT` devuelve null y no se recoge nada: es una funcionalidad
 * opcional, y el panel dice que esta apagada en vez de mostrar un cero engañoso.
 *
 * Limite honesto: quien tenga la sal y acceso al repositorio puede rehacer los
 * hashes. Protege la base de datos, no es anonimato fuerte.
 */
export function hashPath(path: string): string | null {
  const salt = process.env.FILE_HASH_SALT
  if (!salt) return null
  return createHmac('sha256', salt).update(path).digest('hex').slice(0, 32)
}

export function parsePushFiles(payload: Record<string, unknown>): CommitFileRow[] {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name
  const commits = payload.commits as Record<string, unknown>[] | undefined
  if (typeof repo !== 'string' || !Array.isArray(commits)) return []
  if (!process.env.FILE_HASH_SALT) return []

  const rows: CommitFileRow[] = []

  for (const commit of commits) {
    if (commit?.distinct === false) continue
    const sha = str(commit?.id, 64)
    const at = iso(commit?.timestamp)
    if (!sha || !at) continue

    for (const [field, changeType] of [
      ['added', 'added'],
      ['modified', 'modified'],
      ['removed', 'removed'],
    ] as const) {
      const paths = commit[field]
      if (!Array.isArray(paths)) continue
      for (const path of paths) {
        if (typeof path !== 'string') continue
        const hash = hashPath(path)
        if (!hash) continue
        rows.push({
          dedup_key: `cf:${repo}:${sha}:${hash}`,
          repo,
          sha,
          path_hash: hash,
          change_type: changeType,
          committed_at: at,
        })
      }
    }
  }

  return rows
}
