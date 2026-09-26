/**
 * Consultas del panel.
 *
 * Regla de lectura que atraviesa todo este archivo: las agregaciones por persona
 * usan MEDIANA, no promedio. Un fin de semana, unas vacaciones o un push nocturno
 * desplazan el promedio hasta volverlo inutil.
 */

import { db } from './db'

export interface PersonRow {
  person_id: string | null
  display_name: string
  claude_hours: number
  codex_hours_est: number
  sessions: number
  pushes: number
  commits: number
  prs_merged: number
  accept_rate: number | null
  cost_usd: number
}

export interface DeviceHealthRow {
  hostname: string
  display_name: string | null
  last_seen: string | null
  hours_since_last_seen: number | null
  claude_reporting: boolean
  codex_reporting: boolean
}

export interface TeamSummary {
  windowDays: number
  peopleReporting: number
  devicesTotal: number
  devicesQuiet: number
  claudeHours: number
  codexHoursEst: number
  costUsd: number
  medianPushIntervalHours: number | null
  medianMergeHours: number | null
  medianFirstReviewHours: number | null
  openToMergeTrend: { week: string; medianHours: number; count: number }[]
  unmappedIdentities: { identity: string; events: number }[]
}

/** Mediana de una lista de numeros, ignorando nulos. */
export function median(values: (number | null | undefined)[]): number | null {
  const clean = values
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b)
  if (clean.length === 0) return null
  const mid = Math.floor(clean.length / 2)
  return clean.length % 2 === 1
    ? clean[mid]!
    : (clean[mid - 1]! + clean[mid]!) / 2
}

/** Agrupa por clave y devuelve un Map. */
function groupBy<T, K extends string>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const row of rows) {
    const k = key(row)
    const list = out.get(k)
    if (list) list.push(row)
    else out.set(k, [row])
  }
  return out
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString()
}

/** Lunes de la semana ISO de una fecha, como YYYY-MM-DD. */
function weekStart(iso: string): string {
  const d = new Date(iso)
  const day = (d.getUTCDay() + 6) % 7 // lunes = 0
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}

export async function loadPeople(windowDays = 30): Promise<PersonRow[]> {
  const since = isoDaysAgo(windowDays)
  const sinceDay = since.slice(0, 10)
  const client = db()

  const [claude, codex, git, cost, accept, people] = await Promise.all([
    client.from('v_claude_active_time').select('*').gte('day', sinceDay),
    client.from('v_codex_estimated_time').select('*').gte('day', sinceDay),
    client.from('v_daily_git').select('*').gte('day', sinceDay),
    client.from('v_daily_cost').select('*').gte('day', sinceDay),
    client.from('v_edit_acceptance').select('*').gte('day', sinceDay),
    client.from('people').select('id, display_name, active').eq('active', true),
  ])

  const byId = new Map<string, PersonRow>()
  const ensure = (id: string | null, name: string): PersonRow => {
    const key = id ?? `sin-asignar:${name}`
    let row = byId.get(key)
    if (!row) {
      row = {
        person_id: id,
        display_name: name,
        claude_hours: 0,
        codex_hours_est: 0,
        sessions: 0,
        pushes: 0,
        commits: 0,
        prs_merged: 0,
        accept_rate: null,
        cost_usd: 0,
      }
      byId.set(key, row)
    }
    return row
  }

  // Todas las personas activas aparecen, aunque no tengan datos. Una fila en
  // cero es informacion; una fila ausente parece un fallo del sistema.
  for (const p of people.data ?? []) ensure(p.id as string, p.display_name as string)

  for (const r of claude.data ?? []) {
    ensure(r.person_id, r.display_name).claude_hours +=
      (Number(r.total_seconds) || 0) / 3600
  }
  for (const r of codex.data ?? []) {
    const row = ensure(r.person_id, r.display_name)
    row.codex_hours_est += (Number(r.estimated_seconds) || 0) / 3600
    row.sessions += Number(r.sessions) || 0
  }
  for (const r of git.data ?? []) {
    const row = ensure(r.person_id, r.display_name)
    row.pushes += Number(r.pushes) || 0
    row.commits += Number(r.commits) || 0
    row.prs_merged += Number(r.prs_merged) || 0
  }
  for (const r of cost.data ?? []) {
    ensure(r.person_id, r.display_name).cost_usd += Number(r.cost_usd) || 0
  }

  // La tasa de aceptacion se recalcula desde los totales del periodo: promediar
  // tasas diarias daria el mismo peso a un dia de 2 ediciones y a uno de 200.
  const acceptByPerson = groupBy(accept.data ?? [], (r) => String(r.person_id))
  for (const [, rows] of acceptByPerson) {
    const first = rows[0]!
    const accepted = rows.reduce((s, r) => s + (Number(r.accepted) || 0), 0)
    const rejected = rows.reduce((s, r) => s + (Number(r.rejected) || 0), 0)
    const total = accepted + rejected
    if (total > 0) {
      ensure(first.person_id, first.display_name).accept_rate = accepted / total
    }
  }

  // Orden ALFABETICO a proposito, no por ninguna metrica. Ordenar por horas o
  // por push convierte la tabla en un ranking, y este sistema no es para eso.
  return [...byId.values()].sort((a, b) =>
    a.display_name.localeCompare(b.display_name, 'es'),
  )
}

