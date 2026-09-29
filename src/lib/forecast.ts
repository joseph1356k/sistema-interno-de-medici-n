/**
 * Proyecciones.
 *
 * Principio que atraviesa el archivo: **mejor no proyectar que proyectar mal**.
 * Con pocos datos las funciones devuelven `null` y el panel dice que no hay base
 * suficiente, en vez de dibujar una linea que parece informacion y no lo es.
 *
 * El throughput se proyecta por Monte Carlo sobre semanas reales, no con una
 * media. Una media dice "4 PRs por semana" y sugiere un plan; la realidad fue
 * 1, 9, 2, 7, 0, 5, y esa variabilidad es justo lo que hay que comunicar. Es el
 * metodo estandar de prevision agil por ese motivo.
 */

/** Semanas minimas para proyectar. Por debajo, no hay variabilidad que muestrear. */
export const MIN_WEEKS = 6

/** Semanas que se usan como base del muestreo. */
export const SAMPLE_WEEKS = 12

const DEFAULT_TRIALS = 10_000

/**
 * PRNG con semilla (mulberry32). Existe para que los tests sean deterministas: un
 * Monte Carlo con Math.random no se puede verificar.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Percentil por interpolacion lineal sobre una muestra ya ordenada. */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  if (sorted.length === 1) return sorted[0]!
  const pos = (sorted.length - 1) * Math.min(Math.max(p, 0), 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

export interface ThroughputForecast {
  /** Semanas de historia usadas. */
  basedOnWeeks: number
  weeksAhead: number
  /**
   * "Con este nivel de confianza, al menos esta cantidad." Confianza mas alta =
   * cantidad mas baja, porque es una promesa mas segura. Confundir la direccion
   * es el error clasico de estas previsiones.
   */
  atLeast: { p50: number; p85: number; p95: number }
  /** Media de las simulaciones, solo como referencia. Nunca es la promesa. */
  mean: number
}

/**
 * Cuantos PRs se mergearan en las proximas `weeksAhead` semanas.
 *
 * Muestrea con reemplazo semanas reales del historico. Devuelve null si no hay
 * al menos MIN_WEEKS semanas.
 */
export function forecastThroughput(
  weeklyCounts: number[],
  weeksAhead = 4,
  options: { trials?: number; rng?: () => number } = {},
): ThroughputForecast | null {
  const sample = weeklyCounts.filter((n) => Number.isFinite(n) && n >= 0)
  if (sample.length < MIN_WEEKS) return null
  if (weeksAhead < 1) return null

  const trials = options.trials ?? DEFAULT_TRIALS
  const rng = options.rng ?? Math.random
  const base = sample.slice(-SAMPLE_WEEKS)

  const totals = new Array<number>(trials)
  for (let i = 0; i < trials; i++) {
    let total = 0
    for (let w = 0; w < weeksAhead; w++) {
      total += base[Math.floor(rng() * base.length)]!
    }
    totals[i] = total
  }
  totals.sort((a, b) => a - b)

  return {
    basedOnWeeks: base.length,
    weeksAhead,
    // "95% de confianza de al menos X" es el percentil 5 de la distribucion: en
    // el 95% de los escenarios se hizo esa cantidad o mas.
    atLeast: {
      p50: Math.floor(quantile(totals, 0.5)),
      p85: Math.floor(quantile(totals, 0.15)),
      p95: Math.floor(quantile(totals, 0.05)),
    },
    mean: totals.reduce((s, n) => s + n, 0) / trials,
  }
}

export interface CompletionForecast {
  basedOnWeeks: number
  items: number
  /**
   * "Con este nivel de confianza, terminado en como maximo estas semanas." Aqui la
   * confianza mas alta da MAS semanas, al contrario que en `atLeast`.
   */
  withinWeeks: { p50: number; p85: number; p95: number }
}

/**
 * Cuanto se tarda en mergear `items` PRs.
 *
 * Devuelve null si el historico no da o si todas las semanas son cero: sin
 * throughput no hay fecha, y devolver un numero enorme seria peor que no dar nada.
 */
export function forecastCompletion(
  weeklyCounts: number[],
  items: number,
  options: { trials?: number; rng?: () => number; maxWeeks?: number } = {},
): CompletionForecast | null {
  const sample = weeklyCounts.filter((n) => Number.isFinite(n) && n >= 0)
  if (sample.length < MIN_WEEKS || items <= 0) return null

  const base = sample.slice(-SAMPLE_WEEKS)
  if (base.every((n) => n === 0)) return null

  const trials = options.trials ?? DEFAULT_TRIALS
  const maxWeeks = options.maxWeeks ?? 260
  const rng = options.rng ?? Math.random

  const weeks = new Array<number>(trials)
  for (let i = 0; i < trials; i++) {
    let done = 0
    let w = 0
    while (done < items && w < maxWeeks) {
      done += base[Math.floor(rng() * base.length)]!
      w++
    }
    weeks[i] = w
  }
  weeks.sort((a, b) => a - b)

  return {
    basedOnWeeks: base.length,
    items,
    withinWeeks: {
      p50: Math.ceil(quantile(weeks, 0.5)),
      p85: Math.ceil(quantile(weeks, 0.85)),
      p95: Math.ceil(quantile(weeks, 0.95)),
    },
  }
}

export interface CostProjection {
  monthToDate: number
  daysElapsed: number
  daysInMonth: number
  projectedMonthEnd: number
  /** Meses anteriores completos, para contexto. Sin esto el numero no dice nada. */
  previousMonths: { month: string; cost: number }[]
}

/**
 * Coste proyectado a cierre de mes por ritmo de gasto.
 *
 * Se exige al menos 3 dias transcurridos: proyectar el mes desde el dia 1
 * multiplica por 30 cualquier anomalia.
 */
export function projectMonthlyCost(
  dailyCosts: { day: string; cost: number }[],
  now = new Date(),
): CostProjection | null {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const daysElapsed = now.getUTCDate()

  if (daysElapsed < 3) return null

  const prefix = `${year}-${String(month + 1).padStart(2, '0')}`
  const monthToDate = dailyCosts
    .filter((d) => d.day.startsWith(prefix))
    .reduce((s, d) => s + d.cost, 0)

  const byMonth = new Map<string, number>()
  for (const d of dailyCosts) {
    const key = d.day.slice(0, 7)
    if (key === prefix) continue
    byMonth.set(key, (byMonth.get(key) ?? 0) + d.cost)
  }

  return {
    monthToDate,
    daysElapsed,
    daysInMonth,
    projectedMonthEnd: (monthToDate / daysElapsed) * daysInMonth,
    previousMonths: [...byMonth.entries()]
      .map(([month, cost]) => ({ month, cost }))
      .sort((a, b) => b.month.localeCompare(a.month))
      .slice(0, 3),
  }
}

export type TrendDirection = 'improving' | 'worsening' | 'unclear'

export interface Trend {
  /** Cambio por semana en las unidades de la serie. */
  slopePerWeek: number
  r2: number
  direction: TrendDirection
  points: number
}

/**
 * R2 minimo para afirmar una direccion. Por debajo, la recta no describe los
 * datos y decir "mejorando" seria inventarse una conclusion.
 */
export const MIN_R2 = 0.3

/**
 * Ajuste lineal sobre una serie semanal.
 *
 * `lowerIsBetter` porque en tiempo de ciclo bajar es mejorar, y en throughput es
 * al contrario; sin el parametro la palabra "mejorando" no significa nada.
 */
export function linearTrend(
  values: number[],
  options: { lowerIsBetter?: boolean } = {},
): Trend | null {
  const ys = values.filter((n) => Number.isFinite(n))
  if (ys.length < MIN_WEEKS) return null

  const n = ys.length
  const xs = ys.map((_, i) => i)
  const meanX = xs.reduce((s, x) => s + x, 0) / n
  const meanY = ys.reduce((s, y) => s + y, 0) / n

  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX
    const dy = ys[i]! - meanY
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }

  if (sxx === 0) return null

  const slope = sxy / sxx
  // Serie plana: la recta la describe perfectamente, pero no hay tendencia.
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy)

  const lowerIsBetter = options.lowerIsBetter ?? true
  let direction: TrendDirection = 'unclear'
  if (r2 >= MIN_R2 && slope !== 0) {
    const better = lowerIsBetter ? slope < 0 : slope > 0
    direction = better ? 'improving' : 'worsening'
  }

  return { slopePerWeek: slope, r2, direction, points: n }
}
