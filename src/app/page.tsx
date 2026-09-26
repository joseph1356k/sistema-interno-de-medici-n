import Link from 'next/link'
import { Kpi, Status, TrendLine, duration, fmt } from './components'
import { loadDeviceHealth, loadPeople, loadTeamSummary } from '@/lib/metrics'

export const dynamic = 'force-dynamic'

const WINDOW = 30

export default async function TeamDashboard() {
  let summary
  let people
  let devices

  try {
    ;[summary, people, devices] = await Promise.all([
      loadTeamSummary(WINDOW),
      loadPeople(WINDOW),
      loadDeviceHealth(),
    ])
  } catch (e) {
    return (
      <main>
        <h1>Medición interna</h1>
        <div className="card">
          <p>
            No se pudo leer la base de datos. Revisa <code>SUPABASE_URL</code> y{' '}
            <code>SUPABASE_SERVICE_ROLE_KEY</code>, y que las migraciones de{' '}
            <code>db/migrations/</code> estén aplicadas.
          </p>
          <p className="error">{String(e)}</p>
        </div>
      </main>
    )
  }

  return (
    <main>
      <h1>Medición interna</h1>
      <p className="lede">
        Adopción de herramientas y ritmo de entrega. Últimos {WINDOW} días. Todo el
        equipo ve los mismos datos. Qué se guarda y qué no:{' '}
        <a href="https://github.com/joseph1356k/sistema-interno-de-medici-n/blob/main/PRIVACY.md">
          PRIVACY.md
        </a>
        .
      </p>

      <div className="kpis">
        <Kpi
          label="Tiempo en Claude Code"
          value={fmt(summary.claudeHours, 0)}
          unit="h"
          note="Tiempo activo medido por la herramienta"
        />
        <Kpi
          label="Tiempo en Codex"
          value={fmt(summary.codexHoursEst, 0)}
          unit="h"
          note="Estimado: Codex no mide tiempo activo"
        />
        <Kpi
          label="Coste de herramientas"
          value={`$${fmt(summary.costUsd, 0)}`}
          note="Aproximado, según la propia herramienta"
        />
        <Kpi
          label="PR abierto a merge"
          value={duration(summary.medianMergeHours)}
          note="Mediana del equipo"
        />
        <Kpi
          label="Espera a primera revisión"
          value={duration(summary.medianFirstReviewHours)}
          note="Mediana del equipo"
        />
        <Kpi
          label="Entre push y push"
          value={duration(summary.medianPushIntervalHours)}
          note="Mediana del equipo"
        />
      </div>

      <h2>Tiempo de PR abierto a merge, por semana</h2>
      <div className="card">
        <TrendLine
          points={summary.openToMergeTrend}
          label="Mediana semanal de horas desde que se abre un PR hasta que se mergea"
        />
        {summary.openToMergeTrend.length >= 2 ? (
          <table style={{ marginTop: 18 }}>
            <caption>Los mismos datos del gráfico, en tabla.</caption>
            <thead>
              <tr>
                <th scope="col">Semana del</th>
                <th scope="col">Mediana</th>
                <th scope="col">PR mergeados</th>
              </tr>
            </thead>
            <tbody>
              {summary.openToMergeTrend.map((p) => (
                <tr key={p.week}>
                  <td>{p.week}</td>
                  <td className="num">{duration(p.medianHours)}</td>
                  <td className="num">{p.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      <p className="note">
        Esta es la métrica que de verdad dice si el proceso mejora. Un PR que tarda
        días en mergearse es un problema de proceso, no de quien lo abrió.
      </p>

      <h2>Por persona</h2>
      <div className="card">
        <table>
          <caption>
            Orden alfabético, no por ninguna métrica. Esta tabla no es un ranking:
            los push y las horas son medidas de flujo, fáciles de inflar y malas
            para juzgar a nadie.
          </caption>
          <thead>
            <tr>
              <th scope="col">Persona</th>
              <th scope="col">Claude</th>
              <th scope="col">Codex (est.)</th>
              <th scope="col">Push</th>
              <th scope="col">Commits</th>
              <th scope="col">PR mergeados</th>
              <th scope="col">Aceptación</th>
            </tr>
          </thead>
          <tbody>
            {people.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  Todavía no hay nadie registrado. Añade filas a la tabla{' '}
                  <code>people</code> y asigna equipos en <code>devices</code>.
                </td>
              </tr>
            ) : (
              people.map((p) => (
                <tr key={p.person_id ?? p.display_name}>
                  <td>
                    {p.person_id ? (
                      <Link href={`/persona/${p.person_id}`}>{p.display_name}</Link>
                    ) : (
                      p.display_name
                    )}
                  </td>
                  <td className={`num ${p.claude_hours ? '' : 'zero'}`}>
                    {p.claude_hours ? `${fmt(p.claude_hours, 1)} h` : '—'}
                  </td>
                  <td className={`num ${p.codex_hours_est ? '' : 'zero'}`}>
                    {p.codex_hours_est ? `${fmt(p.codex_hours_est, 1)} h` : '—'}
                  </td>
                  <td className={`num ${p.pushes ? '' : 'zero'}`}>{p.pushes || '—'}</td>
                  <td className={`num ${p.commits ? '' : 'zero'}`}>
                    {p.commits || '—'}
                  </td>
                  <td className={`num ${p.prs_merged ? '' : 'zero'}`}>
                    {p.prs_merged || '—'}
                  </td>
                  <td className="num">
                    {p.accept_rate === null
                      ? '—'
                      : `${Math.round(p.accept_rate * 100)} %`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2>Salud del sistema</h2>
      <div className="card">
        <table>
          <caption>
            Qué equipos están reportando. En Windows la configuración de Codex es
            cooperativa: el usuario puede sobrescribirla, así que hay que mirarlo en
            vez de darlo por hecho.
          </caption>
          <thead>
            <tr>
              <th scope="col">Equipo</th>
              <th scope="col">Asignado a</th>
              <th scope="col">Claude Code</th>
              <th scope="col">Codex</th>
              <th scope="col">Visto por última vez</th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  Ningún equipo ha reportado todavía.
                </td>
              </tr>
            ) : (
              devices.map((d) => (
                <tr key={d.hostname}>
                  <td>
                    <code>{d.hostname}</code>
                  </td>
                  <td>
                    {d.display_name ?? (
                      <Status kind="warning">Sin asignar</Status>
                    )}
                  </td>
                  <td>
                    {d.claude_reporting ? (
                      <Status kind="good">Reportando</Status>
                    ) : (
                      <Status kind="critical">Sin datos</Status>
                    )}
                  </td>
                  <td>
                    {d.codex_reporting ? (
                      <Status kind="good">Reportando</Status>
                    ) : (
                      <Status kind="critical">Sin datos</Status>
                    )}
                  </td>
                  <td className="num">
                    {d.hours_since_last_seen === null
                      ? '—'
                      : `hace ${duration(d.hours_since_last_seen)}`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {summary.unmappedIdentities.length > 0 ? (
        <>
          <h2>Actividad sin atribuir</h2>
          <div className="card">
            <table>
              <caption>
                Identidades de git o GitHub que no corresponden a nadie en{' '}
                <code>people</code>. Suele ser alguien que no configuró{' '}
                <code>git config user.email</code>.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Identidad</th>
                  <th scope="col">Eventos</th>
                </tr>
              </thead>
              <tbody>
                {summary.unmappedIdentities.map((u) => (
                  <tr key={u.identity}>
                    <td>
                      <code>{u.identity}</code>
                    </td>
                    <td className="num">{u.events}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <footer>
        {summary.peopleReporting} personas reportando · {summary.devicesTotal} equipos
        registrados
        {summary.devicesQuiet > 0 ? `, ${summary.devicesQuiet} en silencio` : ''} ·
        ventana de {WINDOW} días
      </footer>
    </main>
  )
}
