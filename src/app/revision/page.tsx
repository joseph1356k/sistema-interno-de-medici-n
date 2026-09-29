import {
  BarChart,
  ChartTable,
  ErrorCard,
  Kpi,
  LineChart,
  Nav,
  PageHeader,
  ReadingNote,
  Section,
  Status,
  duration,
  fmt,
  int,
  pct,
  seconds,
} from '../components'
import { loadReviewCi, type ReviewCiMetrics } from '@/lib/analytics'

/**
 * Renderizado en cada peticion, no prerenderizado.
 *
 * Con `revalidate` Next las genera en tiempo de build, cuando no hay base de datos
 * disponible, y quedaria cacheada la pagina de error. La optimizacion aqui no es
 * cachear HTTP, es que los datos vienen ya agregados de `daily_rollup` y de las
 * vistas: cada carga son unas pocas consultas indexadas.
 */
export const dynamic = 'force-dynamic'

const WINDOW = 90

export default async function RevisionPage() {
  let m: ReviewCiMetrics
  try {
    m = await loadReviewCi(WINDOW)
  } catch (e) {
    return (
      <main>
        <Nav current="/revision" />
        <PageHeader title="Revisión y CI" />
        <ErrorCard error={e} />
      </main>
    )
  }

  const totalReviews = m.reviewers.reduce((s, r) => s + r.reviews, 0)
  const lastStamp = m.rubberStamp.at(-1)

  return (
    <main>
      <Nav current="/revision" />
      <PageHeader
        title="Revisión y CI"
        lede={`Dónde está el cuello de botella. Últimos ${WINDOW} días.`}
      />

      <Section title="Resumen">
        <div className="kpis">
          <Kpi label="Revisiones" value={int(totalReviews)} />
          <Kpi
            label="Fallo de CI"
            value={pct(m.ci.failureRate)}
            note="de todas las ejecuciones"
          />
          <Kpi
            label="Duración de CI"
            value={seconds(m.ci.medianDurationSeconds)}
            note="mediana"
          />
          <Kpi
            label="Intentos hasta verde"
            value={fmt(m.iterations.medianRuns, 1)}
            note="mediana por PR mergeado"
          />
        </div>
      </Section>

      <Section
        title="Carga de revisión"
        hint="Orden alfabético. Revisar es trabajo real que normalmente no se cuenta en ninguna parte."
      >
        <div className="card">
          <table>
            <caption>
              Revisiones hechas, no PR propios. Esta tabla existe para dar crédito a
              trabajo invisible, no para comparar a nadie.
            </caption>
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col">Revisiones</th>
                <th scope="col">Aprobadas</th>
                <th scope="col">Cambios pedidos</th>
                <th scope="col">Comentarios</th>
                <th scope="col">Por revisión</th>
              </tr>
            </thead>
            <tbody>
              {m.reviewers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    Sin revisiones registradas. Comprueba que el webhook incluye{' '}
                    <code>pull_request_review</code> y que los logins de GitHub están
                    en <code>people</code>.
                  </td>
                </tr>
              ) : (
                m.reviewers.map((r) => (
                  <tr key={r.display_name}>
                    <td>{r.display_name}</td>
                    <td className="num">{int(r.reviews)}</td>
                    <td className="num">{int(r.approvals)}</td>
                    <td className="num">{int(r.changesRequested)}</td>
                    <td className="num">{int(r.comments)}</td>
                    <td className="num">{fmt(r.commentsPerReview, 1)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        title="Quién revisa a quién"
        hint="Sirve para detectar que todo pasa por una sola persona."
      >
        <div className="card">
          {m.pairs.length === 0 ? (
            <p className="empty">Sin pares de revisión en el periodo.</p>
          ) : (
            <>
              <BarChart
                points={m.pairs
                  .slice(0, 10)
                  .map((p) => ({ label: `${p.reviewer} → ${p.author}`, value: p.reviews }))}
                label="Revisiones por par revisor-autor"
              />
              <ChartTable
                caption="Pares de revisión más frecuentes."
                columns={['Revisor', 'Autor', 'Revisiones']}
                rows={m.pairs.map((p) => [p.reviewer, p.author, p.reviews])}
              />
            </>
          )}
        </div>
        <ReadingNote>
          Si una sola persona aparece como revisora en casi todas las filas, es un
          riesgo de proceso: sus vacaciones bloquean al equipo entero.
        </ReadingNote>
      </Section>

      <Section title="Profundidad de revisión">
        <div className="card">
          {lastStamp ? (
            <>
              <p style={{ marginBottom: 12 }}>
                Última semana: {int(lastStamp.withoutComments)} de{' '}
                {int(lastStamp.approvals)} aprobaciones sin ningún comentario (
                {pct(lastStamp.rate)}).
              </p>
              <table>
                <caption>
                  Aprobaciones sin comentarios, por semana. Un PR de una línea no
                  necesita comentarios: esto solo es señal cuando la proporción es alta
                  en PR grandes.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Semana</th>
                    <th scope="col">Aprobaciones</th>
                    <th scope="col">Sin comentarios</th>
                    <th scope="col">Tasa</th>
                  </tr>
                </thead>
                <tbody>
                  {m.rubberStamp.slice(-8).map((r) => (
                    <tr key={r.week}>
                      <td>{r.week}</td>
                      <td className="num">{int(r.approvals)}</td>
                      <td className="num">{int(r.withoutComments)}</td>
                      <td className="num">{pct(r.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="empty">Sin aprobaciones registradas en el periodo.</p>
          )}
        </div>
      </Section>

      <Section title="Salud de CI">
        <div className="card">
          <LineChart
            points={m.ci.weekly.map((w) => ({ label: w.week, value: (w.rate ?? 0) * 100 }))}
            label="Porcentaje de ejecuciones de CI que fallan, por semana"
            unit=" %"
          />
          <ChartTable
            caption="Ejecuciones de CI y fallos por semana."
            columns={['Semana', 'Ejecuciones', 'Fallidas', 'Tasa']}
            rows={m.ci.weekly.map((w) => [w.week, w.runs, w.failed, pct(w.rate)])}
          />
        </div>

        {m.ci.byWorkflow.length > 0 ? (
          <div className="card" style={{ marginTop: 16 }}>
            <table>
              <caption>Por workflow, ordenado por número de ejecuciones.</caption>
              <thead>
                <tr>
                  <th scope="col">Workflow</th>
                  <th scope="col">Ejecuciones</th>
                  <th scope="col">Tasa de fallo</th>
                </tr>
              </thead>
              <tbody>
                {m.ci.byWorkflow.map((w) => (
                  <tr key={w.name}>
                    <td>{w.name}</td>
                    <td className="num">{int(w.runs)}</td>
                    <td className="num">{pct(w.failureRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>

      <Section
        title="Tests inestables"
        hint="El mismo workflow falla y pasa sobre el MISMO commit. Si el código no cambió y el resultado sí, el problema es el test."
      >
        <div className="card">
          {m.flaky.length === 0 ? (
            <p className="empty">
              <Status kind="good">Ninguno detectado</Status>
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Repositorio</th>
                  <th scope="col">Workflow</th>
                  <th scope="col">Commit</th>
                  <th scope="col">Fallos</th>
                  <th scope="col">Éxitos</th>
                </tr>
              </thead>
              <tbody>
                {m.flaky.map((f) => (
                  <tr key={`${f.repo}:${f.name}:${f.head_sha}`}>
                    <td>
                      <code>{f.repo}</code>
                    </td>
                    <td>{f.name}</td>
                    <td>
                      <code>{f.head_sha.slice(0, 8)}</code>
                    </td>
                    <td className="num">{f.failures}</td>
                    <td className="num">{f.successes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <ReadingNote>
          Un test inestable cuesta más de lo que parece: enseña al equipo a volver a
          lanzar CI sin leer el error, y entonces los fallos reales también se ignoran.
        </ReadingNote>
      </Section>

      {m.iterations.worst.length > 0 ? (
        <Section title="PR con más intentos de CI">
          <div className="card">
            <table>
              <caption>
                Mediana del equipo: {fmt(m.iterations.medianFailed, 1)} ejecuciones
                fallidas por PR mergeado.
              </caption>
              <thead>
                <tr>
                  <th scope="col">PR</th>
                  <th scope="col">Ejecuciones fallidas</th>
                </tr>
              </thead>
              <tbody>
                {m.iterations.worst.map((w) => (
                  <tr key={`${w.repo}#${w.number}`}>
                    <td>
                      <a
                        href={`https://github.com/${w.repo}/pull/${w.number}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {w.repo}#{w.number}
                      </a>
                    </td>
                    <td className="num">{w.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}
    </main>
  )
}
