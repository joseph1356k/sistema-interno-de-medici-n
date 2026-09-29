/**
 * Cargadores de las vistas del panel.
 *
 * Uno por vista, y cada uno hace UN `Promise.all` de consultas ya agregadas en la
 * base. La regla es que ninguna vista dispare consultas en bucle: todo lo que se
 * puede agregar en SQL se agrega en SQL.
 */

import { db } from './db'
import {
  forecastCompletion,
  forecastThroughput,
  linearTrend,
  projectMonthlyCost,
  type CompletionForecast,
  type CostProjection,
  type ThroughputForecast,
  type Trend,
} from './forecast'
import { daysAgo, loadRollup, median, weekStart } from './metrics'

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Entrega: DORA y flujo
// ---------------------------------------------------------------------------

export interface DeliveryMetrics {
  dora: {
    deploysPerWeek: number | null
    medianLeadTimeHours: number | null
    leadTimeBasis: 'to_deploy' | 'to_merge' | 'mixed' | null
    changeFailureRate: number | null
    medianRestoreHours: number | null
  }
  cycle: {
    medianToFirstReview: number | null
    medianReviewToApproval: number | null
    medianApprovalToMerge: number | null
    medianTotal: number | null
    weekly: { week: string; median: number; count: number }[]
  }
  wip: { day: string; open: number }[]
  sizeBuckets: {
    bucket: string
    prs: number
    medianReviewHours: number | null
    medianMergeHours: number | null
  }[]
  quality: {
    week: string
    merged: number
    abandoned: number
    abandonRate: number | null
  }[]
  churn: { week: string; touched: number; reworked: number; rate: number | null }[]
  churnEnabled: boolean
}

export async function loadDelivery(windowDays = 90): Promise<DeliveryMetrics> {
  const client = db()
  const since = daysAgo(windowDays)

  const [deploys, leadTime, failure, restore, cycle, wip, buckets, quality, churn] =
    await Promise.all([
      client.from('v_dora_deploy_frequency').select('*').gte('week', since),
      client.from('v_dora_lead_time').select('*').gte('merged_at', since),
      client.from('v_dora_change_failure').select('*').gte('week', since),
      client.from('v_dora_restore_time').select('*').gte('failed_at', since),
      client.from('v_pr_cycle_breakdown').select('*').gte('merged_at', since),
      client.from('v_wip_by_day').select('*').gte('day', since),
      client.from('v_pr_size_buckets').select('*'),
      client.from('v_quality_signals').select('*').gte('week', since),
      client.from('v_churn').select('*').gte('week', since),
    ])

  const deployRows = (deploys.data ?? []) as Record<string, unknown>[]
  const leadRows = (leadTime.data ?? []) as Record<string, unknown>[]
  const failRows = (failure.data ?? []) as Record<string, unknown>[]
  const cycleRows = (cycle.data ?? []) as Record<string, unknown>[]

  // Frecuencia de despliegue: media semanal sobre las semanas observadas.
  const weeksObserved = new Set(deployRows.map((r) => String(r.week))).size
  const totalDeploys = deployRows.reduce((s, r) => s + num(r.deploys), 0)

  // Si los repos miden el lead time de forma distinta (unos hasta el despliegue,
  // otros solo hasta el merge), se dice "mixto": promediarlos en silencio seria
  // comparar cosas que no son lo mismo.
  const bases = new Set(leadRows.map((r) => String(r.basis)))
  const leadTimeBasis =
    bases.size === 0
      ? null
      : bases.size > 1
        ? 'mixed'
        : ((bases.values().next().value as 'to_deploy' | 'to_merge') ?? null)

  const totalDeploysForRate = failRows.reduce((s, r) => s + num(r.deploys), 0)
  const totalFailures = failRows.reduce((s, r) => s + num(r.failures), 0)

  // Tendencia semanal del ciclo total, con mediana por semana.
  const byWeek = new Map<string, number[]>()
  for (const r of cycleRows) {
    const at = r.merged_at
    if (typeof at !== 'string') continue
    const w = weekStart(at)
    const list = byWeek.get(w) ?? []
    const h = nullableNum(r.hours_total)
    if (h !== null) list.push(h)
    byWeek.set(w, list)
  }

  return {
    dora: {
      deploysPerWeek: weeksObserved > 0 ? totalDeploys / weeksObserved : null,
      medianLeadTimeHours: median(leadRows.map((r) => nullableNum(r.hours))),
      leadTimeBasis,
      changeFailureRate:
        totalDeploysForRate > 0 ? totalFailures / totalDeploysForRate : null,
      medianRestoreHours: median(
        ((restore.data ?? []) as Record<string, unknown>[]).map((r) =>
          nullableNum(r.hours),
        ),
      ),
    },
    cycle: {
      medianToFirstReview: median(
        cycleRows.map((r) => nullableNum(r.hours_to_first_review)),
      ),
      medianReviewToApproval: median(
        cycleRows.map((r) => nullableNum(r.hours_review_to_approval)),
      ),
      medianApprovalToMerge: median(
        cycleRows.map((r) => nullableNum(r.hours_approval_to_merge)),
      ),
      medianTotal: median(cycleRows.map((r) => nullableNum(r.hours_total))),
      weekly: [...byWeek.entries()]
        .map(([week, values]) => ({
          week,
          median: median(values) ?? 0,
          count: values.length,
        }))
        .sort((a, b) => a.week.localeCompare(b.week)),
    },
    wip: ((wip.data ?? []) as Record<string, unknown>[]).map((r) => ({
      day: String(r.day),
      open: num(r.open_prs),
    })),
    sizeBuckets: ((buckets.data ?? []) as Record<string, unknown>[])
      .map((r) => ({
        bucket: String(r.bucket),
        prs: num(r.prs),
        medianReviewHours: nullableNum(r.median_hours_to_review),
        medianMergeHours: nullableNum(r.median_hours_to_merge),
      }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket)),
    quality: ((quality.data ?? []) as Record<string, unknown>[]).map((r) => ({
      week: String(r.week),
      merged: num(r.merged),
      abandoned: num(r.abandoned),
      abandonRate: nullableNum(r.abandon_rate),
    })),
    churn: ((churn.data ?? []) as Record<string, unknown>[]).map((r) => ({
      week: String(r.week),
      touched: num(r.files_touched),
      reworked: num(r.files_reworked),
      rate: nullableNum(r.rework_rate),
    })),
    // Sin sal configurada no se recoge nada, y el panel debe decirlo en vez de
    // mostrar un cero que se leeria como "no hay retrabajo".
    churnEnabled: (churn.data ?? []).length > 0,
  }
}

