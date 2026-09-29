/**
 * Calculo del tablero en vivo.
 *
 * Se guarda como UNA fila en `live_snapshot`, no se recalcula en cada visita: la
 * vista se refresca cada 60 s y hacer veinte agregaciones cada minuto por cada
 * pestana abierta es un desperdicio. Se recalcula tras los webhooks y en el cron.
 */

import { db } from './db'
import { blockReason, type BlockReason } from './pr-state'

export interface BlockedPr {
  repo: string
  number: number
  author: string | null
  reason: BlockReason
  /** Horas desde el ultimo avance real, que es lo que hace accionable la fila. */
  stalled_hours: number
  size_lines: number | null
  reviewers: number
}

export interface LiveAlert {
  kind: 'pr_stalled' | 'ci_red_on_main' | 'no_reviewer' | 'device_quiet'
  severity: 'warning' | 'critical'
  message: string
}

export interface TodayActivity {
  person_id: string | null
  display_name: string
  claude_hours: number
  codex_hours_est: number
  pushes: number
  commits: number
  reviews: number
}

export interface LiveSnapshot {
  computed_at: string
  open_prs: number
  by_reason: Record<BlockReason, number>
  blocked: BlockedPr[]
  main_ci: { repo: string; conclusion: string | null; since: string | null }[]
  today: TodayActivity[]
  team_today: { claude_hours: number; pushes: number; merges: number }
  trailing_avg: { claude_hours: number; pushes: number; merges: number }
  alerts: LiveAlert[]
  is_demo: boolean
}

/**
 * Filas tal como llegan de la base. Se declaran explicitamente porque el cliente
 * de Supabase infiere los tipos leyendo la cadena literal del `select`, y una
 * cadena partida en varias lineas le hace perder el hilo.
 */
interface OpenPrRow {
  repo: string
  number: number
  author_login: string | null
  draft: boolean | null
  mergeable_state: string | null
  last_review_state: string | null
  first_review_at: string | null
  requested_reviewers: number | null
  head_sha: string | null
  additions: number | null
  deletions: number | null
  created_at: string | null
  ready_at: string | null
  event_ts: string | null
}

interface CiRunRow {
  repo: string
  head_sha: string
  branch: string | null
  conclusion: string | null
  completed_at: string | null
}

interface TodayRow {
  person_id: string
  display_name: string
  claude_seconds: number
  codex_seconds_est: number
  pushes: number
  commits: number
  prs_merged: number
  reviews_given: number
}

const EMPTY_REASONS: Record<BlockReason, number> = {
  draft: 0,
  ci_red: 0,
  conflict: 0,
  changes_requested: 0,
  awaiting_review: 0,
  ready_to_merge: 0,
}

/** Umbrales de alerta. Conservadores a proposito: una alerta que salta siempre
 *  deja de ser una alerta. */
export const THRESHOLDS = {
  stalledPrHours: 48,
  readyToMergeHours: 24,
  mainRedHours: 4,
  deviceQuietDays: 5,
}

function hoursSince(iso: string | null | undefined, now: number): number {
  if (!iso) return 0
  return Math.max(0, (now - Date.parse(iso)) / 3_600_000)
}

