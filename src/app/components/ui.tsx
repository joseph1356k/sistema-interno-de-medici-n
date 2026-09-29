import Link from 'next/link'
import { ago } from './format'

export function Kpi({
  label,
  value,
  unit,
  note,
  tone,
}: {
  label: string
  value: string
  unit?: string
  note?: string
  tone?: 'good' | 'warning' | 'critical'
}) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value${tone ? ` kpi-${tone}` : ''}`}>
        {value}
        {unit ? <span className="kpi-unit"> {unit}</span> : null}
      </div>
      {note ? <div className="kpi-note">{note}</div> : null}
    </div>
  )
}

/** Estado con icono + texto: el color nunca carga el significado por si solo. */
export function Status({
  kind,
  children,
}: {
  kind: 'good' | 'warning' | 'critical' | 'neutral'
  children: React.ReactNode
}) {
  return (
    <span className={`status status-${kind}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  )
}

export function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2>{title}</h2>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  )
}

const VIEWS = [
  { href: '/', label: 'Ahora' },
  { href: '/entrega', label: 'Entrega' },
  { href: '/revision', label: 'Revisión y CI' },
  { href: '/ia', label: 'IA y coste' },
  { href: '/proyecciones', label: 'Proyecciones' },
  { href: '/salud', label: 'Salud' },
] as const

export function Nav({ current }: { current: string }) {
  return (
    <nav className="nav" aria-label="Vistas del panel">
      {VIEWS.map((v) => (
        <Link
          key={v.href}
          href={v.href}
          className={v.href === current ? 'nav-item nav-current' : 'nav-item'}
          aria-current={v.href === current ? 'page' : undefined}
        >
          {v.label}
        </Link>
      ))}
    </nav>
  )
}

/**
 * Encabezado con la antigüedad del dato. Está a la vista a propósito: la
 * telemetría de Claude Code se exporta cada 60 s, así que dar sensación de
 * tiempo real absoluto sería engañoso.
 */
export function PageHeader({
  title,
  lede,
  computedAt,
  children,
}: {
  title: string
  lede?: string
  computedAt?: string | null
  children?: React.ReactNode
}) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {lede ? <p className="lede">{lede}</p> : null}
      {computedAt ? (
        <p className="freshness">
          Datos calculados {ago(computedAt)}
          {children}
        </p>
      ) : (
        children
      )}
    </header>
  )
}

/** Aviso de datos de demostración. Visible siempre que existan. */
export function DemoBanner() {
  return (
    <div className="banner" role="status">
      <strong>Datos de demostración.</strong> Estos números son inventados, para que
      el panel se pueda leer antes de conectar los equipos. Se borran con{' '}
      <code>npm run seed:clear</code>.
    </div>
  )
}

/** Explicación de cómo leer una métrica. Sirve para que nadie la use mal. */
export function ReadingNote({ children }: { children: React.ReactNode }) {
  return <p className="note">{children}</p>
}

export function ErrorCard({ error }: { error: unknown }) {
  return (
    <div className="card">
      <p>
        No se pudo leer la base de datos. Revisa <code>SUPABASE_URL</code> y{' '}
        <code>SUPABASE_SERVICE_ROLE_KEY</code>, y que las migraciones de{' '}
        <code>db/migrations/</code> estén aplicadas.
      </p>
      <p className="error">{String(error)}</p>
    </div>
  )
}
