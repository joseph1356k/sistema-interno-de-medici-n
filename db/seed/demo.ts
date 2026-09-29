/**
 * Datos de demostracion: 16 semanas de actividad inventada.
 *
 * Sirven para poder leer el panel y para que las proyecciones tengan base antes de
 * conectar ningun equipo real. Todo queda identificado por prefijos conocidos
 * (`demo/` en repos, `demo-pc-` en equipos, UUIDs que empiezan por `dddddddd`), asi
 * que `npm run seed:clear` los borra sin ambiguedad y sin tocar datos reales.
 *
 *   npm run seed:demo    # inserta
 *   npm run seed:clear   # borra
 *
 * La variabilidad es intencionada: semanas buenas y malas, un PR atascado, CI en
 * rojo, un test inestable. Un panel sembrado con datos perfectos no ensena nada
 * sobre como se ve un problema de verdad.
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })

const WEEKS = 16
const DAYS = WEEKS * 7

const PEOPLE = [
  { id: 'dddddddd-0000-0000-0000-000000000001', name: 'Ana Ruiz', login: 'demo-ana' },
  { id: 'dddddddd-0000-0000-0000-000000000002', name: 'Luis Ortega', login: 'demo-luis' },
  { id: 'dddddddd-0000-0000-0000-000000000003', name: 'Marta Vidal', login: 'demo-marta' },
  { id: 'dddddddd-0000-0000-0000-000000000004', name: 'Diego Sanz', login: 'demo-diego' },
]

const REPOS = ['demo/api', 'demo/web']

/** PRNG con semilla: el mismo comando produce siempre el mismo panel. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = rng(20260929)

const pick = <T,>(list: T[]): T => list[Math.floor(rand() * list.length)]!
const between = (lo: number, hi: number) => lo + rand() * (hi - lo)
const chance = (p: number) => rand() < p

function dayOffset(daysAgo: number, hour = 10, minute = 0): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysAgo)
  d.setUTCHours(hour, minute, 0, 0)
  return d
}

const iso = (d: Date) => d.toISOString()
const dayKey = (d: Date) => d.toISOString().slice(0, 10)

/** Fin de semana: casi nada de actividad, como en la realidad. */
function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay()
  return dow === 0 || dow === 6
}

async function insert(table: string, rows: unknown[], conflict?: string) {
  if (rows.length === 0) return
  // Por lotes: un insert de miles de filas de golpe falla por tamano de peticion.
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500)
    const q = conflict
      ? db.from(table).upsert(batch, { onConflict: conflict, ignoreDuplicates: true })
      : db.from(table).insert(batch)
    const { error } = await q
    if (error) throw new Error(`${table}: ${error.message}`)
  }
  console.log(`  ${table}: ${rows.length} filas`)
}

async function clear() {
  console.log('Borrando datos de demostración…')
  const demoHosts = PEOPLE.map((_, i) => `demo-pc-0${i + 1}`)

  await db.from('commit_files').delete().like('repo', 'demo/%')
  await db.from('review_comments').delete().like('repo', 'demo/%')
  await db.from('reviews').delete().like('repo', 'demo/%')
  await db.from('ci_runs').delete().like('repo', 'demo/%')
  await db.from('deployments').delete().like('repo', 'demo/%')
  await db.from('pull_requests').delete().like('repo', 'demo/%')
  await db.from('git_events').delete().like('repo', 'demo/%')
  await db.from('tool_metrics').delete().in('hostname', demoHosts)
  await db.from('tool_events').delete().in('hostname', demoHosts)
  await db.from('daily_rollup').delete().in('person_id', PEOPLE.map((p) => p.id))
  await db.from('devices').delete().in('hostname', demoHosts)
  await db.from('people').delete().in('id', PEOPLE.map((p) => p.id))
  console.log('Hecho.')
}

