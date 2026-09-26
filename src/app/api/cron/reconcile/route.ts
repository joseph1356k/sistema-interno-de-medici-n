import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ACTIVITY_KIND, listOrgRepos, listRepoActivity } from '@/lib/github-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Rellena los eventos de git que no llegaron por webhook.
 *
 * GitHub no reintenta entregas fallidas, asi que sin esto una caida del servidor
 * deja un hueco permanente. Se ejecuta a diario (ver vercel.json).
 *
 * Es idempotente: las filas se insertan con un `dedup_key` derivado del id de
 * actividad, asi que reejecutarlo no duplica nada.
 */
export async function GET(request: Request) {
  // Vercel firma sus invocaciones de cron con este header.
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const org = process.env.GITHUB_ORG
  if (!org) {
    return NextResponse.json({ error: 'Falta GITHUB_ORG' }, { status: 500 })
  }

  const errors: string[] = []
  let inserted = 0
  let scanned = 0

  let repos
  try {
    repos = await listOrgRepos(org)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 })
  }

  for (const repo of repos) {
    let activity
    try {
      activity = await listRepoActivity(repo.full_name, 'week')
    } catch (e) {
      // Un repo que falla no debe abortar el resto.
      errors.push(`${repo.full_name}: ${String(e)}`)
      continue
    }

    const rows = activity
      .filter((a) => ACTIVITY_KIND[a.activity_type])
      .map((a) => ({
        // El id de actividad es estable, asi que la clave tambien.
        dedup_key: `a:${repo.full_name}:${a.id}`,
        kind: ACTIVITY_KIND[a.activity_type]!,
        repo: repo.full_name,
        actor_login: a.actor?.login ?? null,
        // Este endpoint no da emails de autor: la atribucion va por login.
        author_email: null,
        ref: a.ref,
        occurred_at: a.timestamp,
        meta: { source: 'reconcile', activity_type: a.activity_type },
      }))

    scanned += activity.length
    if (rows.length === 0) continue

    const { error, count } = await db()
      .from('git_events')
      .upsert(rows, { onConflict: 'dedup_key', ignoreDuplicates: true, count: 'exact' })

    if (error) errors.push(`${repo.full_name}: ${error.message}`)
    else inserted += count ?? 0
  }

  return NextResponse.json({
    repos: repos.length,
    scanned,
    inserted,
    errors: errors.slice(0, 10),
  })
}
