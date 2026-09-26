import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Kpi, duration, fmt } from '../../components'
import { db } from '@/lib/db'
import { loadPeople, median } from '@/lib/metrics'

export const dynamic = 'force-dynamic'

const WINDOW = 90

/**
 * Vista individual. Existe sobre todo para que cada persona pueda ver sus propios
 * datos, que es parte del trato del documento de transparencia: si alguien ve un
 * numero raro, lo reporta.
 */
export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const client = db()
  const { data: person } = await client
    .from('people')
    .select('id, display_name, git_emails, github_login')
    .eq('id', id)
    .maybeSingle()

  if (!person) notFound()

  const sinceDay = new Date(Date.now() - WINDOW * 864e5).toISOString().slice(0, 10)

  const [people, devices, intervals, cycles] = await Promise.all([
    loadPeople(WINDOW),
    client.from('devices').select('hostname, last_seen').eq('person_id', id),
    client.from('v_push_intervals').select('hours_since_previous_push').eq('person_id', id),
    client
      .from('v_pr_cycle_time')
      .select('pr_number, repo, hours_open_to_merge, hours_to_first_review, pr_merged_at')
      .eq('person_id', id)
      .gte('pr_merged_at', sinceDay)
      .order('pr_merged_at', { ascending: false })
      .limit(20),
  ])

  const me = people.find((p) => p.person_id === id)
  const cycleRows = cycles.data ?? []

  return (
    <main>
      <p style={{ marginBottom: 8 }}>
        <Link href="/">← Vista de equipo</Link>
      </p>
      <h1>{person.display_name}</h1>
      <p className="lede">Últimos {WINDOW} días.</p>

      <div className="kpis">
        <Kpi
          label="Tiempo en Claude Code"
          value={fmt(me?.claude_hours ?? 0, 1)}
          unit="h"
        />
        <Kpi
          label="Tiempo en Codex"
          value={fmt(me?.codex_hours_est ?? 0, 1)}
          unit="h"
          note="Estimado"
        />
        <Kpi label="Push" value={String(me?.pushes ?? 0)} />
        <Kpi label="Commits" value={String(me?.commits ?? 0)} />
        <Kpi label="PR mergeados" value={String(me?.prs_merged ?? 0)} />
        <Kpi
          label="Aceptación de ediciones"
          value={
            me?.accept_rate === null || me?.accept_rate === undefined
              ? '—'
              : `${Math.round(me.accept_rate * 100)} %`
          }
          note="Sugerencias aceptadas de las ofrecidas"
        />
        <Kpi
          label="Entre push y push"
          value={duration(
            median((intervals.data ?? []).map((r) => Number(r.hours_since_previous_push))),
          )}
          note="Mediana"
        />
        <Kpi
          label="Coste de herramientas"
          value={`$${fmt(me?.cost_usd ?? 0, 2)}`}
          note="Aproximado"
        />
      </div>

      <h2>Identidades con las que se te atribuye actividad</h2>
      <div className="card">
        <p style={{ margin: 0 }}>
          Emails de git:{' '}
          {(person.git_emails as string[] | null)?.length ? (
            (person.git_emails as string[]).map((e) => <code key={e}>{e} </code>)
          ) : (
            <em>ninguno registrado — tu actividad de git no se te atribuirá</em>
          )}
          <br />
          Cuenta de GitHub:{' '}
          {person.github_login ? (
            <code>{String(person.github_login)}</code>
          ) : (
            <em>ninguna</em>
          )}
          <br />
          Equipos:{' '}
          {(devices.data ?? []).length
            ? (devices.data ?? []).map((d) => (
                <code key={String(d.hostname)}>{String(d.hostname)} </code>
              ))
            : <em>ninguno asignado — tu uso de herramientas no se te atribuirá</em>}
        </p>
      </div>

      <h2>PR mergeados recientemente</h2>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th scope="col">Repositorio</th>
              <th scope="col">PR</th>
              <th scope="col">Mergeado</th>
              <th scope="col">Abierto a merge</th>
              <th scope="col">A primera revisión</th>
            </tr>
          </thead>
          <tbody>
            {cycleRows.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  Sin PR mergeados en la ventana.
                </td>
              </tr>
            ) : (
              cycleRows.map((r) => (
                <tr key={`${r.repo}#${r.pr_number}`}>
                  <td>
                    <code>{String(r.repo)}</code>
                  </td>
                  <td className="num">#{String(r.pr_number)}</td>
                  <td className="num">
                    {r.pr_merged_at ? String(r.pr_merged_at).slice(0, 10) : '—'}
                  </td>
                  <td className="num">{duration(Number(r.hours_open_to_merge))}</td>
                  <td className="num">{duration(Number(r.hours_to_first_review))}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="note">
        Si algún número de aquí no te cuadra, dilo: es más probable que haya un
        error de medición que un hallazgo.
      </p>
    </main>
  )
}
