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
  fmt,
  int,
  pct,
  usd,
} from '../components'
import { loadAi, type AiMetrics } from '@/lib/analytics'
import { loadPeople, type PersonRow } from '@/lib/metrics'

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

export default async function IaPage() {
  let ai: AiMetrics
  let people: PersonRow[]
  try {
    ;[ai, people] = await Promise.all([loadAi(WINDOW), loadPeople(WINDOW)])
  } catch (e) {
    return (
      <main>
        <Nav current="/ia" />
        <PageHeader title="IA y coste" />
        <ErrorCard error={e} />
      </main>
    )
  }

  const t = ai.totals

  return (
    <main>
      <Nav current="/ia" />
      <PageHeader
        title="IA y coste"
        lede={`¿Vale lo que cuesta? Últimos ${WINDOW} días.`}
      />

      <Section title="Resumen">
        <div className="kpis">
          <Kpi label="Horas en Claude Code" value={fmt(t.claudeHours, 0)} unit="h" />
          <Kpi
            label="Horas en Codex"
            value={fmt(t.codexHours, 0)}
            unit="h"
            note="estimadas, no medidas"
          />
          <Kpi label="Coste" value={usd(t.costUsd, 0)} note="aproximado" />
          <Kpi
            label="Coste por PR mergeado"
            value={usd(ai.medianCostPerPr, 2)}
            note="mediana diaria"
          />
          <Kpi
            label="Aceptación de ediciones"
            value={pct(t.acceptRate)}
            note="sugerencias aceptadas"
          />
          <Kpi label="Sesiones" value={int(t.sessions)} />
        </div>
      </Section>

      <ReadingNote>
        El <strong>coste por PR mergeado</strong> es la cifra que responde la pregunta
        original. Las horas por sí solas no: alguien puede pasar mucho tiempo con la
        herramienta abierta y entregar poco, o al revés. La aceptación de ediciones
        mide la <em>calidad</em> del uso, no la cantidad.
      </ReadingNote>

      <Section title="Coste por semana">
        <div className="card">
          <LineChart
            points={ai.weeklyCost.map((w) => ({ label: w.week, value: w.value }))}
            label="Coste semanal de herramientas de IA en dólares"
            unit=" $"
          />
          <ChartTable
            caption="Coste por semana."
            columns={['Semana', 'Coste']}
            rows={ai.weeklyCost.map((w) => [w.week, usd(w.value, 2)])}
          />
        </div>
      </Section>

      <Section title="Horas de herramienta por semana">
        <div className="card">
          <LineChart
            points={ai.weeklyHours.map((w) => ({ label: w.week, value: w.value }))}
            label="Horas activas de Claude Code y Codex por semana"
            unit=" h"
          />
          <ChartTable
            caption="Horas de herramienta por semana."
            columns={['Semana', 'Horas']}
            rows={ai.weeklyHours.map((w) => [w.week, fmt(w.value, 1)])}
          />
        </div>
      </Section>

      <Section
        title="Adopción"
        hint="En cuántos de los últimos 14 días tuvo cada persona actividad de herramienta."
      >
        <div className="card">
          <BarChart
            points={ai.adoption.map((a) => ({
              label: a.display_name,
              value: a.activeDays,
            }))}
            label="Días con actividad de herramienta en los últimos 14"
            unit=" d"
          />
          <ChartTable
            caption="Días activos de 14."
            columns={['Persona', 'Días activos']}
            rows={ai.adoption.map((a) => [a.display_name, `${a.activeDays} / ${a.ofDays}`])}
          />
        </div>
        <ReadingNote>
          Aquí sí tiene sentido mirar por persona: si alguien no usa una herramienta que
          la empresa paga, lo útil es preguntarle por qué y ofrecer formación, no
          señalarlo. Un cero también puede ser un fallo de instalación — compruébalo en
          Salud.
        </ReadingNote>
      </Section>

      <Section
        title="Por persona"
        hint="Orden alfabético. No es un ranking."
      >
        <div className="card">
          <table>
            <caption>
              Uso de herramientas y entrega en el mismo periodo, para poder mirarlos
              juntos en vez de por separado.
            </caption>
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col">Claude</th>
                <th scope="col">Codex (est.)</th>
                <th scope="col">Coste</th>
                <th scope="col">Aceptación</th>
                <th scope="col">PR mergeados</th>
                <th scope="col">Revisiones</th>
              </tr>
            </thead>
            <tbody>
              {people.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty">
                    Nadie registrado todavía.
                  </td>
                </tr>
              ) : (
                people.map((p) => (
                  <tr key={p.person_id}>
                    <td>
                      <a href={`/persona/${p.person_id}`}>{p.display_name}</a>
                    </td>
                    <td className={`num ${p.claude_hours ? '' : 'zero'}`}>
                      {p.claude_hours ? `${fmt(p.claude_hours, 1)} h` : '—'}
                    </td>
                    <td className={`num ${p.codex_hours_est ? '' : 'zero'}`}>
                      {p.codex_hours_est ? `${fmt(p.codex_hours_est, 1)} h` : '—'}
                    </td>
                    <td className="num">{usd(p.cost_usd, 2)}</td>
                    <td className="num">{pct(p.accept_rate)}</td>
                    <td className={`num ${p.prs_merged ? '' : 'zero'}`}>
                      {p.prs_merged || '—'}
                    </td>
                    <td className={`num ${p.reviews_given ? '' : 'zero'}`}>
                      {p.reviews_given || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <footer>
        Las cifras de coste son aproximaciones que reporta la propia herramienta. El
        tiempo de Codex es una estimación derivada de los huecos entre eventos, porque
        Codex no expone una métrica de tiempo activo: no es comparable de tú a tú con
        el de Claude Code.
      </footer>
    </main>
  )
}
