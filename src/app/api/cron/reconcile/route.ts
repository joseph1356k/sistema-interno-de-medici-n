import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  ACTIVITY_KIND,
  getPullRequest,
  listOpenPullRequests,
  listOrgRepos,
  listRepoActivity,
} from '@/lib/github-api'
import { applyPrPatch } from '@/lib/ingest-github'
import { parsePullRequestState } from '@/lib/github-events'
import { refreshSnapshot } from '@/lib/live'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Reconciliacion. Hace tres cosas, y cada una existe por un motivo concreto:
 *
 *  1. Rellena eventos de git perdidos. GitHub no reintenta las entregas fallidas y
 *     el reenvio manual solo dura 3 dias, asi que sin esto una caida del servidor
 *     deja un hueco permanente.
 *  2. Sincroniza el estado de los PRs abiertos. El webhook trae `mergeable_state`
 *     nulo casi siempre, porque GitHub lo calcula aparte; sin este paso el tablero
 *     no sabria distinguir un conflicto de un CI en rojo.
 *  3. Recalcula el rollup del dia y el tablero en vivo.
 *
 * Es idempotente: todo se escribe con claves derivadas de ids estables.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const org = process.env.GITHUB_ORG
  if (!org) return NextResponse.json({ error: 'Falta GITHUB_ORG' }, { status: 500 })

  const errors: string[] = []
  let activityScanned = 0
  let activityInserted = 0
  let prsSynced = 0

  let repos
  try {
    repos = await listOrgRepos(org)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 })
  }

  for (const repo of repos) {
    // --- 1. Eventos de git perdidos ---
    try {
      const activity = await listRepoActivity(repo.full_name, 'week')
      activityScanned += activity.length

      const rows = activity
        .filter((a) => ACTIVITY_KIND[a.activity_type])
        .map((a) => ({
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

      if (rows.length > 0) {
        const { error, count } = await db()
          .from('git_events')
          .upsert(rows, {
            onConflict: 'dedup_key',
            ignoreDuplicates: true,
            count: 'exact',
          })
        if (error) errors.push(`${repo.full_name} actividad: ${error.message}`)
        else activityInserted += count ?? 0
      }
    } catch (e) {
      // Un repo que falla no debe abortar el resto.
      errors.push(`${repo.full_name} actividad: ${String(e)}`)
    }

    // --- 2. Estado de los PRs abiertos ---
    try {
      const open = await listOpenPullRequests(repo.full_name)

      for (const summary of open) {
        // El listado devuelve la forma "simple", sin mergeabilidad ni tamano: hay
        // que pedir cada PR por separado para tener el motivo de bloqueo real.
        const full = await getPullRequest(repo.full_name, summary.number)
        const patch = parsePullRequestState({
          action: 'synchronize',
          repository: { full_name: repo.full_name },
          pull_request: full,
        })
        if (patch) {
          await applyPrPatch(patch)
          prsSynced++
        }
      }
    } catch (e) {
      errors.push(`${repo.full_name} PRs: ${String(e)}`)
    }
  }

  // --- 3. Rollup y tablero ---
  let snapshotOk = false
  try {
    await refreshSnapshot()
    snapshotOk = true
  } catch (e) {
    errors.push(`tablero: ${String(e)}`)
  }

  return NextResponse.json({
    repos: repos.length,
    activity: { scanned: activityScanned, inserted: activityInserted },
    prs_synced: prsSynced,
    snapshot: snapshotOk,
    errors: errors.slice(0, 10),
  })
}
