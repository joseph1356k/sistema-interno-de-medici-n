/**
 * Trabajos programados, como funciones reutilizables.
 *
 * Viven aparte de las rutas porque el plan Hobby de Vercel solo admite crons
 * DIARIOS, asi que un unico cron los ejecuta en cadena. Las rutas individuales se
 * conservan para poder lanzar cada uno a mano.
 */

import { db } from './db'
import {
  ACTIVITY_KIND,
  getPullRequest,
  hasApiToken,
  listOpenPullRequests,
  listOwnerRepos,
  listRepoActivity,
} from './github-api'
import { parsePullRequestState } from './github-events'
import { applyPrPatch } from './ingest-github'
import { refreshSnapshot } from './live'

export interface RollupResult {
  rolled: string[]
  retention: unknown
  keepDays: number
  errors: string[]
}

/**
 * Recalcula el rollup de los ultimos dias y aplica la retencion.
 *
 * Se recalculan varios dias, no solo ayer: un portatil que estuvo sin red vacia su
 * cola al reconectarse, y esos eventos son de dias anteriores.
 */
export async function runRollup(): Promise<RollupResult> {
  const client = db()
  const rolled: string[] = []
  const errors: string[] = []

  // Ventana de 7 dias: cubre el portatil que vuelve tras una semana fuera.
  for (let back = 0; back <= 7; back++) {
    const day = new Date(Date.now() - back * 864e5).toISOString().slice(0, 10)
    const { error } = await client.rpc('rollup_day', { target: day })
    if (error) errors.push(`${day}: ${error.message}`)
    else rolled.push(day)
  }

  const keepDays = Number(process.env.RETENTION_DAYS ?? 90)
  const { data: retention, error } = await client.rpc('apply_retention', {
    keep_days: keepDays,
  })
  if (error) errors.push(`retención: ${error.message}`)

  return { rolled, retention: retention ?? null, keepDays, errors }
}

export interface ReconcileResult {
  skipped?: string
  reason?: string
  repos?: number
  activity?: { scanned: number; inserted: number }
  prsSynced?: number
  snapshot: boolean
  errors: string[]
}

/**
 * Rellena lo que no llego por webhook y refresca el estado de los PRs abiertos.
 *
 * Existe porque GitHub no reintenta las entregas fallidas y el reenvio manual solo
 * dura 3 dias: sin esto, una caida del servidor deja un hueco permanente. Ademas el
 * webhook trae `mergeable_state` nulo casi siempre, asi que sin este paso el tablero
 * no sabria distinguir un conflicto de un CI en rojo.
 */
export async function runReconcile(): Promise<ReconcileResult> {
  const owner = process.env.GITHUB_ORG
  const errors: string[] = []

  // Sin token o sin propietario no hay reconciliacion, pero el tablero si se puede
  // recalcular con lo que ya llego. Es una degradacion, no un fallo.
  if (!owner || !hasApiToken()) {
    let snapshot = false
    try {
      await refreshSnapshot()
      snapshot = true
    } catch (e) {
      errors.push(String(e))
    }
    return {
      skipped: 'reconciliación',
      reason: !owner ? 'falta GITHUB_ORG' : 'falta GITHUB_API_TOKEN',
      snapshot,
      errors,
    }
  }

  let repos
  try {
    repos = await listOwnerRepos(owner)
  } catch (e) {
    return { snapshot: false, errors: [`listado de repositorios: ${String(e)}`] }
  }

  let scanned = 0
  let inserted = 0
  let prsSynced = 0

  for (const repo of repos) {
    try {
      const activity = await listRepoActivity(repo.full_name, 'week')
      scanned += activity.length

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
        else inserted += count ?? 0
      }
    } catch (e) {
      // Un repositorio que falla no debe abortar el resto.
      errors.push(`${repo.full_name} actividad: ${String(e)}`)
    }

    try {
      const open = await listOpenPullRequests(repo.full_name)
      for (const summary of open) {
        // El listado devuelve la forma reducida, sin mergeabilidad ni tamano: hay
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

  let snapshot = false
  try {
    await refreshSnapshot()
    snapshot = true
  } catch (e) {
    errors.push(`tablero: ${String(e)}`)
  }

  return {
    repos: repos.length,
    activity: { scanned, inserted },
    prsSynced,
    snapshot,
    errors: errors.slice(0, 10),
  }
}

/** Comprueba el secreto del cron. Vercel firma sus invocaciones con este header. */
export function authorizeCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  return request.headers.get('authorization') === `Bearer ${secret}`
}
