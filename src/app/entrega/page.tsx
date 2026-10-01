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
  duration,
  fmt,
  int,
  pct,
} from '../components'
import { loadDelivery, type DeliveryMetrics } from '@/lib/analytics'

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

const BASIS_LABEL: Record<string, string> = {
  to_deploy: 'medido hasta el despliegue',
  to_merge: 'medido hasta el merge (sin despliegues registrados)',
  mixed: 'mezcla de repos con y sin despliegues',
}

export default async function EntregaPage() {
  let d: DeliveryMetrics
  try {
    d = await loadDelivery(WINDOW)
  } catch (e) {
    return (
      <main>
        <Nav current="/entrega" />
        <PageHeader title="Entrega" />
        <ErrorCard error={e} />
      </main>
    )
  }

  const cycle = d.cycle

  return (
    <main>
      <Nav current="/entrega" />
      <PageHeader
        title="Entrega"
        lede={`Cómo fluye el trabajo. Últimos ${WINDOW} días.`}
      />

      <Section
        title="DORA"
        hint="Las cuatro métricas estándar de rendimiento de entrega."
      >
        <div className="kpis">
          <Kpi
            label="Frecuencia de despliegue"
            value={fmt(d.dora.deploysPerWeek, 1)}
            unit="/semana"
            note={
              d.dora.deploysPerWeek === null
                ? 'sin despliegues de producción registrados'
                : 'solo producción'
            }
          />
          <Kpi
            label="Lead time del cambio"
            value={duration(d.dora.medianLeadTimeHours)}
            note={
              d.dora.leadTimeBasis
                ? BASIS_LABEL[d.dora.leadTimeBasis]
                : 'sin datos'
            }
          />
          <Kpi
            label="Tasa de fallo del cambio"
            value={pct(d.dora.changeFailureRate)}
            note={
              d.dora.changeFailureRate === null
                ? 'necesita despliegues de producción'
                : 'fallos y reversiones por despliegue'
            }
          />
          <Kpi
            label="Tiempo de restauración"
            value={duration(d.dora.medianRestoreHours)}
            note="de CI en rojo a verde"
          />
        </div>
        <ReadingNote>
          Solo cuentan los despliegues a <strong>producción</strong>: los de preview
          inflarían la frecuencia sin que nada llegue a nadie. Un cambio cuenta como
          fallido si su despliegue falló, si se volvió a desplegar una versión anterior
          (reversión), si se marcó a mano como reversión o si se mergeó un PR creado con
          el botón «Revert» de GitHub. Todo sale de metadatos: no se lee ningún mensaje
          ni título.
        </ReadingNote>
      </Section>

      <Section
        title="Tiempo de ciclo, desglosado"
        hint="El desglose es lo que dice dónde está el atasco. Medianas, no promedios."
      >
        <div className="kpis">
          <Kpi label="A primera revisión" value={duration(cycle.medianToFirstReview)} />
          <Kpi label="Revisión a aprobación" value={duration(cycle.medianReviewToApproval)} />
          <Kpi label="Aprobación a merge" value={duration(cycle.medianApprovalToMerge)} />
          <Kpi label="Total" value={duration(cycle.medianTotal)} />
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <LineChart
            points={cycle.weekly.map((w) => ({ label: w.week, value: w.median }))}
            label="Mediana semanal de horas desde que un PR está listo hasta que se mergea"
            unit="h"
          />
          <ChartTable
            caption="Mediana de horas de PR listo a merge, por semana."
            columns={['Semana del', 'Mediana', 'PR']}
            rows={cycle.weekly.map((w) => [w.week, duration(w.median), w.count])}
          />
        </div>
        <ReadingNote>
          Un PR que tarda días en mergearse es un problema de proceso, no de quien lo
          abrió. Si el tramo grande es «a primera revisión», falta capacidad de
          revisión; si es «aprobación a merge», el atasco está al final.
        </ReadingNote>
      </Section>

      <Section
        title="Tamaño de PR y velocidad de revisión"
        hint="Los PR grandes son la causa más común de revisiones lentas."
      >
        <div className="card">
          <BarChart
            points={d.sizeBuckets.map((b) => ({
              label: b.bucket.replace(/^\d+\.\s*/, ''),
              value: b.medianReviewHours ?? 0,
            }))}
            label="Mediana de horas hasta la primera revisión, por tamaño de PR"
            unit=" h"
          />
          <ChartTable
            caption="Tiempo de revisión y de merge por tramo de tamaño."
            columns={['Tramo', 'PR', 'A revisión', 'A merge']}
            rows={d.sizeBuckets.map((b) => [
              b.bucket,
              b.prs,
              duration(b.medianReviewHours),
              duration(b.medianMergeHours),
            ])}
          />
        </div>
        <ReadingNote>
          Si la diferencia entre tramos es grande, la palanca más barata para acelerar
          la entrega es partir los PR, no pedir revisiones más rápidas.
        </ReadingNote>
      </Section>

      <Section
        title="Trabajo en curso"
        hint="PR abiertos al final de cada día. Mucho WIP a la vez alarga el ciclo de todo."
      >
        <div className="card">
          <LineChart
            points={d.wip.map((w) => ({ label: w.day, value: w.open }))}
            label="PR abiertos simultáneamente, por día"
          />
          <ChartTable
            caption="PR abiertos al final de cada día."
            columns={['Día', 'PR abiertos']}
            rows={d.wip.slice(-30).map((w) => [w.day, w.open])}
          />
        </div>
      </Section>

      <div className="two-col">
        <Section title="Calidad de la entrega">
          <div className="card">
            <table>
              <caption>
                PR abandonados frente a mergeados, y mergeados sin que otra persona los
                revisara, por semana.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Semana</th>
                  <th scope="col">Mergeados</th>
                  <th scope="col">Abandonados</th>
                  <th scope="col">Tasa</th>
                  <th scope="col">Sin revisión</th>
                </tr>
              </thead>
              <tbody>
                {d.quality.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty">
                      Sin PR cerrados en el periodo.
                    </td>
                  </tr>
                ) : (
                  d.quality.slice(-8).map((q) => (
                    <tr key={q.week}>
                      <td>{q.week}</td>
                      <td className="num">{int(q.merged)}</td>
                      <td className="num">{int(q.abandoned)}</td>
                      <td className="num">{pct(q.abandonRate)}</td>
                      <td className={`num ${q.mergedWithoutReview ? '' : 'zero'}`}>
                        {q.mergedWithoutReview || '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <ReadingNote>
            «Sin revisión» es un riesgo del proceso, no de quien mergea: suele pasar
            cuando no hay nadie libre para revisar. No cuentan ni las revisiones de bots
            ni las del propio autor.
          </ReadingNote>
        </Section>

        <Section title="Retrabajo">
          <div className="card">
            {!d.churnEnabled ? (
              <p className="empty">
                Medición de retrabajo desactivada. Requiere configurar{' '}
                <code>FILE_HASH_SALT</code>, que permite contar archivos retocados sin
                guardar ninguna ruta.
              </p>
            ) : (
              <table>
                <caption>
                  Archivos vueltos a tocar en los 7 días siguientes. Señal de calidad,
                  no de esfuerzo.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Semana</th>
                    <th scope="col">Tocados</th>
                    <th scope="col">Retrabajados</th>
                    <th scope="col">Tasa</th>
                  </tr>
                </thead>
                <tbody>
                  {d.churn.slice(-8).map((c) => (
                    <tr key={c.week}>
                      <td>{c.week}</td>
                      <td className="num">{int(c.touched)}</td>
                      <td className="num">{int(c.reworked)}</td>
                      <td className="num">{pct(c.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Section>
      </div>
    </main>
  )
}
