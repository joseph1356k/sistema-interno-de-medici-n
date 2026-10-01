import {
  ChartTable,
  ErrorCard,
  Kpi,
  LineChart,
  Nav,
  PageHeader,
  PercentileBand,
  ReadingNote,
  Section,
  duration,
  fmt,
  int,
  usd,
} from '../components'
import { loadForecasts, type Forecasts } from '@/lib/analytics'
import { MIN_WEEKS } from '@/lib/forecast'

/**
 * Renderizado en cada peticion, no prerenderizado.
 *
 * Con `revalidate` Next las genera en tiempo de build, cuando no hay base de datos
 * disponible, y quedaria cacheada la pagina de error. La optimizacion aqui no es
 * cachear HTTP, es que los datos vienen ya agregados de `daily_rollup` y de las
 * vistas: cada carga son unas pocas consultas indexadas.
 */
export const dynamic = 'force-dynamic'

function TrendBadge({
  trend,
  unit,
}: {
  trend: Forecasts['cycleTrend']
  unit: string
}) {
  if (!trend) {
    return <span className="trend-flat">sin base suficiente</span>
  }
  if (trend.direction === 'unclear') {
    // Afirmar una dirección con un ajuste malo sería inventarse la conclusión.
    return (
      <span className="trend-flat">
        sin tendencia clara (R² {fmt(trend.r2, 2)})
      </span>
    )
  }
  const cls = trend.direction === 'improving' ? 'trend-up' : 'trend-down'
  const word = trend.direction === 'improving' ? 'mejorando' : 'empeorando'
  return (
    <span className={cls}>
      {word}: {trend.slopePerWeek > 0 ? '+' : ''}
      {fmt(trend.slopePerWeek, 2)} {unit}/semana (R² {fmt(trend.r2, 2)})
    </span>
  )
}