export async function computeSnapshot(now = new Date()): Promise<LiveSnapshot> {
  const client = db()
  const nowMs = now.getTime()
  const today = now.toISOString().slice(0, 10)

  const [openPrs, ciLatest, rollupToday, trailing, devices, demo] = await Promise.all([
    client
      .from('pull_requests')
      .select(
        'repo, number, author_login, draft, mergeable_state, last_review_state, ' +
          'first_review_at, requested_reviewers, head_sha, additions, deletions, ' +
          'created_at, ready_at, event_ts',
      )
      .eq('state', 'open'),
    client
      .from('ci_runs')
      .select('repo, head_sha, branch, conclusion, completed_at')
      .not('conclusion', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(400),
    client.from('v_today_activity').select('*'),
    client.from('v_trailing_average').select('*').maybeSingle(),
    client.from('v_device_health').select('hostname, display_name, hours_since_last_seen'),
    client.from('git_events').select('id').eq('meta->>source', 'demo').limit(1),
  ])

  const prRows = (openPrs.data ?? []) as unknown as OpenPrRow[]
  const ciRows = (ciLatest.data ?? []) as unknown as CiRunRow[]
  const todayData = (rollupToday.data ?? []) as unknown as TodayRow[]

  const ciBySha = new Map<string, string | null>()
  for (const run of ciRows) {
    // El primero que aparece es el mas reciente por el orden de la consulta.
    if (!ciBySha.has(run.head_sha)) ciBySha.set(run.head_sha, run.conclusion)
  }

  const by_reason = { ...EMPTY_REASONS }
  const blocked: BlockedPr[] = []

  for (const pr of prRows) {
    const reason = blockReason({
      draft: pr.draft === true,
      mergeable_state: pr.mergeable_state,
      last_review_state: pr.last_review_state,
      first_review_at: pr.first_review_at,
      requested_reviewers: pr.requested_reviewers ?? 0,
      ci_conclusion: pr.head_sha ? (ciBySha.get(pr.head_sha) ?? null) : null,
    })

    by_reason[reason]++

    // El reloj cuenta desde el ultimo avance real (`event_ts`), no desde la
    // apertura: un PR que se actualizo hace una hora no esta atascado.
    blocked.push({
      repo: pr.repo,
      number: pr.number,
      author: pr.author_login,
      reason,
      stalled_hours: hoursSince(pr.event_ts, nowMs),
      size_lines: pr.additions === null ? null : pr.additions + (pr.deletions ?? 0),
      reviewers: pr.requested_reviewers ?? 0,
    })
  }

  // Los mas atascados primero: es el orden en que hay que atenderlos.
  blocked.sort((a, b) => b.stalled_hours - a.stalled_hours)

  // Estado de CI en la rama principal de cada repo.
  const mainByRepo = new Map<string, { conclusion: string | null; since: string | null }>()
  for (const run of ciRows) {
    if (run.branch !== 'main' && run.branch !== 'master') continue
    if (mainByRepo.has(run.repo)) continue
    mainByRepo.set(run.repo, {
      conclusion: run.conclusion,
      since: run.completed_at,
    })
  }

  const todayRows: TodayActivity[] = todayData.map((r) => ({
    person_id: r.person_id,
    display_name: r.display_name,
    claude_hours: (Number(r.claude_seconds) || 0) / 3600,
    codex_hours_est: (Number(r.codex_seconds_est) || 0) / 3600,
    pushes: Number(r.pushes) || 0,
    commits: Number(r.commits) || 0,
    reviews: Number(r.reviews_given) || 0,
  }))

  const team_today = {
    claude_hours: todayRows.reduce((s, r) => s + r.claude_hours + r.codex_hours_est, 0),
    pushes: todayRows.reduce((s, r) => s + r.pushes, 0),
    merges: todayData.reduce((sum, r) => sum + (Number(r.prs_merged) || 0), 0),
  }

  const t = trailing.data as Record<string, unknown> | null
  const trailing_avg = {
    claude_hours: Number(t?.avg_tool_hours) || 0,
    pushes: Number(t?.avg_pushes) || 0,
    merges: Number(t?.avg_merges) || 0,
  }

  // --- Alertas ---------------------------------------------------------------
  const alerts: LiveAlert[] = []

  for (const pr of blocked) {
    if (pr.reason === 'draft') continue
    if (
      pr.reason === 'awaiting_review' &&
      pr.stalled_hours >= THRESHOLDS.stalledPrHours
    ) {
      alerts.push({
        kind: 'pr_stalled',
        severity: pr.stalled_hours >= THRESHOLDS.stalledPrHours * 2 ? 'critical' : 'warning',
        message: `${pr.repo}#${pr.number} lleva ${Math.round(pr.stalled_hours)} h esperando revisión`,
      })
    }
    if (pr.reason === 'awaiting_review' && pr.reviewers === 0) {
      alerts.push({
        kind: 'no_reviewer',
        severity: 'warning',
        message: `${pr.repo}#${pr.number} no tiene ningún revisor asignado`,
      })
    }
    if (
      pr.reason === 'ready_to_merge' &&
      pr.stalled_hours >= THRESHOLDS.readyToMergeHours
    ) {
      alerts.push({
        kind: 'pr_stalled',
        severity: 'warning',
        message: `${pr.repo}#${pr.number} está aprobado y sin mergear desde hace ${Math.round(pr.stalled_hours)} h`,
      })
    }
  }

  for (const [repo, ci] of mainByRepo) {
    if (ci.conclusion !== 'failure') continue
    const h = hoursSince(ci.since, nowMs)
    if (h >= THRESHOLDS.mainRedHours) {
      alerts.push({
        kind: 'ci_red_on_main',
        severity: 'critical',
        message: `CI en rojo en la rama principal de ${repo} desde hace ${Math.round(h)} h`,
      })
    }
  }

  for (const d of (devices.data ?? []) as unknown as {
    hostname: string
    hours_since_last_seen: number | null
  }[]) {
    const h = Number(d.hours_since_last_seen)
    if (Number.isFinite(h) && h > THRESHOLDS.deviceQuietDays * 24) {
      alerts.push({
        kind: 'device_quiet',
        severity: 'warning',
        // Importa porque sin esto un cero se lee como inactividad de la persona
        // cuando en realidad es un fallo de instalacion.
        message: `${d.hostname} no reporta desde hace ${Math.round(h / 24)} días: puede ser un fallo de instalación, no inactividad`,
      })
    }
  }

  return {
    computed_at: now.toISOString(),
    open_prs: (openPrs.data ?? []).length,
    by_reason,
    blocked: blocked.slice(0, 50),
    main_ci: [...mainByRepo.entries()].map(([repo, v]) => ({ repo, ...v })),
    today: todayRows,
    team_today,
    trailing_avg,
    alerts,
    is_demo: (demo.data ?? []).length > 0,
  }
}

/** Recalcula y guarda el tablero. Se llama tras los webhooks y desde el cron. */
export async function refreshSnapshot(): Promise<LiveSnapshot> {
  // El dia en curso se recalcula antes de leerlo, para que `v_today_activity`
  // este fresca. Es un solo dia de datos, asi que es barato, y evita duplicar la
  // logica de agregacion entre "hoy" y "el historico".
  await db().rpc('rollup_day', { target: new Date().toISOString().slice(0, 10) })

  const snapshot = await computeSnapshot()
  await db()
    .from('live_snapshot')
    .upsert(
      { id: 1, payload: snapshot, computed_at: snapshot.computed_at },
      { onConflict: 'id' },
    )
  return snapshot
}

export async function readSnapshot(): Promise<LiveSnapshot | null> {
  const { data } = await db()
    .from('live_snapshot')
    .select('payload, computed_at')
    .eq('id', 1)
    .maybeSingle()

  const payload = data?.payload as LiveSnapshot | undefined
  if (!payload || Object.keys(payload).length === 0) return null
  return payload
}
