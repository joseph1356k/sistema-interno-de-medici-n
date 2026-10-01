import {
  AutoRefresh,
  DemoBanner,
  ErrorCard,
  Kpi,
  Nav,
  PageHeader,
  ReadingNote,
  Section,
  Status,
  duration,
  fmt,
  int,
} from './components'
import { readSnapshot, refreshSnapshot, type LiveSnapshot } from '@/lib/live'
import type { BlockReason } from '@/lib/pr-state'

// Sin caché: es la única vista que tiene que estar fresca.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const REASON_LABEL: Record<BlockReason, string> = {
  conflict: 'Con conflicto',
  ci_red: 'CI en rojo',
  changes_requested: 'Cambios pedidos',
  awaiting_review: 'Esperando revisión',
  ready_to_merge: 'Listo para mergear',
  draft: 'En borrador',
}

const REASON_TONE: Record<BlockReason, string> = {
  conflict: 'reason-blocking',
  ci_red: 'reason-blocking',
  changes_requested: 'reason-waiting',
  awaiting_review: 'reason-waiting',
  ready_to_merge: 'reason-ok',
  draft: '',
}

/** Orden de atención: lo que bloquea de verdad primero. */
const REASON_ORDER: BlockReason[] = [
  'conflict',
  'ci_red',
  'changes_requested',
  'awaiting_review',
  'ready_to_merge',
  'draft',
]

function compare(today: number, average: number): { text: string; cls: string } {
  if (average <= 0) return { text: 'sin referencia', cls: 'trend-flat' }
  const ratio = today / average
  if (ratio >= 1.15) return { text: `${fmt(ratio, 1)}× la media`, cls: 'trend-up' }
  if (ratio <= 0.85) return { text: `${fmt(ratio, 1)}× la media`, cls: 'trend-down' }
  return { text: 'en su media', cls: 'trend-flat' }
}