export default async function ProyeccionesPage() {
  let f: Forecasts
  try {
    f = await loadForecasts()
  } catch (e) {
    return (
      <main>
        <Nav current="/proyecciones" />
        <PageHeader title="Proyecciones" />
        <ErrorCard error={e} />
      </main>
    )
  }

  const noBase = (
    <div className="card">
      <p style={{ margin: 0 }}>
        Hacen falta al menos <strong>{MIN_WEEKS} semanas</strong> de historia para
        proyectar. Con menos, cualquier línea sería una invención con aspecto de dato.
      </p>
    </div>
  )

  return (
    <main>
      <Nav current="/proyecciones" />
      <PageHeader
        title="Proyecciones"
        lede="Qué cabe esperar, con su incertidumbre a la vista."
      />

      <ReadingNote>
        El throughput se proyecta por <strong>simulación de Monte Carlo</strong> sobre
        semanas reales, no con una media. Una media diría «4 PR por semana» y sonaría a
        plan; la realidad fue 1, 9, 2, 7, 0, 5 — y esa variabilidad es justo lo que hay
        que comunicar. Por eso cada cifra viene con su nivel de confianza.
      </ReadingNote>

      <Section
        title="PR en las próximas 4 semanas"
        hint="Más confianza significa una promesa más segura, y por tanto una cantidad menor."
      >
        {!f.throughput ? (
          noBase
        ) : (
          <>
            <div className="kpis">
              <Kpi
                label="50 % de confianza"
                value={int(f.throughput.atLeast.p50)}
                unit="o más"
              />
              <Kpi
                label="85 % de confianza"
                value={int(f.throughput.atLeast.p85)}
                unit="o más"
              />
              <Kpi
                label="95 % de confianza"
                value={int(f.throughput.atLeast.p95)}
                unit="o más"
                note="la cifra con la que comprometerse"
              />
            </div>
            <div className="card" style={{ marginTop: 16 }}>
              <PercentileBand
                p95={f.throughput.atLeast.p95}
                p85={f.throughput.atLeast.p85}
                p50={f.throughput.atLeast.p50}
                max={Math.ceil(f.throughput.mean * 1.6)}
                unit="PR en 4 semanas"
                lowerIsSafer
              />
              <p className="hint" style={{ marginTop: 8 }}>
                Basado en {f.throughput.basedOnWeeks} semanas. Media de la simulación:{' '}
                {fmt(f.throughput.mean, 1)} PR — como referencia, nunca como promesa.
              </p>
            </div>
          </>
        )}
      </Section>

      <Section
        title="Cuánto para 20 PR"
        hint="Aquí la confianza alta da MÁS semanas: es el plazo dentro del cual cabe esperar terminar."
      >
        {!f.completion ? (
          noBase
        ) : (
          <div className="kpis">
            <Kpi
              label="50 % de confianza"
              value={int(f.completion.withinWeeks.p50)}
              unit="semanas"
            />
            <Kpi
              label="85 % de confianza"
              value={int(f.completion.withinWeeks.p85)}
              unit="semanas"
            />
            <Kpi
              label="95 % de confianza"
              value={int(f.completion.withinWeeks.p95)}
              unit="semanas"
              note="el plazo que se puede prometer"
            />
          </div>
        )}
      </Section>

      <Section
        title="Coste equivalente a fin de mes"
        hint="A precio de API. Con suscripción, la factura no depende del uso: sirve para ver la tendencia."
      >
        {!f.cost ? (
          <div className="card">
            <p style={{ margin: 0 }}>
              Hacen falta al menos 3 días del mes. Proyectar desde el día 1 multiplica
              por 30 cualquier anomalía.
            </p>
          </div>
        ) : (
          <>
            <div className="kpis">
              <Kpi
                label="Acumulado este mes"
                value={usd(f.cost.monthToDate, 0)}
                note={`${f.cost.daysElapsed} de ${f.cost.daysInMonth} días`}
              />
              <Kpi
                label="Proyección a cierre"
                value={usd(f.cost.projectedMonthEnd, 0)}
                note="al ritmo actual"
              />
              {f.cost.previousMonths.slice(0, 2).map((m) => (
                <Kpi key={m.month} label={`Cerrado ${m.month}`} value={usd(m.cost, 0)} />
              ))}
            </div>
            {f.cost.previousMonths.length === 0 ? (
              <p className="hint">
                Sin meses anteriores todavía: la proyección no tiene con qué compararse.
              </p>
            ) : null}
          </>
        )}
      </Section>

      <Section title="Tendencias">
        <div className="card">
          <table>
            <thead>
              <tr>
                <th scope="col">Métrica</th>
                <th scope="col">Dirección</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Tiempo de ciclo (bajar es mejor)</td>
                <td>
                  <TrendBadge trend={f.cycleTrend} unit="h" />
                </td>
              </tr>
              <tr>
                <td>PR mergeados por semana (subir es mejor)</td>
                <td>
                  <TrendBadge trend={f.throughputTrend} unit="PR" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <ReadingNote>
          El R² dice cuánto describe la recta a los datos. Por debajo de 0,30 el panel
          dice «sin tendencia clara» en lugar de afirmar una mejora: con datos ruidosos,
          una recta siempre se puede dibujar, pero no significa nada.
        </ReadingNote>
      </Section>

      <Section title="Historia que alimenta las proyecciones">
        <div className="card">
          <LineChart
            points={f.weeklyMerges.map((w) => ({ label: w.week, value: w.value }))}
            label="PR mergeados por semana"
          />
          <ChartTable
            caption="PR mergeados por semana. Es la muestra que usa la simulación."
            columns={['Semana', 'PR mergeados']}
            rows={f.weeklyMerges.map((w) => [w.week, w.value])}
          />
        </div>

        {f.weeklyCycleMedian.length > 0 ? (
          <div className="card" style={{ marginTop: 16 }}>
            <LineChart
              points={f.weeklyCycleMedian.map((w) => ({ label: w.week, value: w.value }))}
              label="Mediana semanal del tiempo de ciclo"
              unit="h"
            />
            <ChartTable
              caption="Mediana del tiempo de ciclo por semana."
              columns={['Semana', 'Mediana']}
              rows={f.weeklyCycleMedian.map((w) => [w.week, duration(w.value)])}
            />
          </div>
        ) : null}
      </Section>
    </main>
  )
}
