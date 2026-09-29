/**
 * Fusion del estado de un pull request.
 *
 * Los webhooks de GitHub llegan DESORDENADOS y con campos incompletos, asi que no
 * se puede simplemente sobrescribir la fila con lo ultimo que llegue. Tres reglas:
 *
 *  1. **Hitos**: `created_at`, `ready_at`, `first_review_at`, `approved_at`... son
 *     "la primera vez que". Se queda el valor MAS ANTIGUO de los dos.
 *  2. **Estado presente** (draft, head_sha, mergeable, tamano...): gana el evento
 *     con marca de tiempo mas reciente. Un evento viejo no pisa uno nuevo.
 *  3. **`merged` es terminal**: un `synchronize` retrasado no puede des-mergear un
 *     PR. Sin esta regla, el tablero en vivo mostraria PRs ya cerrados como
 *     abiertos, que es exactamente el fallo que lo volveria inutil.
 *
 * Ademas, GitHub calcula `mergeable` de forma asincrona, asi que los webhooks
 * suelen traerlo nulo o desactualizado. Un valor nulo entrante NO borra uno bueno
 * que dejo el job de sincronizacion.
 *
 * La funcion es pura a proposito: es la logica con mas casos borde del sistema y
 * asi se puede probar sin base de datos.
 */

export type PrState = 'open' | 'closed' | 'merged'

export interface PrSnapshot {
  repo: string
  number: number
  author_login: string | null
  state: PrState
  draft: boolean
  head_sha: string | null
  base_ref: string | null
  additions: number | null
  deletions: number | null
  changed_files: number | null
  commits: number | null
  mergeable: boolean | null
  mergeable_state: string | null
  requested_reviewers: number
  last_review_state: string | null
  created_at: string | null
  ready_at: string | null
  first_review_at: string | null
  approved_at: string | null
  merged_at: string | null
  closed_at: string | null
  event_ts: string
}

/** Actualizacion parcial: cada tipo de evento aporta solo lo que sabe. */
export type PrPatch = Partial<Omit<PrSnapshot, 'repo' | 'number' | 'event_ts'>> & {
  repo: string
  number: number
  event_ts: string
}

/** Campos que son "la primera vez que paso algo": se queda el mas antiguo. */
const MILESTONES = [
  'created_at',
  'ready_at',
  'first_review_at',
  'approved_at',
  'merged_at',
  'closed_at',
] as const

/** Campos de estado presente: los pisa el evento mas reciente, si trae valor. */
const CURRENT = [
  'author_login',
  'draft',
  'head_sha',
  'base_ref',
  'additions',
  'deletions',
  'changed_files',
  'commits',
  'mergeable',
  'mergeable_state',
  'requested_reviewers',
  'last_review_state',
] as const

function earliest(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return Date.parse(a) <= Date.parse(b) ? a : b
}

/** Estado base para un PR que aun no existe en la tabla. */
function empty(repo: string, number: number, event_ts: string): PrSnapshot {
  return {
    repo,
    number,
    author_login: null,
    state: 'open',
    draft: false,
    head_sha: null,
    base_ref: null,
    additions: null,
    deletions: null,
    changed_files: null,
    commits: null,
    mergeable: null,
    mergeable_state: null,
    requested_reviewers: 0,
    last_review_state: null,
    created_at: null,
    ready_at: null,
    first_review_at: null,
    approved_at: null,
    merged_at: null,
    closed_at: null,
    event_ts,
  }
}

export function mergePrState(
  existing: PrSnapshot | null,
  patch: PrPatch,
): PrSnapshot {
  const base = existing ?? empty(patch.repo, patch.number, patch.event_ts)
  const result: PrSnapshot = { ...base }

  // Un evento es mas nuevo si su marca es >=. El empate se resuelve a favor del
  // entrante: dos eventos del mismo instante suelen ser el mismo cambio.
  const isNewer = Date.parse(patch.event_ts) >= Date.parse(base.event_ts)

  // Regla 1: los hitos siempre se quedan con el valor mas antiguo, venga el evento
  // en orden o no. Que un `pull_request_review` llegue tarde no cambia cuando
  // ocurrio la primera revision.
  for (const key of MILESTONES) {
    if (key in patch) {
      result[key] = earliest(base[key], patch[key])
    }
  }

  // Regla 2: el estado presente lo pisa un evento mas reciente. Un evento MAS
  // VIEJO solo puede RELLENAR campos que aun estan vacios: si el primer webhook
  // procesado fue el del merge, los eventos anteriores son la unica fuente del
  // autor o del sha, y descartarlos entero perderia esos datos para siempre.
  // Nunca sobrescribe un valor que ya existe, asi que no puede retroceder.
  for (const key of CURRENT) {
    const value = patch[key]
    if (value === undefined || value === null) continue
    if (isNewer || base[key] === null) {
      // @ts-expect-error -- asignacion por clave sobre una union de tipos
      result[key] = value
    }
  }
  if (isNewer) result.event_ts = patch.event_ts

  // Regla 3: `merged` es terminal. Fuera de eso, gana el evento mas reciente.
  if (base.state === 'merged') {
    result.state = 'merged'
  } else if (patch.state !== undefined && isNewer) {
    result.state = patch.state
  }

  // Un PR mergeado no es un borrador, diga lo que diga un evento retrasado.
  if (result.state === 'merged') result.draft = false

  // Coherencia: si hay fecha de merge, el estado es merged aunque el evento que
  // la trajo llegara fuera de orden.
  if (result.merged_at && result.state !== 'merged') result.state = 'merged'

  return result
}

/**
 * Motivo por el que un PR abierto no avanza. Es la agrupacion del tablero en
 * vivo: sin ella solo hay una lista de PRs, que no dice que hacer.
 */
export type BlockReason =
  | 'draft'
  | 'ci_red'
  | 'conflict'
  | 'changes_requested'
  | 'awaiting_review'
  | 'ready_to_merge'

export function blockReason(pr: {
  draft: boolean
  mergeable_state: string | null
  last_review_state: string | null
  first_review_at: string | null
  requested_reviewers: number
  ci_conclusion?: string | null
}): BlockReason {
  if (pr.draft) return 'draft'
  // El conflicto va antes que CI: no tiene sentido pedir que arreglen los tests
  // de una rama que primero hay que rebasar.
  if (pr.mergeable_state === 'dirty') return 'conflict'
  if (pr.ci_conclusion === 'failure' || pr.mergeable_state === 'unstable') return 'ci_red'
  if (pr.last_review_state === 'changes_requested') return 'changes_requested'
  if (pr.last_review_state === 'approved') return 'ready_to_merge'
  return 'awaiting_review'
}