// ---------------------------------------------------------------------------
// Revision y CI
// ---------------------------------------------------------------------------

export interface ReviewCiMetrics {
  reviewers: {
    display_name: string
    reviews: number
    approvals: number
    changesRequested: number
    comments: number
    commentsPerReview: number | null
  }[]
  pairs: { reviewer: string; author: string; reviews: number }[]
  rubberStamp: { week: string; approvals: number; withoutComments: number; rate: number | null }[]
  ci: {
    failureRate: number | null
    medianDurationSeconds: number | null
    weekly: { week: string; runs: number; failed: number; rate: number | null }[]
    byWorkflow: { name: string; runs: number; failureRate: number | null }[]
  }
  iterations: { medianRuns: number | null; medianFailed: number | null; worst: { repo: string; number: number; failed: number }[] }
  flaky: { repo: string; name: string; head_sha: string; failures: number; successes: number }[]
}

export async function loadReviewCi(windowDays = 90): Promise<ReviewCiMetrics> {
  const client = db()
  const since = daysAgo(windowDays)

  const [load, pairs, stamp, ci, iterations, flaky] = await Promise.all([
    client.from('v_review_load').select('*').gte('week', since),
    client.from('v_review_pairs').select('*').gte('last_review', since),
    client.from('v_rubber_stamp').select('*').gte('week', since),
    client.from('v_ci_health').select('*').gte('week', since),
    client.from('v_ci_iterations').select('*').gte('merged_at', since),
    client.from('v_flaky_ci').select('*').gte('last_seen', since).limit(20),
  ])

  // Agregar por persona: la vista viene por semana.
  const byPerson = new Map<
    string,
    { reviews: number; approvals: number; changesRequested: number; comments: number }
  >()
  for (const r of (load.data ?? []) as Record<string, unknown>[]) {
    const name = String(r.display_name)
    const cur = byPerson.get(name) ?? {
      reviews: 0,
      approvals: 0,
      changesRequested: 0,
      comments: 0,
    }
    cur.reviews += num(r.reviews)
    cur.approvals += num(r.approvals)
    cur.changesRequested += num(r.changes_requested)
    cur.comments += num(r.comments)
    byPerson.set(name, cur)
  }

  const ciRows = (ci.data ?? []) as Record<string, unknown>[]
  const totalRuns = ciRows.reduce((s, r) => s + num(r.runs), 0)
  const totalFailed = ciRows.reduce((s, r) => s + num(r.failed), 0)

  const ciByWeek = new Map<string, { runs: number; failed: number }>()
  const ciByWorkflow = new Map<string, { runs: number; failed: number }>()
  for (const r of ciRows) {
    const w = String(r.week)
    const cw = ciByWeek.get(w) ?? { runs: 0, failed: 0 }
    cw.runs += num(r.runs)
    cw.failed += num(r.failed)
    ciByWeek.set(w, cw)

    const name = r.name ? String(r.name) : '(sin nombre)'
    const cn = ciByWorkflow.get(name) ?? { runs: 0, failed: 0 }
    cn.runs += num(r.runs)
    cn.failed += num(r.failed)
    ciByWorkflow.set(name, cn)
  }

  const iterRows = (iterations.data ?? []) as Record<string, unknown>[]

  return {
    reviewers: [...byPerson.entries()]
      .map(([display_name, v]) => ({
        display_name,
        ...v,
        commentsPerReview: v.reviews > 0 ? v.comments / v.reviews : null,
      }))
      // Alfabetico: la carga de revision tampoco es un ranking.
      .sort((a, b) => a.display_name.localeCompare(b.display_name, 'es')),
    pairs: ((pairs.data ?? []) as Record<string, unknown>[])
      .map((r) => ({
        reviewer: String(r.reviewer_login),
        author: String(r.pr_author_login),
        reviews: num(r.reviews),
      }))
      .sort((a, b) => b.reviews - a.reviews)
      .slice(0, 20),
    rubberStamp: ((stamp.data ?? []) as Record<string, unknown>[]).map((r) => ({
      week: String(r.week),
      approvals: num(r.approvals),
      withoutComments: num(r.without_comments),
      rate: nullableNum(r.rate),
    })),
    ci: {
      failureRate: totalRuns > 0 ? totalFailed / totalRuns : null,
      medianDurationSeconds: median(
        ciRows.map((r) => nullableNum(r.median_duration_seconds)),
      ),
      weekly: [...ciByWeek.entries()]
        .map(([week, v]) => ({
          week,
          runs: v.runs,
          failed: v.failed,
          rate: v.runs > 0 ? v.failed / v.runs : null,
        }))
        .sort((a, b) => a.week.localeCompare(b.week)),
      byWorkflow: [...ciByWorkflow.entries()]
        .map(([name, v]) => ({
          name,
          runs: v.runs,
          failureRate: v.runs > 0 ? v.failed / v.runs : null,
        }))
        .sort((a, b) => b.runs - a.runs)
        .slice(0, 10),
    },
    iterations: {
      medianRuns: median(iterRows.map((r) => nullableNum(r.total_runs))),
      medianFailed: median(iterRows.map((r) => nullableNum(r.failed_runs))),
      worst: iterRows
        .map((r) => ({
          repo: String(r.repo),
          number: num(r.number),
          failed: num(r.failed_runs),
        }))
        .filter((r) => r.failed > 0)
        .sort((a, b) => b.failed - a.failed)
        .slice(0, 5),
    },
    flaky: ((flaky.data ?? []) as Record<string, unknown>[]).map((r) => ({
      repo: String(r.repo),
      name: r.name ? String(r.name) : '(sin nombre)',
      head_sha: String(r.head_sha),
      failures: num(r.failures),
      successes: num(r.successes),
    })),
  }
}