export async function loadTeamSummary(windowDays = 30): Promise<TeamSummary> {
  const since = isoDaysAgo(windowDays)
  const client = db()

  const [intervals, cycles, health, unmapped, people] = await Promise.all([
    client.from('v_push_intervals').select('*').gte('occurred_at', since),
    client.from('v_pr_cycle_time').select('*').gte('pr_merged_at', since),
    client.from('v_device_health').select('*'),
    client.from('v_unmapped_git_activity').select('*').limit(10),
    loadPeople(windowDays),
  ])

  const cycleRows = cycles.data ?? []

  // Tendencia semanal del tiempo de apertura a merge: es la metrica que de
  // verdad dice si el proceso mejora, y es de equipo, no de persona.
  const byWeek = groupBy(
    cycleRows.filter((r) => r.pr_merged_at),
    (r) => weekStart(String(r.pr_merged_at)),
  )
  const openToMergeTrend = [...byWeek.entries()]
    .map(([week, rows]) => ({
      week,
      medianHours: median(rows.map((r) => Number(r.hours_open_to_merge))) ?? 0,
      count: rows.length,
    }))
    .sort((a, b) => a.week.localeCompare(b.week))

  const healthRows = (health.data ?? []) as DeviceHealthRow[]

  return {
    windowDays,
    peopleReporting: people.filter((p) => p.claude_hours + p.codex_hours_est > 0).length,
    devicesTotal: healthRows.length,
    devicesQuiet: healthRows.filter((d) => !d.claude_reporting && !d.codex_reporting)
      .length,
    claudeHours: people.reduce((s, p) => s + p.claude_hours, 0),
    codexHoursEst: people.reduce((s, p) => s + p.codex_hours_est, 0),
    costUsd: people.reduce((s, p) => s + p.cost_usd, 0),
    medianPushIntervalHours: median(
      (intervals.data ?? []).map((r) => Number(r.hours_since_previous_push)),
    ),
    medianMergeHours: median(cycleRows.map((r) => Number(r.hours_open_to_merge))),
    medianFirstReviewHours: median(
      cycleRows.map((r) => Number(r.hours_to_first_review)),
    ),
    openToMergeTrend,
    unmappedIdentities: (unmapped.data ?? []).map((r) => ({
      identity: String(r.identity),
      events: Number(r.events) || 0,
    })),
  }
}

export async function loadDeviceHealth(): Promise<DeviceHealthRow[]> {
  const { data } = await db().from('v_device_health').select('*')
  return ((data ?? []) as DeviceHealthRow[]).sort((a, b) =>
    a.hostname.localeCompare(b.hostname),
  )
}
