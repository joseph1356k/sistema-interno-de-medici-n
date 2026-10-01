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
import { pushKey } from './github'
import { parsePullRequestState } from './github-events'
import { applyPrPatch } from './ingest-github'
import { refreshSnapshot } from './live'
import { ghostCandidates } from './pr-state'

export interface RollupResult {
  /** Filas de agregado escritas en los ultimos dias. */
  rows: number | null
  retention: unknown
  errors: string[]
}

/**
 * Recalcula el rollup de los ultimos dias y aplica la retencion.
 *
 * Se recalculan varios dias, no solo ayer: un portatil que estuvo sin red vacia su
 * cola al reconectarse, y esos eventos son de dias anteriores.
 *
 * Las fechas las pone la base (`rollup_recent`), no este servidor: es el unico
 * sitio que sabe en que zona horaria corta los dias el equipo. El plazo de
 * retencion tambien vive alli, en la tabla `settings`, porque `rollup_day` lo
 * necesita para no vaciar dias ya purgados.
 */
export async function runRollup(): Promise<RollupResult> {
  const client = db()
  const errors: string[] = []

  // Ventana de 7 dias: cubre el portatil que vuelve tras una semana fuera.
  const { data: rows, error: rollupError } = await client.rpc('rollup_recent', { days: 7 })
  if (rollupError) errors.push(`rollup: ${rollupError.message}`)

  const { data: retention, error } = await client.rpc('apply_retention')
  if (error) errors.push(`retención: ${error.message}`)

  return {
    rows: typeof rows === 'number' ? rows : null,
    retention: retention ?? null,
    errors,
  }
}

export interface ReconcileResult {
  skipped?: string
  reason?: string
  repos?: number
  activity?: { scanned: number; inserted: number }
  prsSynced?: number
  /** PR que seguian abiertos en la base y GitHub ya habia cerrado. */
  ghostsClosed?: number
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
  let ghostsClosed = 0

  for (const repo of repos) {
    try {
      const activity = await listRepoActivity(repo.full_name, 'week')
      scanned += activity.length

      const rows = activity
        .filter((a) => ACTIVITY_KIND[a.activity_type] && a.after)
        .map((a) => ({
          // LA MISMA clave que usa el webhook para este push. Si el webhook ya lo
          // trajo (lo normal), el upsert lo ignora; si se perdio, esta fila lo
          // recupera. Con claves distintas, cada push se contaba dos veces.
          dedup_key: pushKey(repo.full_name, a.ref, a.after!),
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
      // Una pagina entera: hace falta la lista completa para detectar fantasmas,
      // aunque el detalle solo se pida para los 40 mas recientes.
      const open = await listOpenPullRequests(repo.full_name, 100)
      for (const summary of open.slice(0, 40)) {
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

      // PR que la base cree abiertos y GitHub ya no: se cerraron sin que llegara
      // el webhook. Se pide cada uno para saber si se mergeo o se abandono.
      const { data: dbOpen, error: dbError } = await db()
        .from('pull_requests')
        .select('number')
        .eq('repo', repo.full_name)
        .eq('state', 'open')
      if (dbError) throw new Error(dbError.message)

      const ghosts = ghostCandidates(
        ((dbOpen ?? []) as { number: number }[]).map((r) => r.number),
        open.map((p) => p.number),
        open.length < 100,
      )
      for (const number of ghosts) {
        // Uno a uno: un PR que ya no existe (404) no debe frenar a los demas.
        try {
          const full = await getPullRequest(repo.full_name, number)
          const patch = parsePullRequestState({
            action: 'synchronize',
            repository: { full_name: repo.full_name },
            pull_request: full,
          })
          if (patch) {
            await applyPrPatch(patch)
            if (patch.state !== 'open') ghostsClosed++
          }
        } catch (e) {
          errors.push(`${repo.full_name}#${number}: ${String(e)}`)
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
    ghostsClosed,
    snapshot,
    errors: errors.slice(0, 10),
  }
}

/**
 * Comprueba el secreto del cron. Vercel firma sus invocaciones con este header.
 *
 * Sin secreto configurado se RECHAZA todo. Antes se dejaba pasar, y cualquiera que
 * conociera la URL podia lanzar la reconciliacion, que gasta cuota de la API de
 * GitHub, tantas veces como quisiera.
 */
export function authorizeCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const given = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret}`
  if (given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}