// ---------------------------------------------------------------------------
// IA y coste
// ---------------------------------------------------------------------------

export interface AiMetrics {
  totals: {
    claudeHours: number
    codexHours: number
    costUsd: number
    tokens: number
    sessions: number
    linesAdded: number
    acceptRate: number | null
  }
  costPerPr: { day: string; cost: number; merged: number; perPr: number | null }[]
  medianCostPerPr: number | null
  weeklyCost: { week: string; value: number }[]
  weeklyHours: { week: string; value: number }[]
  /** Adopcion: en cuantos de los ultimos 14 dias tuvo actividad cada persona. */
  adoption: { display_name: string; activeDays: number; ofDays: number }[]
}

export async function loadAi(windowDays = 90): Promise<AiMetrics> {
  const client = db()

  const [rollup, costPerPr, people] = await Promise.all([
    loadRollup(windowDays),
    client.from('v_cost_per_pr').select('*').gte('day', daysAgo(windowDays)),
    client.from('people').select('id, display_name').eq('active', true),
  ])

  const accepted = rollup.reduce((s, r) => s + num(r.edits_accepted), 0)
  const rejected = rollup.reduce((s, r) => s + num(r.edits_rejected), 0)

  const perPrRows = ((costPerPr.data ?? []) as Record<string, unknown>[]).map((r) => ({
    day: String(r.day),
    cost: num(r.cost_usd),
    merged: num(r.prs_merged),
    perPr: nullableNum(r.cost_per_pr),
  }))

  const byWeekCost = new Map<string, number>()
  const byWeekHours = new Map<string, number>()
  for (const r of rollup) {
    const w = weekStart(r.day)
    byWeekCost.set(w, (byWeekCost.get(w) ?? 0) + num(r.cost_usd))
    byWeekHours.set(
      w,
      (byWeekHours.get(w) ?? 0) +
        (num(r.claude_seconds) + num(r.codex_seconds_est)) / 3600,
    )
  }

  // Adopcion en los ultimos 14 dias: dias con cualquier actividad de herramienta.
  const recentCutoff = daysAgo(14)
  const activeDays = new Map<string, Set<string>>()
  for (const r of rollup) {
    if (r.day < recentCutoff) continue
    if (num(r.claude_seconds) + num(r.codex_seconds_est) <= 0) continue
    const set = activeDays.get(r.person_id) ?? new Set<string>()
    set.add(r.day)
    activeDays.set(r.person_id, set)
  }

  return {
    totals: {
      claudeHours: rollup.reduce((s, r) => s + num(r.claude_seconds), 0) / 3600,
      codexHours: rollup.reduce((s, r) => s + num(r.codex_seconds_est), 0) / 3600,
      costUsd: rollup.reduce((s, r) => s + num(r.cost_usd), 0),
      tokens: rollup.reduce((s, r) => s + num(r.tokens), 0),
      sessions: rollup.reduce((s, r) => s + num(r.sessions), 0),
      linesAdded: rollup.reduce((s, r) => s + num(r.lines_added), 0),
      acceptRate: accepted + rejected > 0 ? accepted / (accepted + rejected) : null,
    },
    costPerPr: perPrRows,
    // Mediana, no total/total: un dia con muchos merges y poco coste no debe
    // ocultar semanas caras.
    medianCostPerPr: median(perPrRows.map((r) => r.perPr)),
    weeklyCost: [...byWeekCost.entries()]
      .map(([week, value]) => ({ week, value }))
      .sort((a, b) => a.week.localeCompare(b.week)),
    weeklyHours: [...byWeekHours.entries()]
      .map(([week, value]) => ({ week, value }))
      .sort((a, b) => a.week.localeCompare(b.week)),
    adoption: ((people.data ?? []) as unknown as { id: string; display_name: string }[])
      .map((p) => ({
        display_name: p.display_name,
        activeDays: activeDays.get(p.id)?.size ?? 0,
        ofDays: 14,
      }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name, 'es')),
  }
}

