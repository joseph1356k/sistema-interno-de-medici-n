/**
 * Consultas por persona y resumen de equipo.
 *
 * Dos reglas que atraviesan el archivo:
 *
 *  - **Se lee de `daily_rollup`, no de las tablas crudas.** Agregar `tool_metrics`
 *    para pintar meses de historia no escala, y el panel se refresca solo.
 *  - **Las agregaciones usan MEDIANA, no promedio.** Un fin de semana, unas
 *    vacaciones o un push nocturno desplazan el promedio hasta volverlo inutil.
 */

import { db } from './db'

export interface PersonRow {
  person_id: string
  display_name: string
  claude_hours: number
  codex_hours_est: number
  sessions: number
  pushes: number
  commits: number
  prs_opened: number
  prs_merged: number
  reviews_given: number
  review_comments: number
  accept_rate: number | null
  cost_usd: number
  lines_added: number
  lines_removed: number
}

export interface DeviceHealthRow {
  hostname: string
  display_name: string | null
  last_seen: string | null
  hours_since_last_seen: number | null
  claude_reporting: boolean
  codex_reporting: boolean
}

interface RollupRow {
  person_id: string
  day: string
  claude_seconds: number
  codex_seconds_est: number
  sessions: number
  tokens: number
  cost_usd: number
  edits_accepted: number
  edits_rejected: number
  lines_added: number
  lines_removed: number
  pushes: number
  commits: number
  prs_opened: number
  prs_merged: number
  reviews_given: number
  review_comments: number
}

/** Mediana de una lista de numeros, ignorando nulos. No muta la entrada. */
export function median(values: (number | null | undefined)[]): number | null {
  const clean = values
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b)
  if (clean.length === 0) return null
  const mid = Math.floor(clean.length / 2)
  return clean.length % 2 === 1 ? clean[mid]! : (clean[mid - 1]! + clean[mid]!) / 2
}

export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
}

/** Lunes de la semana ISO de una fecha, como YYYY-MM-DD. */
export function weekStart(iso: string): string {
  const d = new Date(iso)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}

/** Filas de rollup del periodo, crudas. Base de casi todo lo demas. */
export async function loadRollup(windowDays: number): Promise<RollupRow[]> {
  const { data } = await db()
    .from('daily_rollup')
    .select('*')
    .gte('day', daysAgo(windowDays))
    .order('day')
  return (data ?? []) as unknown as RollupRow[]
}

export async function loadPeople(windowDays = 30): Promise<PersonRow[]> {
  const client = db()

  const [rollup, people] = await Promise.all([
    loadRollup(windowDays),
    client.from('people').select('id, display_name').eq('active', true),
  ])

  const byId = new Map<string, PersonRow>()

  // Toda persona activa aparece, aunque no tenga datos. Una fila en cero es
  // informacion; una fila ausente parece un fallo del sistema.
  for (const p of (people.data ?? []) as unknown as { id: string; display_name: string }[]) {
    byId.set(p.id, {
      person_id: p.id,
      display_name: p.display_name,
      claude_hours: 0,
      codex_hours_est: 0,
      sessions: 0,
      pushes: 0,
      commits: 0,
      prs_opened: 0,
      prs_merged: 0,
      reviews_given: 0,
      review_comments: 0,
      accept_rate: null,
      cost_usd: 0,
      lines_added: 0,
      lines_removed: 0,
    })
  }

  // La tasa de aceptacion se recalcula desde los totales del periodo. Promediar
  // tasas diarias daria el mismo peso a un dia de 2 ediciones y a uno de 200.
  const edits = new Map<string, { accepted: number; rejected: number }>()

  for (const r of rollup) {
    const row = byId.get(r.person_id)
    if (!row) continue

    row.claude_hours += (Number(r.claude_seconds) || 0) / 3600
    row.codex_hours_est += (Number(r.codex_seconds_est) || 0) / 3600
    row.sessions += Number(r.sessions) || 0
    row.pushes += Number(r.pushes) || 0
    row.commits += Number(r.commits) || 0
    row.prs_opened += Number(r.prs_opened) || 0
    row.prs_merged += Number(r.prs_merged) || 0
    row.reviews_given += Number(r.reviews_given) || 0
    row.review_comments += Number(r.review_comments) || 0
    row.cost_usd += Number(r.cost_usd) || 0
    row.lines_added += Number(r.lines_added) || 0
    row.lines_removed += Number(r.lines_removed) || 0

    const e = edits.get(r.person_id) ?? { accepted: 0, rejected: 0 }
    e.accepted += Number(r.edits_accepted) || 0
    e.rejected += Number(r.edits_rejected) || 0
    edits.set(r.person_id, e)
  }

  for (const [id, e] of edits) {
    const total = e.accepted + e.rejected
    const row = byId.get(id)
    if (row && total > 0) row.accept_rate = e.accepted / total
  }

  // Orden ALFABETICO a proposito. Ordenar por horas o por push convertiria la
  // tabla en un ranking, y este sistema no es para eso.
  return [...byId.values()].sort((a, b) =>
    a.display_name.localeCompare(b.display_name, 'es'),
  )
}

export async function loadDeviceHealth(): Promise<DeviceHealthRow[]> {
  const { data } = await db().from('v_device_health').select('*')
  return ((data ?? []) as unknown as DeviceHealthRow[]).sort((a, b) =>
    a.hostname.localeCompare(b.hostname),
  )
}

export async function loadUnmappedActivity(): Promise<
  { identity: string; events: number; last_seen: string }[]
> {
  const { data } = await db().from('v_unmapped_git_activity').select('*').limit(20)
  return (data ?? []) as unknown as {
    identity: string
    events: number
    last_seen: string
  }[]
}

/** Serie semanal de un campo del rollup, sumado a nivel de equipo. */
export function weeklySeries(
  rollup: RollupRow[],
  field: keyof RollupRow,
): { week: string; value: number }[] {
  const byWeek = new Map<string, number>()
  for (const r of rollup) {
    const w = weekStart(r.day)
    byWeek.set(w, (byWeek.get(w) ?? 0) + (Number(r[field]) || 0))
  }
  return [...byWeek.entries()]
    .map(([week, value]) => ({ week, value }))
    .sort((a, b) => a.week.localeCompare(b.week))
}
