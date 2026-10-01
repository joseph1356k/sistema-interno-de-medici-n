import { NextResponse } from 'next/server'
import { checkIngestToken } from '@/lib/auth'
import { db, touchDevices } from '@/lib/db'
import { parseOtlp } from '@/lib/otlp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Tamano maximo de un lote. El collector agrupa como mucho 200 elementos cada
 * 30 s; un lote real ocupa decenas de KB. Algo mucho mayor no es telemetria, y
 * sin limite cualquiera con el token podria tumbar la funcion con un cuerpo de
 * cientos de MB.
 */
const MAX_BODY_BYTES = 5 * 1024 * 1024

/**
 * Recibe OTLP/HTTP en JSON desde el OTel Collector de cada PC.
 *
 * El collector local ya filtra los atributos sensibles antes de que salgan de la
 * maquina; `parseOtlp` los vuelve a filtrar aqui por allowlist. Son dos barreras
 * a proposito: si alguien despliega un PC sin el collector y apunta las
 * herramientas directo a esta ruta, sigue sin guardarse contenido.
 *
 * Es IDEMPOTENTE: el collector reintenta un lote hasta 24 horas, y un reintento
 * puede llegar aunque el lote ya estuviera guardado. Cada punto lleva su clave de
 * deduplicacion y los repetidos se ignoran.
 */
export async function POST(request: Request) {
  if (!checkIngestToken(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Primero la cabecera, para rechazar sin leer el cuerpo cuando ya se sabe.
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'lote demasiado grande' }, { status: 413 })
  }

  // Y despues el tamano real: la cabecera la pone el cliente y puede mentir.
  const raw = await request.text()
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'lote demasiado grande' }, { status: 413 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'json invalido' }, { status: 400 })
  }

  const { metrics, events, dropped, rejected } = parseOtlp(payload)

  if (metrics.length === 0 && events.length === 0) {
    // 200 a proposito: un payload sin nada reconocible no es culpa del collector,
    // y devolver error haria que reintentara en bucle.
    return NextResponse.json({ metrics: 0, events: 0, dropped, rejected })
  }

  const client = db()

  if (metrics.length > 0) {
    const { error } = await client
      .from('tool_metrics')
      .upsert(metrics, { onConflict: 'dedup_key', ignoreDuplicates: true })
    if (error) {
      // 500 para que el collector reintente con su cola en disco. Es seguro
      // gracias a la deduplicacion.
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  if (events.length > 0) {
    const { error } = await client
      .from('tool_events')
      .upsert(events, { onConflict: 'dedup_key', ignoreDuplicates: true })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  await touchDevices([
    ...metrics.map((m) => m.hostname),
    ...events.map((e) => e.hostname),
  ])

  return NextResponse.json({
    metrics: metrics.length,
    events: events.length,
    dropped,
    rejected,
  })
}