// ---------------------------------------------------------------------------
// Proyecciones
// ---------------------------------------------------------------------------

export interface Forecasts {
  throughput: ThroughputForecast | null
  completion: CompletionForecast | null
  cost: CostProjection | null
  cycleTrend: Trend | null
  throughputTrend: Trend | null
  weeklyMerges: { week: string; value: number }[]
  weeklyCycleMedian: { week: string; value: number }[]
}

/**
 * Proyecciones sobre 26 semanas de historia. Cada funcion devuelve null si no hay
 * base suficiente, y el panel lo dice en vez de dibujar una linea inventada.
 */
export async function loadForecasts(): Promise<Forecasts> {
  const windowDays = 26 * 7
  const [rollup, delivery] = await Promise.all([
    loadRollup(windowDays),
    loadDelivery(windowDays),
  ])

  const mergesByWeek = new Map<string, number>()
  const costByDay = new Map<string, number>()
  for (const r of rollup) {
    const w = weekStart(r.day)
    mergesByWeek.set(w, (mergesByWeek.get(w) ?? 0) + num(r.prs_merged))
    costByDay.set(r.day, (costByDay.get(r.day) ?? 0) + num(r.cost_usd))
  }

  const weeklyMerges = [...mergesByWeek.entries()]
    .map(([week, value]) => ({ week, value }))
    .sort((a, b) => a.week.localeCompare(b.week))

  const weeklyCycleMedian = delivery.cycle.weekly.map((w) => ({
    week: w.week,
    value: w.median,
  }))

  const counts = weeklyMerges.map((w) => w.value)

  return {
    throughput: forecastThroughput(counts, 4),
    // Un objetivo de 20 PRs es un ejemplo util por defecto; el panel deja cambiarlo.
    completion: forecastCompletion(counts, 20),
    cost: projectMonthlyCost(
      [...costByDay.entries()].map(([day, cost]) => ({ day, cost })),
    ),
    // En tiempo de ciclo, bajar es mejorar.
    cycleTrend: linearTrend(
      weeklyCycleMedian.map((w) => w.value),
      { lowerIsBetter: true },
    ),
    // En throughput, subir es mejorar.
    throughputTrend: linearTrend(counts, { lowerIsBetter: false }),
    weeklyMerges,
    weeklyCycleMedian,
  }
}
