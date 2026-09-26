import { NextResponse } from 'next/server'
import { checkIngestToken } from '@/lib/auth'
import { db, touchDevices } from '@/lib/db'
import { parseOtlp } from '@/lib/otlp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Recibe OTLP/HTTP en JSON desde el OTel Collector de cada PC.
 *
 * El collector local ya filtra los atributos sensibles antes de que salgan de la
 * maquina; `parseOtlp` los vuelve a filtrar aqui por allowlist. Son dos barreras
 * a proposito: si alguien despliega un PC sin el collector y apunta las
 * herramientas directo a esta ruta, sigue sin guardarse contenido.
 */
export async function POST(request: Request) {
  if (!checkIngestToken(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'json invalido' }, { status: 400 })
  }

  const { metrics, events, dropped } = parseOtlp(payload)

  if (metrics.length === 0 && events.length === 0) {
    // 200 a proposito: un payload sin nada reconocible no es culpa del collector,
    // y devolver error haria que reintentara en bucle.
    return NextResponse.json({ metrics: 0, events: 0, dropped })
  }

  const client = db()

  if (metrics.length > 0) {
    const { error } = await client.from('tool_metrics').insert(metrics)
    if (error) {
      // 500 para que el collector reintente con su cola en disco.
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  if (events.length > 0) {
    const { error } = await client.from('tool_events').insert(events)
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
  })
}