async function seed() {
  console.log(`Sembrando ${WEEKS} semanas de datos de demostración…`)

  // --- Personas y equipos ---
  await insert(
    'people',
    PEOPLE.map((p) => ({
      id: p.id,
      display_name: p.name,
      git_emails: [`${p.login}@demo.local`],
      github_login: p.login,
      active: true,
    })),
    'id',
  )

  await insert(
    'devices',
    PEOPLE.map((p, i) => ({
      hostname: `demo-pc-0${i + 1}`,
      person_id: p.id,
      os: 'Windows 11',
      notes: 'equipo de demostración',
      last_seen: iso(dayOffset(0, 16)),
    })),
    'hostname',
  )

  // --- Telemetria de herramientas ---
  const metrics: Record<string, unknown>[] = []
  const events: Record<string, unknown>[] = []
  const gitEvents: Record<string, unknown>[] = []

  for (let d = DAYS; d >= 0; d--) {
    const date = dayOffset(d, 11)
    if (isWeekend(date) && !chance(0.08)) continue

    for (const [i, person] of PEOPLE.entries()) {
      const host = `demo-pc-0${i + 1}`
      // Cada persona tiene su propio nivel de uso, y hay dias sueltos a cero:
      // reuniones, diseno, o simplemente otra clase de trabajo.
      const base = [3.2, 2.1, 4.0, 1.2][i]!
      if (chance(0.12)) continue

      const hours = Math.max(0.2, base * between(0.4, 1.5))
      const userSecs = Math.round(hours * 3600 * 0.62)
      const cliSecs = Math.round(hours * 3600 * 0.38)

      metrics.push(
        {
          hostname: host,
          tool: 'claude_code',
          service_name: 'claude-code',
          metric: 'claude_code.active_time.total',
          value: userSecs,
          unit: 's',
          attrs: { type: 'user' },
          observed_at: iso(date),
        },
        {
          hostname: host,
          tool: 'claude_code',
          service_name: 'claude-code',
          metric: 'claude_code.active_time.total',
          value: cliSecs,
          unit: 's',
          attrs: { type: 'cli' },
          observed_at: iso(date),
        },
        {
          hostname: host,
          tool: 'claude_code',
          service_name: 'claude-code',
          metric: 'claude_code.cost.usage',
          value: Number((hours * between(0.9, 2.2)).toFixed(4)),
          unit: 'USD',
          attrs: {},
          observed_at: iso(date),
        },
        {
          hostname: host,
          tool: 'claude_code',
          service_name: 'claude-code',
          metric: 'claude_code.token.usage',
          value: Math.round(hours * between(28000, 65000)),
          unit: '',
          attrs: { model: pick(['claude-opus-5-5', 'claude-sonnet-5']) },
          observed_at: iso(date),
        },
        {
          hostname: host,
          tool: 'claude_code',
          service_name: 'claude-code',
          metric: 'claude_code.code_edit_tool.decision',
          value: Math.round(between(4, 16)),
          unit: '',
          attrs: { decision: 'accept', tool_name: 'Edit' },
          observed_at: iso(date),
        },
        {
          hostname: host,
          tool: 'claude_code',
          service_name: 'claude-code',
          metric: 'claude_code.code_edit_tool.decision',
          value: Math.round(between(0, 5)),
          unit: '',
          attrs: { decision: 'reject', tool_name: 'Edit' },
          observed_at: iso(date),
        },
        {
          hostname: host,
          tool: 'claude_code',
          service_name: 'claude-code',
          metric: 'claude_code.lines_of_code.count',
          value: Math.round(hours * between(30, 110)),
          unit: '',
          attrs: { type: 'added' },
          observed_at: iso(date),
        },
        {
          hostname: host,
          tool: 'claude_code',
          service_name: 'claude-code',
          metric: 'claude_code.lines_of_code.count',
          value: Math.round(hours * between(10, 50)),
          unit: '',
          attrs: { type: 'removed' },
          observed_at: iso(date),
        },
      )

      // Codex: solo dos de las cuatro personas lo usan, para que la vista de
      // adopcion tenga algo que ensenar.
      if (i < 2 && chance(0.55)) {
        const session = `demo-conv-${d}-${i}`
        let t = new Date(date.getTime() + 3600_000)
        const turns = Math.round(between(3, 9))
        for (let n = 0; n < turns; n++) {
          events.push({
            hostname: host,
            tool: 'codex',
            service_name: 'codex',
            event_name: n === 0 ? 'codex.conversation_starts' : 'codex.api_request',
            session_id: session,
            attrs: { model: 'gpt-5-codex' },
            occurred_at: iso(t),
          })
          t = new Date(t.getTime() + between(45, 240) * 1000)
        }
      }

      // Push
      const pushes = Math.round(between(0, 3))
      for (let n = 0; n < pushes; n++) {
        const at = new Date(date.getTime() + between(1, 8) * 3600_000)
        gitEvents.push({
          dedup_key: `demo:push:${d}:${i}:${n}`,
          kind: 'push',
          repo: pick(REPOS),
          actor_login: 'demo-cuenta-compartida',
          author_email: `${person.login}@demo.local`,
          ref: 'refs/heads/main',
          commit_count: Math.round(between(1, 5)),
          occurred_at: iso(at),
          meta: { source: 'demo' },
        })
      }
    }
  }

  await insert('tool_metrics', metrics)
  await insert('tool_events', events)
  await insert('git_events', gitEvents, 'dedup_key')

  // --- Pull requests, revisiones, CI y despliegues ---
  const prs: Record<string, unknown>[] = []
  const reviews: Record<string, unknown>[] = []
  const comments: Record<string, unknown>[] = []
  const ciRuns: Record<string, unknown>[] = []
  const deployments: Record<string, unknown>[] = []
  const commitFiles: Record<string, unknown>[] = []

  let prNumber = 100
  const filePool = Array.from({ length: 40 }, (_, i) => `demo-hash-${i}`)

  for (let d = DAYS; d >= 3; d--) {
    const opened = dayOffset(d, Math.round(between(9, 17)))
    if (isWeekend(opened)) continue
    // Semanas buenas y malas: es lo que hace util el Monte Carlo.
    const perDay = chance(0.25) ? 0 : Math.round(between(1, 3))

    for (let n = 0; n < perDay; n++) {
      const author = pick(PEOPLE)
      const reviewer = pick(PEOPLE.filter((p) => p.id !== author.id))
      const repo = pick(REPOS)
      const number = prNumber++
      const sha = `demosha${number}`

      // Los PR grandes tardan mas en revisarse: la relacion es real y el panel la
      // muestra, asi que los datos de demostracion deben tenerla.
      const size = chance(0.2) ? between(400, 1400) : between(15, 250)
      const sizeFactor = size > 350 ? between(2.5, 5) : between(0.6, 1.6)

      const toReview = between(1.5, 14) * sizeFactor
      const toApprove = between(0.5, 8)
      const toMerge = between(0.2, 5)

      const firstReview = new Date(opened.getTime() + toReview * 3600_000)
      const approved = new Date(firstReview.getTime() + toApprove * 3600_000)
      const merged = new Date(approved.getTime() + toMerge * 3600_000)

      const changesFirst = chance(0.3)

      if (changesFirst) {
        reviews.push({
          dedup_key: `demo:rv:${number}:1`,
          repo,
          pr_number: number,
          reviewer_login: reviewer.login,
          pr_author_login: author.login,
          state: 'changes_requested',
          submitted_at: iso(firstReview),
          external_id: `demo-rev-${number}-1`,
        })
        const howMany = Math.round(between(1, 5))
        for (let c = 0; c < howMany; c++) {
          comments.push({
            dedup_key: `demo:rc:${number}:${c}`,
            repo,
            pr_number: number,
            review_id: `demo-rev-${number}-1`,
            commenter_login: reviewer.login,
            created_at: iso(new Date(firstReview.getTime() + c * 60_000)),
          })
        }
      }

      reviews.push({
        dedup_key: `demo:rv:${number}:2`,
        repo,
        pr_number: number,
        reviewer_login: reviewer.login,
        pr_author_login: author.login,
        state: 'approved',
        submitted_at: iso(approved),
        external_id: `demo-rev-${number}-2`,
      })

      // CI: casi siempre verde al final, con reintentos de vez en cuando.
      const attempts = chance(0.3) ? Math.round(between(2, 4)) : 1
      for (let a = 1; a <= attempts; a++) {
        const start = new Date(opened.getTime() + a * 1800_000)
        const ok = a === attempts
        ciRuns.push({
          dedup_key: `demo:ci:${number}:${a}`,
          repo,
          head_sha: sha,
          provider: 'workflow_run',
          external_id: `demo-run-${number}-${a}`,
          name: 'CI',
          branch: `feature/demo-${number}`,
          status: 'completed',
          conclusion: ok ? 'success' : 'failure',
          attempt: a,
          trigger_event: 'pull_request',
          started_at: iso(start),
          completed_at: iso(new Date(start.getTime() + between(180, 900) * 1000)),
          duration_seconds: Math.round(between(180, 900)),
        })
      }

      prs.push({
        repo,
        number,
        author_login: author.login,
        state: 'merged',
        draft: false,
        head_sha: sha,
        base_ref: 'main',
        additions: Math.round(size * 0.7),
        deletions: Math.round(size * 0.3),
        changed_files: Math.max(1, Math.round(size / 60)),
        commits: Math.max(1, Math.round(size / 90)),
        mergeable: true,
        mergeable_state: 'clean',
        requested_reviewers: 0,
        last_review_state: 'approved',
        created_at: iso(opened),
        ready_at: iso(opened),
        first_review_at: iso(firstReview),
        approved_at: iso(approved),
        merged_at: iso(merged),
        event_ts: iso(merged),
      })

      // Archivos tocados, ya en forma de hash: es como los guarda el sistema real.
      const touched = Math.max(1, Math.round(size / 120))
      for (let ff = 0; ff < touched; ff++) {
        const path = pick(filePool)
        commitFiles.push({
          dedup_key: `demo:cf:${number}:${path}`,
          repo,
          sha,
          path_hash: path,
          change_type: chance(0.25) ? 'added' : 'modified',
          committed_at: iso(merged),
        })
      }
    }
  }

  // --- PRs abiertos ahora: uno por cada motivo de bloqueo, para que el tablero
  // en vivo tenga las seis columnas con contenido.
  const openCases: {
    reason: string
    draft: boolean
    mergeable_state: string
    last_review_state: string | null
    daysOld: number
    reviewers: number
    ciFails?: boolean
  }[] = [
    { reason: 'esperando revisión, muy parado', draft: false, mergeable_state: 'clean', last_review_state: null, daysOld: 5, reviewers: 1 },
    { reason: 'esperando revisión sin revisor', draft: false, mergeable_state: 'clean', last_review_state: null, daysOld: 3, reviewers: 0 },
    { reason: 'cambios pedidos', draft: false, mergeable_state: 'clean', last_review_state: 'changes_requested', daysOld: 2, reviewers: 1 },
    { reason: 'conflicto', draft: false, mergeable_state: 'dirty', last_review_state: null, daysOld: 4, reviewers: 1 },
    { reason: 'CI en rojo', draft: false, mergeable_state: 'unstable', last_review_state: null, daysOld: 1, reviewers: 1, ciFails: true },
    { reason: 'aprobado sin mergear', draft: false, mergeable_state: 'clean', last_review_state: 'approved', daysOld: 2, reviewers: 0 },
    { reason: 'borrador', draft: true, mergeable_state: 'draft', last_review_state: null, daysOld: 6, reviewers: 0 },
  ]

  for (const c of openCases) {
    const author = pick(PEOPLE)
    const repo = pick(REPOS)
    const number = prNumber++
    const sha = `demosha${number}`
    const opened = dayOffset(c.daysOld, 10)
    const size = between(20, 400)

    prs.push({
      repo,
      number,
      author_login: author.login,
      state: 'open',
      draft: c.draft,
      head_sha: sha,
      base_ref: 'main',
      additions: Math.round(size * 0.7),
      deletions: Math.round(size * 0.3),
      changed_files: Math.max(1, Math.round(size / 60)),
      commits: Math.max(1, Math.round(size / 90)),
      mergeable: c.mergeable_state === 'clean',
      mergeable_state: c.mergeable_state,
      requested_reviewers: c.reviewers,
      last_review_state: c.last_review_state,
      created_at: iso(opened),
      ready_at: c.draft ? null : iso(opened),
      first_review_at: c.last_review_state ? iso(dayOffset(c.daysOld - 1, 12)) : null,
      approved_at: c.last_review_state === 'approved' ? iso(dayOffset(c.daysOld - 1, 12)) : null,
      event_ts: iso(opened),
    })

    if (c.ciFails) {
      ciRuns.push({
        dedup_key: `demo:ci:open:${number}`,
        repo,
        head_sha: sha,
        provider: 'workflow_run',
        name: 'CI',
        branch: `feature/demo-${number}`,
        status: 'completed',
        conclusion: 'failure',
        attempt: 1,
        trigger_event: 'pull_request',
        started_at: iso(opened),
        completed_at: iso(new Date(opened.getTime() + 400_000)),
        duration_seconds: 400,
      })
    }
  }

  // --- CI de la rama principal, con un test inestable y una rotura reciente ---
  for (let d = DAYS; d >= 0; d -= 1) {
    const at = dayOffset(d, 8)
    if (isWeekend(at)) continue
    const broken = chance(0.07)
    ciRuns.push({
      dedup_key: `demo:ci:main:${d}`,
      repo: 'demo/api',
      head_sha: `demomain${d}`,
      provider: 'workflow_run',
      name: 'CI',
      branch: 'main',
      status: 'completed',
      conclusion: broken ? 'failure' : 'success',
      attempt: 1,
      trigger_event: 'push',
      started_at: iso(at),
      completed_at: iso(new Date(at.getTime() + between(200, 700) * 1000)),
      duration_seconds: Math.round(between(200, 700)),
    })
    // Tras una rotura, la restauracion unas horas despues.
    if (broken) {
      const fixed = new Date(at.getTime() + between(1.5, 7) * 3600_000)
      ciRuns.push({
        dedup_key: `demo:ci:main:${d}:fix`,
        repo: 'demo/api',
        head_sha: `demomain${d}fix`,
        provider: 'workflow_run',
        name: 'CI',
        branch: 'main',
        status: 'completed',
        conclusion: 'success',
        attempt: 1,
        trigger_event: 'push',
        started_at: iso(fixed),
        completed_at: iso(new Date(fixed.getTime() + 400_000)),
        duration_seconds: 400,
      })
    }
  }

  // Un test inestable: mismo workflow, mismo commit, resultados distintos.
  const flakySha = 'demoflaky001'
  for (const [n, conclusion] of ['failure', 'success', 'failure', 'success'].entries()) {
    const at = dayOffset(4, 9 + n)
    ciRuns.push({
      dedup_key: `demo:ci:flaky:${n}`,
      repo: 'demo/web',
      head_sha: flakySha,
      provider: 'workflow_run',
      name: 'Tests de integración',
      branch: 'main',
      status: 'completed',
      conclusion,
      attempt: n + 1,
      trigger_event: 'push',
      started_at: iso(at),
      completed_at: iso(new Date(at.getTime() + 300_000)),
      duration_seconds: 300,
    })
  }

  // --- Despliegues semanales, con alguna reversion ---
  for (let w = WEEKS; w >= 0; w--) {
    const at = dayOffset(w * 7 + 1, 18)
    const rollback = chance(0.12)
    deployments.push({
      dedup_key: `demo:dep:${w}`,
      repo: 'demo/api',
      environment: 'production',
      ref: `v1.${WEEKS - w}.0`,
      source: 'release',
      deployed_at: iso(at),
      is_rollback: false,
    })
    if (rollback) {
      deployments.push({
        dedup_key: `demo:dep:${w}:rb`,
        repo: 'demo/api',
        environment: 'production',
        ref: `v1.${WEEKS - w}.1`,
        source: 'release',
        deployed_at: iso(new Date(at.getTime() + 5400_000)),
        is_rollback: true,
      })
    }
  }

  await insert('pull_requests', prs, 'repo,number')
  await insert('reviews', reviews, 'dedup_key')
  await insert('review_comments', comments, 'dedup_key')
  await insert('ci_runs', ciRuns, 'dedup_key')
  await insert('deployments', deployments, 'dedup_key')
  await insert('commit_files', commitFiles, 'dedup_key')

  // --- Rollup de todos los dias sembrados ---
  console.log('Calculando el rollup diario…')
  for (let d = DAYS; d >= 0; d--) {
    const day = dayKey(dayOffset(d))
    const { error } = await db.rpc('rollup_day', { target: day })
    if (error) throw new Error(`rollup ${day}: ${error.message}`)
  }

  console.log(`\nListo: ${WEEKS} semanas sembradas, ${prs.length} PRs.`)
  console.log('Para borrarlos: npm run seed:clear')
}

const mode = process.argv[2]
const run = mode === 'clear' ? clear : seed
run().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
