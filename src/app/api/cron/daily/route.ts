import { NextResponse } from 'next/server'
import { authorizeCron, runReconcile, runRollup } from '@/lib/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Cron diario: agrega, aplica retencion y reconcilia.
 *
 * Los tres van juntos en una sola ruta porque el plan Hobby de Vercel solo admite
 * crons diarios y un numero limitado de ellos. Para cadencia horaria hay dos
 * caminos: el plan Pro, o el workflow opcional
 * .github/workflows/reconcile.yml, que llama a /api/cron/reconcile desde GitHub
 * Actions.
 *
 * El orden importa: primero el rollup, porque la reconciliacion recalcula el
 * tablero al final y conviene que lea agregados frescos.
 */
export async function GET(request: Request) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const rollup = await runRollup()
  const reconcile = await runReconcile()

  return NextResponse.json({ rollup, reconcile })
}
