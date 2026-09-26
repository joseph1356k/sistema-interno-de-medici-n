/** Piezas compartidas del panel. */

export function Kpi({
  label,
  value,
  unit,
  note,
}: {
  label: string
  value: string
  unit?: string
  note?: string
}) {
  return (
    <div className="card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">
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
  kind: 'good' | 'warning' | 'critical'
  children: React.ReactNode
}) {
  return (
    <span className={`status status-${kind}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  )
}

export function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('es', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** Horas legibles: minutos por debajo de una hora, dias por encima de 48. */
export function duration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${fmt(hours, 1)} h`
  return `${fmt(hours / 24, 1)} d`
}

/**
 * Linea de tendencia. Una sola serie, asi que no necesita leyenda: el titulo la
 * nombra. Los valores van etiquetados en cada punto porque son pocos.
 */
export function TrendLine({
  points,
  label,
}: {
  points: { week: string; medianHours: number; count: number }[]
  label: string
}) {
  if (points.length < 2) {
    return (
      <p className="empty">
        Hacen falta al menos dos semanas con merges para dibujar la tendencia.
      </p>
    )
  }

  const W = 680
  const H = 200
  const padL = 44
  const padR = 16
  const padT = 16
  const padB = 34

  const max = Math.max(...points.map((p) => p.medianHours), 1)
  const scaleMax = Math.ceil(max * 1.15)
  const x = (i: number) =>
    padL + (i * (W - padL - padR)) / Math.max(points.length - 1, 1)
  const y = (v: number) => padT + (1 - v / scaleMax) * (H - padT - padB)

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.medianHours)}`).join(' ')
  const ticks = [0, scaleMax / 2, scaleMax]

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${label}. Serie semanal de ${points.length} puntos, de ${points[0]!.week} a ${points[points.length - 1]!.week}.`}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line className="chart-grid" x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} />
          <text className="chart-axis" x={padL - 8} y={y(t) + 4} textAnchor="end">
            {Math.round(t)}h
          </text>
        </g>
      ))}
      <line
        className="chart-baseline"
        x1={padL}
        x2={W - padR}
        y1={y(0)}
        y2={y(0)}
      />
      <path className="chart-line" d={path} />
      {points.map((p, i) => (
        <g key={p.week}>
          <circle className="chart-dot" cx={x(i)} cy={y(p.medianHours)} r={4} />
          <title>{`Semana del ${p.week}: ${fmt(p.medianHours)} h de mediana, ${p.count} PR`}</title>
        </g>
      ))}
      {/* Solo primera y ultima etiqueta del eje X: mas se solapan. */}
      <text className="chart-axis" x={padL} y={H - 10} textAnchor="start">
        {points[0]!.week}
      </text>
      <text className="chart-axis" x={W - padR} y={H - 10} textAnchor="end">
        {points[points.length - 1]!.week}
      </text>
    </svg>
  )
}
