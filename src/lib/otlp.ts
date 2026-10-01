/**
 * Parser de OTLP/HTTP en JSON.
 *
 * Claude Code soporta OTEL_EXPORTER_OTLP_PROTOCOL=http/json y Codex
 * `protocol = "json"`, asi que no hace falta un servidor OTel central: una ruta
 * de Next.js puede recibir el payload directamente.
 *
 * Todo lo que sale de aqui ya paso por la allowlist de src/lib/allowlist.ts.
 */

import { createHash } from 'node:crypto'
import {
  EVENT_ATTRS,
  METRIC_ATTRS,
  RESOURCE_ATTRS,
  filterAttrs,
  safeHostname,
  safeSessionId,
  type AttrValue,
} from './allowlist'

export type ToolKind = 'claude_code' | 'codex'

export interface MetricRow {
  dedup_key: string
  hostname: string
  tool: ToolKind
  service_name: string | null
  metric: string
  value: number
  unit: string | null
  attrs: Record<string, AttrValue>
  observed_at: string
}

export interface EventRow {
  dedup_key: string
  hostname: string
  tool: ToolKind
  service_name: string | null
  event_name: string
  session_id: string | null
  attrs: Record<string, AttrValue>
  occurred_at: string
}

/** Por que se descarto un punto. Se devuelve desglosado para poder diagnosticar. */
export interface Rejections {
  /** Sin `host.name` valido: no hay a quien atribuirlo. */
  no_host: number
  /** Marca de tiempo fuera de rango: casi siempre un PC con el reloj mal. */
  bad_time: number
  /** Valor imposible: negativo, o una duracion mayor que un dia en un solo punto. */
  bad_value: number
}

export interface ParseResult {
  metrics: MetricRow[]
  events: EventRow[]
  /** Total descartado. El desglose esta en `rejected`. */
  dropped: number
  rejected: Rejections
}

/**
 * Ventana de tiempo aceptada.
 *
 * Hacia el futuro, un dia de margen: cubre cualquier desfase de reloj normal, y
 * un dato con fecha de la semana que viene contaminaria el rollup de un dia que
 * aun no ha pasado.
 *
 * Hacia el pasado, 14 dias: el collector deja de reintentar a las 24 horas, asi
 * que un dato real nunca llega con mas de un par de dias de retraso. Algo mas
 * viejo es un reloj mal puesto, y aceptarlo reescribiria dias ya cerrados.
 */
export const MAX_FUTURE_MS = 24 * 3_600_000
export const MAX_AGE_MS = 14 * 24 * 3_600_000

/**
 * Tope por punto para metricas de duracion. La temporalidad es `delta` y se
 * exporta cada 60 s, asi que un solo punto con mas de un dia de tiempo activo no
 * es un dato raro: es un dato roto.
 */
export const MAX_SECONDS_PER_POINT = 86_400

const DURATION_METRICS = new Set(['claude_code.active_time.total'])

/** JSON con claves ordenadas, para que el mismo conjunto de atributos de la misma clave. */
function canonical(attrs: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(attrs)
      .sort()
      .map((k) => [k, attrs[k]]),
  )
}

/**
 * Clave de deduplicacion de un punto.
 *
 * El collector reintenta un lote durante hasta 24 horas si no recibe respuesta, y
 * un reintento puede llegar aunque el servidor YA hubiera guardado el lote (por
 * ejemplo, si la respuesta se perdio por un corte de red). Sin esta clave, cada
 * reintento sumaba otra vez el mismo tiempo activo y el mismo coste.
 *
 * Con temporalidad delta, cada punto de cada serie cubre una ventana
 * [inicio, fin] unica, asi que (equipo, metrica, atributos, ventana) identifica el
 * punto sin ambiguedad. Se usan los nanosegundos crudos, no la fecha ISO, que
 * pierde precision.
 */
export function pointKey(parts: (string | number | null | undefined)[]): string {
  return createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('|'))
    .digest('hex')
    .slice(0, 40)
}

type TimeCheck = 'ok' | 'bad'

function checkTime(iso: string, now: number): TimeCheck {
  const t = Date.parse(iso)
  if (t > now + MAX_FUTURE_MS) return 'bad'
  if (t < now - MAX_AGE_MS) return 'bad'
  return 'ok'
}

function emptyRejections(): Rejections {
  return { no_host: 0, bad_time: 0, bad_value: 0 }
}

/** Un valor de atributo en OTLP JSON (AnyValue). */
interface OtlpAnyValue {
  stringValue?: string
  boolValue?: boolean
  intValue?: string | number
  doubleValue?: number
  arrayValue?: unknown
  kvlistValue?: unknown
  bytesValue?: unknown
}

interface OtlpKeyValue {
  key?: string
  value?: OtlpAnyValue
}

