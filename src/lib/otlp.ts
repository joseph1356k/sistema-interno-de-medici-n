/**
 * Parser de OTLP/HTTP en JSON.
 *
 * Claude Code soporta OTEL_EXPORTER_OTLP_PROTOCOL=http/json y Codex
 * `protocol = "json"`, asi que no hace falta un servidor OTel central: una ruta
 * de Next.js puede recibir el payload directamente.
 *
 * Todo lo que sale de aqui ya paso por la allowlist de src/lib/allowlist.ts.
 */

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
  hostname: string
  tool: ToolKind
  service_name: string | null
  event_name: string
  session_id: string | null
  attrs: Record<string, AttrValue>
  occurred_at: string
}

export interface ParseResult {
  metrics: MetricRow[]
  events: EventRow[]
  /** Filas descartadas por no poder atribuirse a un equipo. */
  dropped: number
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

export function parseMetrics(payload: unknown): { rows: MetricRow[]; dropped: number } {
  const rows: MetricRow[] = []
  let dropped = 0

  const resourceMetrics =
    (payload as { resourceMetrics?: unknown[] } | undefined)?.resourceMetrics
  if (!Array.isArray(resourceMetrics)) return { rows, dropped }

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
            dropped++
            continue
          }

          const pointAttrs = flattenAttributes(point.attributes as OtlpKeyValue[])
          rows.push({
            hostname: ctx.hostname,
            tool,
            service_name: ctx.serviceName,
            metric: name,
            value,
            unit: typeof metric.unit === 'string' ? metric.unit : null,
            attrs: filterAttrs(pointAttrs, METRIC_ATTRS),
            observed_at: observedAt,
          })
        }
      }
    }
  }

  return { rows, dropped }
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

export function parseLogs(payload: unknown): { rows: EventRow[]; dropped: number } {
  const rows: EventRow[] = []
  let dropped = 0

  const resourceLogs = (payload as { resourceLogs?: unknown[] } | undefined)?.resourceLogs
  if (!Array.isArray(resourceLogs)) return { rows, dropped }

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
          dropped++
          continue
        }

        rows.push({
          hostname: ctx.hostname,
          tool,
          service_name: ctx.serviceName,
          event_name: name,
          session_id:
            safeSessionId(rawAttrs['session.id']) ??
            safeSessionId(rawAttrs['conversation.id']),
          attrs: filterAttrs(rawAttrs, EVENT_ATTRS),
          occurred_at: occurredAt,
        })
      }
    }
  }

  return { rows, dropped }
}

export function parseOtlp(payload: unknown): ParseResult {
  const m = parseMetrics(payload)
  const l = parseLogs(payload)
  return { metrics: m.rows, events: l.rows, dropped: m.dropped + l.dropped }
}
