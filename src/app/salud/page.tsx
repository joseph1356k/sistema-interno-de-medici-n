import {
  ErrorCard,
  Kpi,
  Nav,
  PageHeader,
  ReadingNote,
  Section,
  Status,
  duration,
  int,
  shortDate,
} from '../components'
import {
  hasDemoData,
  loadDeviceHealth,
  loadUnmappedActivity,
  type DeviceHealthRow,
} from '@/lib/metrics'

export const dynamic = 'force-dynamic'

const DEMO_MESSAGE: Record<string, string> = {
  borrado: 'Datos de demostración borrados. A partir de ahora el panel solo muestra datos reales.',
  error: 'No se pudieron borrar los datos de demostración. Revisa los registros del servidor.',
}

export default async function SaludPage({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string }>
}) {
  const { demo: demoResult } = await searchParams
  let devices: DeviceHealthRow[]
  let unmapped: { identity: string; events: number; last_seen: string }[]
  let demo: boolean

  try {
    ;[devices, unmapped, demo] = await Promise.all([
      loadDeviceHealth(),
      loadUnmappedActivity(),
      hasDemoData(),
    ])
  } catch (e) {
    return (
      <main>
        <Nav current="/salud" />
        <PageHeader title="Salud" />
        <ErrorCard error={e} />
      </main>
    )
  }

  const reporting = devices.filter((d) => d.claude_reporting || d.codex_reporting)
  const unassigned = devices.filter((d) => !d.display_name)
  const quiet = devices.filter((d) => !d.claude_reporting && !d.codex_reporting)

  return (
    <main>
      <Nav current="/salud" />
      <PageHeader
        title="Salud"
        lede="¿Me puedo creer estos datos?"
      />

      <ReadingNote>
        Esta vista no es depuración, es parte del producto. En Windows la
        configuración de Codex es <strong>cooperativa</strong>: el usuario la puede
        sobrescribir y no hay forma de forzarla. Sin esta página, un cero en el panel
        se leería como inactividad de una persona cuando en realidad es un fallo de
        instalación.
      </ReadingNote>

      <Section title="Resumen">
        <div className="kpis">
          <Kpi label="Equipos registrados" value={int(devices.length)} />
          <Kpi
            label="Reportando"
            value={int(reporting.length)}
            tone={reporting.length === devices.length ? 'good' : undefined}
          />
          <Kpi
            label="En silencio"
            value={int(quiet.length)}
            tone={quiet.length > 0 ? 'critical' : 'good'}
            note={quiet.length > 0 ? 'revisar instalación' : undefined}
          />
          <Kpi
            label="Sin asignar"
            value={int(unassigned.length)}
            tone={unassigned.length > 0 ? 'warning' : 'good'}
            note={unassigned.length > 0 ? 'falta el mapeo a persona' : undefined}
          />
        </div>
      </Section>

      <Section title="Equipos">
        <div className="card">
          <table>
            <caption>
              Un equipo que no reporta hace que los datos de esa persona salgan a cero
              sin que nadie se dé cuenta.
            </caption>
            <thead>
              <tr>
                <th scope="col">Equipo</th>
                <th scope="col">Asignado a</th>
                <th scope="col">Claude Code</th>
                <th scope="col">Codex</th>
                <th scope="col">Última señal</th>
              </tr>
            </thead>
            <tbody>
              {devices.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    Ningún equipo ha reportado todavía. Instala el agente en un PC y
                    vuelve aquí.
                  </td>
                </tr>
              ) : (
                devices.map((d) => (
                  <tr key={d.hostname}>
                    <td>
                      <code>{d.hostname}</code>
                    </td>
                    <td>
                      {d.display_name ?? <Status kind="warning">Sin asignar</Status>}
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
      </Section>

      <Section
        title="Actividad sin atribuir"
        hint="Identidades de git o GitHub que no corresponden a nadie registrado."
      >
        <div className="card">
          {unmapped.length === 0 ? (
            <p className="empty">
              <Status kind="good">Toda la actividad está atribuida</Status>
            </p>
          ) : (
            <table>
              <caption>
                Lo normal es alguien que no configuró <code>git config user.email</code>,
                o un login de GitHub que falta en la tabla <code>people</code>. Su
                trabajo no aparece en ningún sitio hasta que se arregle.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Identidad</th>
                  <th scope="col">Eventos</th>
                  <th scope="col">Visto por última vez</th>
                </tr>
              </thead>
              <tbody>
                {unmapped.map((u) => (
                  <tr key={u.identity}>
                    <td>
                      <code>{u.identity}</code>
                    </td>
                    <td className="num">{int(u.events)}</td>
                    <td className="num">{shortDate(u.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      <Section title="Límites conocidos de la medición">
        <div className="card">
          <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--text-secondary)' }}>
            <li>
              El tiempo de Codex es <strong>estimado</strong>, no medido: se deriva de
              los huecos entre eventos con un tope de 5 minutos. No es comparable de tú
              a tú con el de Claude Code.
            </li>
            <li>
              La app de escritorio de Codex no exporta registros, así que ese uso puede
              quedar subcontado.
            </li>
            <li>
              No se mide el chat de Claude en navegador ni el tiempo en github.com:
              requeriría un monitor de ventanas, que se decidió no instalar.
            </li>
            <li>
              Las cifras de coste son las que reporta la propia herramienta, a precio de
              API. Con suscripción no son lo que se paga: sirven para comparar.
            </li>
            <li>
              Un cero en cualquier vista puede ser un día de reuniones, de diseño o de
              depuración fuera del editor. La telemetría no ve nada de eso.
            </li>
          </ul>
        </div>
      </Section>

      {demo ? (
        <Section
          title="Datos de demostración"
          hint="Las 16 semanas inventadas que se sembraron para poder ver el panel antes de conectar los equipos."
        >
          <div className="card" id="demo">
            <p style={{ marginTop: 0 }}>
              Bórralos antes de empezar a medir de verdad: mezclados con los reales,
              falsean todas las medias y las proyecciones. Solo se borran filas marcadas
              como demo; los datos reales no se tocan. No se puede deshacer.
            </p>
            <form method="post" action="/api/demo/clear" className="danger-form">
              <label>
                <input type="checkbox" name="confirm" value="si" required /> Entiendo
                que se borran todos los datos de demostración
              </label>
              <button type="submit">Borrar datos de demostración</button>
            </form>
          </div>
        </Section>
      ) : null}

      {demoResult && DEMO_MESSAGE[demoResult] ? (
        <p className={demoResult === 'error' ? 'error' : 'hint'} role="status">
          {DEMO_MESSAGE[demoResult]}
        </p>
      ) : null}
    </main>
  )
}