/**
 * Aplana la lista de atributos de OTLP a un objeto. Solo desempaqueta los tipos
 * escalares: array, kvlist y bytes se dejan como undefined a proposito, para que
 * `filterAttrs` los descarte (podrian contener contenido estructurado).
 */
export function flattenAttributes(
  list: OtlpKeyValue[] | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!Array.isArray(list)) return out

  for (const item of list) {
    const key = item?.key
    if (typeof key !== 'string') continue
    const v = item.value
    if (!v || typeof v !== 'object') continue

    if (typeof v.stringValue === 'string') out[key] = v.stringValue
    else if (typeof v.boolValue === 'boolean') out[key] = v.boolValue
    else if (typeof v.doubleValue === 'number') out[key] = v.doubleValue
    else if (v.intValue !== undefined) {
      const n = Number(v.intValue)
      if (Number.isFinite(n)) out[key] = n
    }
  }

  return out
}

/** Nanosegundos Unix (que OTLP manda como string) a ISO-8601. */
export function nanosToIso(nanos: unknown): string | null {
  if (nanos === undefined || nanos === null) return null
  const n = typeof nanos === 'string' ? Number(nanos) : Number(nanos)
  if (!Number.isFinite(n) || n <= 0) return null
  const ms = Math.floor(n / 1e6)
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/** Deduce la herramienta a partir del nombre de metrica/evento o del servicio. */
export function detectTool(name: string, serviceName: string | null): ToolKind | null {
  if (name.startsWith('claude_code.')) return 'claude_code'
  if (name.startsWith('codex.')) return 'codex'
  if (serviceName?.startsWith('claude-code')) return 'claude_code'
  if (serviceName?.startsWith('codex')) return 'codex'
  return null
}

interface ResourceContext {
  hostname: string | null
  serviceName: string | null
  resourceAttrs: Record<string, AttrValue>
}

function readResource(resource: unknown): ResourceContext {
  const raw = flattenAttributes(
    (resource as { attributes?: OtlpKeyValue[] } | undefined)?.attributes,
  )
  const attrs = filterAttrs(raw, RESOURCE_ATTRS)
  const serviceName =
    typeof attrs['service.name'] === 'string' ? attrs['service.name'] : null
  return {
    hostname: safeHostname(attrs['host.name']),
    serviceName,
    resourceAttrs: attrs,
  }
}

/** Extrae los data points de cualquiera de las formas de metrica de OTLP. */
function dataPointsOf(metric: Record<string, unknown>): Record<string, unknown>[] {
  for (const kind of ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary']) {
    const holder = metric[kind] as { dataPoints?: unknown } | undefined
    if (holder && Array.isArray(holder.dataPoints)) {
      return holder.dataPoints as Record<string, unknown>[]
    }
  }
  return []
}

/** Valor numerico de un data point, sea contador, gauge o histograma. */
function valueOf(point: Record<string, unknown>): number | null {
  if (typeof point.asDouble === 'number' && Number.isFinite(point.asDouble)) {
    return point.asDouble
  }
  if (point.asInt !== undefined) {
    const n = Number(point.asInt)
    if (Number.isFinite(n)) return n
  }
  // Histograma: se guarda la suma, que es lo unico agregable aqui.
  if (typeof point.sum === 'number' && Number.isFinite(point.sum)) return point.sum
  return null
}

export function parseMetrics(
  payload: unknown,
  now: number = Date.now(),
): { rows: MetricRow[]; rejected: Rejections } {
  const rows: MetricRow[] = []
  const rejected = emptyRejections()

  const resourceMetrics =
    (payload as { resourceMetrics?: unknown[] } | undefined)?.resourceMetrics
  if (!Array.isArray(resourceMetrics)) return { rows, rejected }

  for (const rm of resourceMetrics) {
    const ctx = readResource((rm as { resource?: unknown }).resource)
    const scopes = (rm as { scopeMetrics?: unknown[] }).scopeMetrics
    if (!Array.isArray(scopes)) continue

    for (const scope of scopes) {
      const metrics = (scope as { metrics?: unknown[] }).metrics
      if (!Array.isArray(metrics)) continue

      for (const raw of metrics) {
        const metric = raw as Record<string, unknown>
        const name = typeof metric.name === 'string' ? metric.name : null
        if (!name) continue

        const tool = detectTool(name, ctx.serviceName)
        if (!tool) continue

        for (const point of dataPointsOf(metric)) {
          const value = valueOf(point)
          const observedAt =
            nanosToIso(point.timeUnixNano) ?? nanosToIso(point.startTimeUnixNano)
          if (value === null || !observedAt) continue

          // Sin hostname no se puede atribuir: se cuenta y se descarta, en vez
          // de guardarse en un cajon anonimo que nadie revisa.
          if (!ctx.hostname) {
            rejected.no_host++
            continue
          }

          if (checkTime(observedAt, now) === 'bad') {
            rejected.bad_time++
            continue
          }

          // Contadores delta, costes y tokens no pueden ser negativos.
          if (value < 0 || (DURATION_METRICS.has(name) && value > MAX_SECONDS_PER_POINT)) {
            rejected.bad_value++
            continue
          }

          const pointAttrs = flattenAttributes(point.attributes as OtlpKeyValue[])
          const attrs = filterAttrs(pointAttrs, METRIC_ATTRS)
          rows.push({
            dedup_key: pointKey([
              'm',
              ctx.hostname,
              name,
              String(point.startTimeUnixNano ?? ''),
              String(point.timeUnixNano ?? ''),
              canonical(attrs),
            ]),
            hostname: ctx.hostname,
            tool,
            service_name: ctx.serviceName,
            metric: name,
            value,
            unit: typeof metric.unit === 'string' ? metric.unit : null,
            attrs,
            observed_at: observedAt,
          })
        }
      }
    }
  }

  return { rows, rejected }
}

/** Nombre del evento: puede venir como atributo o en el cuerpo del log record. */
function eventNameOf(
  record: Record<string, unknown>,
  attrs: Record<string, unknown>,
): string | null {
  for (const key of ['event.name', 'event_name']) {
    const v = attrs[key]
    if (typeof v === 'string' && v.length > 0 && v.length <= 200) return v
  }
  const body = (record.body as OtlpAnyValue | undefined)?.stringValue
  // El cuerpo solo se acepta si tiene forma de nombre de evento
  // (claude_code.x / codex.x). Nunca como texto libre: ahi puede ir contenido.
  if (typeof body === 'string' && /^(claude_code|codex)\.[a-z0-9_.]{1,80}$/.test(body)) {
    return body
  }
  return null
}

export function parseLogs(
  payload: unknown,
  now: number = Date.now(),
): { rows: EventRow[]; rejected: Rejections } {
  const rows: EventRow[] = []
  const rejected = emptyRejections()

  const resourceLogs = (payload as { resourceLogs?: unknown[] } | undefined)?.resourceLogs
  if (!Array.isArray(resourceLogs)) return { rows, rejected }

  for (const rl of resourceLogs) {
    const ctx = readResource((rl as { resource?: unknown }).resource)
    const scopes = (rl as { scopeLogs?: unknown[] }).scopeLogs
    if (!Array.isArray(scopes)) continue

    for (const scope of scopes) {
      const records = (scope as { logRecords?: unknown[] }).logRecords
      if (!Array.isArray(records)) continue

      for (const raw of records) {
        const record = raw as Record<string, unknown>
        const rawAttrs = flattenAttributes(record.attributes as OtlpKeyValue[])
        const name = eventNameOf(record, rawAttrs)
        if (!name) continue

        const tool = detectTool(name, ctx.serviceName)
        if (!tool) continue

        const occurredAt =
          nanosToIso(record.timeUnixNano) ?? nanosToIso(record.observedTimeUnixNano)
        if (!occurredAt) continue

        if (!ctx.hostname) {
          rejected.no_host++
          continue
        }

        if (checkTime(occurredAt, now) === 'bad') {
          rejected.bad_time++
          continue
        }

        const sessionId =
          safeSessionId(rawAttrs['session.id']) ??
          safeSessionId(rawAttrs['conversation.id'])
        const attrs = filterAttrs(rawAttrs, EVENT_ATTRS)

        rows.push({
          // Mismo motivo que en las metricas: los reintentos del collector no
          // deben duplicar eventos, porque de ellos se deriva el tiempo de Codex.
          dedup_key: pointKey([
            'e',
            ctx.hostname,
            name,
            sessionId,
            String(record.timeUnixNano ?? ''),
            String(record.observedTimeUnixNano ?? ''),
            canonical(attrs),
          ]),
          hostname: ctx.hostname,
          tool,
          service_name: ctx.serviceName,
          event_name: name,
          session_id: sessionId,
          attrs,
          occurred_at: occurredAt,
        })
      }
    }
  }

  return { rows, rejected }
}

export function parseOtlp(payload: unknown, now: number = Date.now()): ParseResult {
  const m = parseMetrics(payload, now)
  const l = parseLogs(payload, now)
  const rejected: Rejections = {
    no_host: m.rejected.no_host + l.rejected.no_host,
    bad_time: m.rejected.bad_time + l.rejected.bad_time,
    bad_value: m.rejected.bad_value + l.rejected.bad_value,
  }
  return {
    metrics: m.rows,
    events: l.rows,
    dropped: rejected.no_host + rejected.bad_time + rejected.bad_value,
    rejected,
  }
}
