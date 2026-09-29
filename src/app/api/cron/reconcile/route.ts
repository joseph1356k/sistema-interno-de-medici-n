import { NextResponse } from 'next/server'
import { authorizeCron, runReconcile } from '@/lib/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Reconciliacion suelta, para poder lanzarla a mano o desde GitHub Actions con
 * cadencia horaria (ver .github/workflows/reconcile.yml).
 */
export async function GET(request: Request) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return NextResponse.json(await runReconcile())
}
