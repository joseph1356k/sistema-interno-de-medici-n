/**
 * Cliente minimo de la API de GitHub para el job de reconciliacion.
 *
 * Existe porque GitHub NO reintenta las entregas de webhook fallidas, y el
 * reenvio manual solo esta disponible 3 dias. Sin esta red de seguridad, una
 * caida del servidor de media hora deja un agujero permanente en los datos.
 */

const API = 'https://api.github.com'

/** True si hay token para llamar a la API. El webhook funciona sin el. */
export function hasApiToken(): boolean {
  return Boolean(process.env.GITHUB_API_TOKEN)
}

function headers(): HeadersInit {
  const token = process.env.GITHUB_API_TOKEN
  if (!token) throw new Error('Falta GITHUB_API_TOKEN')
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sistema-interno-de-medicion',
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: headers(), cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} en ${path}: ${await res.text()}`)
  }
  return (await res.json()) as T
}

export interface OrgRepo {
  full_name: string
  archived: boolean
  pushed_at: string | null
}

/**
 * Repositorios de una organizacion O de una cuenta personal.
 *
 * `/orgs/{name}/repos` devuelve 404 para una cuenta personal, que es el caso mas
 * comun en equipos pequenos. Se prueba primero como organizacion y se cae a
 * usuario: sin esto la reconciliacion no encontraria ningun repositorio y fallaria
 * en silencio.
 */
export async function listOwnerRepos(owner: string): Promise<OrgRepo[]> {
  const out: OrgRepo[] = []
  let base = `/orgs/${owner}/repos`

  try {
    await get<OrgRepo[]>(`${base}?per_page=1`)
  } catch {
    base = `/users/${owner}/repos`
  }

  // 100 es el maximo por pagina; se para en 5 paginas para no agotar la cuota en
  // cuentas con muchos repositorios. Un equipo pequeno no llega ni a la primera.
  for (let page = 1; page <= 5; page++) {
    const batch = await get<OrgRepo[]>(`${base}?per_page=100&sort=pushed&page=${page}`)
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out.filter((r) => !r.archived)
}

/** Nombre anterior, conservado para no romper llamadas existentes. */
export const listOrgRepos = listOwnerRepos

export interface RepoActivity {
  id: number
  activity_type: string
  timestamp: string
  ref: string | null
  before: string | null
  after: string | null
  actor: { login?: string } | null
}

/**
 * GET /repos/{owner}/{repo}/activity.
 *
 * Limitacion conocida: devuelve `actor` (la cuenta de GitHub) pero NO los emails
 * de autor de los commits. Con cuentas compartidas, los eventos recuperados por
 * aqui solo se pueden atribuir por login. Los que llegan por webhook si traen el
 * email, asi que esta via es un respaldo, no la fuente principal.
 *
 * La retencion de este endpoint no esta documentada; no conviene depender de el
 * para historicos largos.
 */
export async function listRepoActivity(
  fullName: string,
  timePeriod: 'day' | 'week' | 'month' = 'week',
): Promise<RepoActivity[]> {
  return get<RepoActivity[]>(
    `/repos/${fullName}/activity?per_page=100&time_period=${timePeriod}`,
  )
}

/** Tipos de actividad que nos interesan, mapeados a nuestros `kind`. */
export const ACTIVITY_KIND: Record<string, 'push' | 'force_push' | 'pr_merged'> = {
  push: 'push',
  force_push: 'force_push',
  pr_merge: 'pr_merged',
  merge_queue_merge: 'pr_merged',
}

// ---------------------------------------------------------------------------
// Sincronizacion de PRs abiertos
// ---------------------------------------------------------------------------

/**
 * El listado de PRs devuelve la forma "simple", que NO incluye `mergeable`,
 * `mergeable_state`, `additions`, `deletions` ni `changed_files`. Esos campos solo
 * llegan en el GET de un PR concreto, asi que hay que pedir cada uno.
 *
 * Para un equipo pequeno son unas pocas peticiones; el limite de 40 esta para que
 * un repositorio con cientos de PRs abiertos no agote la cuota de la API.
 */
export interface OpenPrSummary {
  number: number
  updated_at: string
}

export async function listOpenPullRequests(
  fullName: string,
  limit = 40,
): Promise<OpenPrSummary[]> {
  const prs = await get<OpenPrSummary[]>(
    `/repos/${fullName}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
  )
  return prs.slice(0, limit)
}

/** GET de un PR concreto: es el unico que trae la mergeabilidad y el tamano. */
export async function getPullRequest(
  fullName: string,
  number: number,
): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>(`/repos/${fullName}/pulls/${number}`)
}

export interface CombinedStatus {
  state: string
  sha: string
}

/**
 * Estado combinado de un commit. `failure` si algun contexto fallo, `pending` si
 * falta alguno, `success` si todos los ultimos pasaron.
 */
export async function getCombinedStatus(
  fullName: string,
  ref: string,
): Promise<CombinedStatus | null> {
  try {
    return await get<CombinedStatus>(`/repos/${fullName}/commits/${ref}/status`)
  } catch {
    // Un commit sin ningun status no es un error del sistema.
    return null
  }
}

export interface CheckRunsResponse {
  total_count: number
  check_runs: { name: string; status: string; conclusion: string | null }[]
}

export async function getCheckRuns(
  fullName: string,
  ref: string,
): Promise<CheckRunsResponse | null> {
  try {
    return await get<CheckRunsResponse>(
      `/repos/${fullName}/commits/${ref}/check-runs?filter=latest&per_page=100`,
    )
  } catch {
    return null
  }
}