export default async function AhoraPage() {
  let snapshot: LiveSnapshot | null = null
  let error: unknown = null

  try {
    // Si nunca se calculó, o llegó un evento después del último cálculo, se
    // calcula ahora.
    snapshot = (await readSnapshot()) ?? (await refreshSnapshot())
  } catch (e) {
    error = e
  }

  if (error || !snapshot) {
    return (
      <main>
        <Nav current="/" />
        <PageHeader title="Ahora" />
        <ErrorCard error={error ?? 'sin datos'} />
      </main>
    )
  }

  const s = snapshot
  const hoursToday = s.team_today.claude_hours
  const hoursCmp = compare(hoursToday, s.trailing_avg.claude_hours)
  const pushCmp = compare(s.team_today.pushes, s.trailing_avg.pushes)

  return (
    <main>
      <AutoRefresh seconds={60} />
      <Nav current="/" />
      {s.is_demo ? <DemoBanner /> : null}

      <PageHeader
        title="Ahora"
        lede="Qué le pasa al trabajo en curso."
        computedAt={s.computed_at}
      />

      {s.alerts.length > 0 ? (
        <Section title={`Atención (${s.alerts.length})`}>
          <div className="alerts">
            {s.alerts.map((a, i) => (
              <div key={i} className={`alert alert-${a.severity}`}>
                <Status kind={a.severity === 'critical' ? 'critical' : 'warning'}>
                  {a.severity === 'critical' ? 'Crítico' : 'Aviso'}
                </Status>
                <span>{a.message}</span>
              </div>
            ))}
          </div>
        </Section>
      ) : (
        <Section title="Atención">
          <div className="card">
            <Status kind="good">Nada atascado ahora mismo</Status>
          </div>
        </Section>
      )}

      <Section
        title="Pull requests abiertos"
        hint="Agrupados por qué los bloquea. El orden es el de atención: lo que impide avanzar primero."
      >
        <div className="reason-grid">
          {REASON_ORDER.map((reason) => (
            <div key={reason} className={`reason ${REASON_TONE[reason]}`}>
              <div className="reason-count">{s.by_reason[reason]}</div>
              <div className="reason-label">{REASON_LABEL[reason]}</div>
            </div>
          ))}
        </div>

        {s.blocked.length === 0 ? (
          <div className="card">
            <p style={{ margin: 0 }}>No hay ningún PR abierto.</p>
          </div>
        ) : (
          <div className="card">
            <table>
              <caption>
                Los más parados primero. El reloj cuenta desde el último avance real,
                no desde que se abrió.
              </caption>
              <thead>
                <tr>
                  <th scope="col">PR</th>
                  <th scope="col">Autor</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Parado</th>
                  <th scope="col">Tamaño</th>
                </tr>
              </thead>
              <tbody>
                {s.blocked.map((pr) => (
                  <tr key={`${pr.repo}#${pr.number}`}>
                    <td>
                      <a
                        href={`https://github.com/${pr.repo}/pull/${pr.number}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {pr.repo}#{pr.number}
                      </a>
                    </td>
                    <td>{pr.author ?? '—'}</td>
                    <td>
                      <span className="pill">{REASON_LABEL[pr.reason]}</span>
                    </td>
                    <td className="num">{duration(pr.stalled_hours)}</td>
                    <td className="num">
                      {pr.size_lines === null ? '—' : `${int(pr.size_lines)} líneas`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="CI en la rama principal">
        <div className="card">
          {s.main_ci.length === 0 ? (
            <p className="empty">Sin ejecuciones de CI registradas todavía.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Repositorio</th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                {s.main_ci.map((ci) => (
                  <tr key={ci.repo}>
                    <td>
                      <code>{ci.repo}</code>
                    </td>
                    <td>
                      {ci.conclusion === 'success' ? (
                        <Status kind="good">Verde</Status>
                      ) : ci.conclusion === 'failure' ? (
                        <Status kind="critical">En rojo</Status>
                      ) : (
                        <Status kind="neutral">{ci.conclusion ?? 'sin datos'}</Status>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      <Section title="Hoy, en el equipo">
        <div className="kpis">
          <Kpi
            label="Horas de herramienta"
            value={fmt(hoursToday, 1)}
            unit="h"
            note={hoursCmp.text}
          />
          <Kpi
            label="Push"
            value={int(s.team_today.pushes)}
            note={pushCmp.text}
          />
          <Kpi label="PR mergeados" value={int(s.team_today.merges)} />
          <Kpi
            label="PR abiertos ahora"
            value={int(s.open_prs)}
            note="WIP actual"
          />
        </div>
      </Section>

      <Section
        title="Hoy, por persona"
        hint="Orden alfabético. Actividad del día en curso, no de este instante."
      >
        <div className="card">
          <table>
            <caption>
              Un cero puede ser un día de reuniones, de diseño o de depuración en el
              navegador: nada de eso lo ve la telemetría. Compruébalo en Salud antes
              de leerlo como inactividad.
            </caption>
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col">Claude</th>
                <th scope="col">Codex (est.)</th>
                <th scope="col">Push</th>
                <th scope="col">Commits</th>
                <th scope="col">Revisiones</th>
              </tr>
            </thead>
            <tbody>
              {s.today.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    Nadie registrado todavía. Añade filas a <code>people</code> y
                    asigna equipos en <code>devices</code>.
                  </td>
                </tr>
              ) : (
                s.today.map((p) => (
                  <tr key={p.person_id ?? p.display_name}>
                    <td>
                      {p.person_id ? (
                        <a href={`/persona/${p.person_id}`}>{p.display_name}</a>
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
                    <td className={`num ${p.pushes ? '' : 'zero'}`}>
                      {p.pushes || '—'}
                    </td>
                    <td className={`num ${p.commits ? '' : 'zero'}`}>
                      {p.commits || '—'}
                    </td>
                    <td className={`num ${p.reviews ? '' : 'zero'}`}>
                      {p.reviews || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <ReadingNote>
        Esta vista mide el <strong>trabajo</strong>, no la presencia de nadie. No hay
        indicador de actividad en tiempo real por persona, y es deliberado: la
        telemetría solo ve Claude Code y Codex, así que marcaría como inactivo a
        quien está leyendo, pensando o en una reunión — justo el trabajo más difícil
        de hacer.
      </ReadingNote>

      <footer>
        Se actualiza al recibir eventos de GitHub y cada hora. Las métricas de
        herramienta se exportan cada 60 s, así que no pueden ser más frescas que eso.
      </footer>
    </main>
  )
}
