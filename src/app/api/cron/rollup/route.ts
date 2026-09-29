import { NextResponse } from 'next/server'
import { authorizeCron, runRollup } from '@/lib/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Rollup y retencion sueltos, para lanzarlos a mano. */
export async function GET(request: Request) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return NextResponse.json(await runRollup())
}
