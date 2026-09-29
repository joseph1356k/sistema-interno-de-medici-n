import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Cron nocturno: recalcula el rollup de los ultimos dias y aplica la retencion.
 *
 * Se recalculan varios dias, no solo ayer, porque los datos llegan con retraso: un
 * portatil que estuvo sin red vacia su cola al reconectarse, y esos eventos son de
 * dias anteriores.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const client = db()
  const days: string[] = []
  const errors: string[] = []

  // Ventana de 7 dias: cubre el caso del portatil que vuelve tras una semana.
  for (let back = 0; back <= 7; back++) {
    const day = new Date(Date.now() - back * 864e5).toISOString().slice(0, 10)
    const { error } = await client.rpc('rollup_day', { target: day })
    if (error) errors.push(`${day}: ${error.message}`)
    else days.push(day)
  }

  const keepDays = Number(process.env.RETENTION_DAYS ?? 90)
  const { data: retention, error: retentionError } = await client.rpc('apply_retention', {
    keep_days: keepDays,
  })
  if (retentionError) errors.push(`retencion: ${retentionError.message}`)

  return NextResponse.json({
    rolled: days,
    retention: retention ?? null,
    keep_days: keepDays,
    errors,
  })
}
