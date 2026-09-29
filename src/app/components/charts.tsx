/**
 * Graficos del panel, en SVG en linea.
 *
 * Reglas que se siguen en todos:
 *  - Los colores salen de tokens CSS, asi que el modo oscuro funciona sin duplicar
 *    nada y sin voltear colores automaticamente.
 *  - Una sola serie no lleva leyenda: el titulo la nombra.
 *  - Cada grafico va acompanado de su tabla equivalente (`<ChartTable>`), que es
 *    lo que lo hace legible con lector de pantalla y lo que permite leer valores
 *    exactos.
 *  - Nada de doble eje Y: dos magnitudes distintas van en dos graficos.
 */

import { fmt } from './format'

const W = 680
const H = 200
const PAD = { l: 48, r: 16, t: 16, b: 34 }

function scaleX(i: number, count: number): number {
  if (count <= 1) return PAD.l
  return PAD.l + (i * (W - PAD.l - PAD.r)) / (count - 1)
}

function niceMax(max: number): number {
  if (max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max))
  return Math.ceil(max / magnitude) * magnitude
}

export interface Point {
  label: string
  value: number
}

/** Tabla equivalente de un grafico. Siempre presente, nunca opcional. */
export function ChartTable({
  caption,
  columns,
  rows,
}: {
  caption: string
  columns: string[]
  rows: (string | number)[][]
}) {
  if (rows.length === 0) return null
  return (
    <details className="chart-table">
      <summary>Ver los datos en tabla</summary>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className={j === 0 ? '' : 'num'}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

export function NoData({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>
}

/** Linea de tendencia de una sola serie. */
export function LineChart({
  points,
  label,
  unit = '',
  minPoints = 2,
}: {
  points: Point[]
  label: string
  unit?: string
  minPoints?: number
}) {
  if (points.length < minPoints) {
    return <NoData>Hacen falta al menos {minPoints} puntos para dibujar esto.</NoData>
  }

  const max = niceMax(Math.max(...points.map((p) => p.value)))
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b)
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(i, points.length)},${y(p.value)}`)
    .join(' ')
  const ticks = [0, max / 2, max]

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${label}. ${points.length} puntos, de ${points[0]!.label} a ${points[points.length - 1]!.label}.`}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line className="chart-grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
          <text className="chart-axis" x={PAD.l - 8} y={y(t) + 4} textAnchor="end">
            {fmt(t, t < 10 ? 1 : 0)}
            {unit}
          </text>
        </g>
      ))}
      <line className="chart-baseline" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
      <path className="chart-line" d={path} />
      {points.map((p, i) => (
        <circle
          key={p.label}
          className="chart-dot"
          cx={scaleX(i, points.length)}
          cy={y(p.value)}
          r={3.5}
        >
          <title>{`${p.label}: ${fmt(p.value)}${unit}`}</title>
        </circle>
      ))}
      {/* Solo primera y ultima etiqueta: mas se solapan. */}
      <text className="chart-axis" x={PAD.l} y={H - 10} textAnchor="start">
        {points[0]!.label}
      </text>
      <text className="chart-axis" x={W - PAD.r} y={H - 10} textAnchor="end">
        {points[points.length - 1]!.label}
      </text>
    </svg>
  )
}

/**
 * Barras horizontales, para composicion y comparacion entre categorias. Las
 * etiquetas van a la izquierda porque los nombres de categoria son largos y en
 * vertical se solaparian.
 */
export function BarChart({
  points,
  label,
  unit = '',
  maxBars = 12,
}: {
  points: Point[]
  label: string
  unit?: string
  maxBars?: number
}) {
  const rows = points.slice(0, maxBars)
  if (rows.length === 0) return <NoData>Sin datos en el periodo.</NoData>

  const max = Math.max(...rows.map((p) => p.value), 1)
  const barH = 22
  const gap = 8
  const labelW = 150
  const height = rows.length * (barH + gap)
  const trackW = W - labelW - 70

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={`${label}. ${rows.length} categorías.`}
    >
      {rows.map((p, i) => {
        const y = i * (barH + gap)
        const w = Math.max((p.value / max) * trackW, p.value > 0 ? 3 : 0)
        return (
          <g key={p.label}>
            <text className="chart-label" x={0} y={y + barH / 2 + 4}>
              {p.label.length > 24 ? `${p.label.slice(0, 23)}…` : p.label}
            </text>
            {/* Extremo redondeado de 4px anclado en la base. */}
            <rect
              className="chart-bar"
              x={labelW}
              y={y}
              width={w}
              height={barH}
              rx={4}
            />
            <text
              className="chart-label"
              x={labelW + w + 8}
              y={y + barH / 2 + 4}
            >
              {fmt(p.value, p.value < 10 ? 1 : 0)}
              {unit}
            </text>
            <title>{`${p.label}: ${fmt(p.value)}${unit}`}</title>
          </g>
        )
      })}
    </svg>
  )
}

/**
 * Banda de percentiles para el Monte Carlo: la franja ancha es el rango entre el
 * 95% y el 50% de confianza, y la marca es la mediana. Mostrar un solo numero
 * ocultaria justo lo que hace util la simulacion.
 */
export function PercentileBand({
  p95,
  p85,
  p50,
  max,
  unit,
  lowerIsSafer,
}: {
  p95: number
  p85: number
  p50: number
  max: number
  unit: string
  lowerIsSafer: boolean
}) {
  const width = 680
  const height = 84
  const pad = 20
  const track = width - pad * 2
  const top = Math.max(max, p95, p50, 1)
  const x = (v: number) => pad + (v / top) * track

  const lo = Math.min(p95, p50)
  const hi = Math.max(p95, p50)

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Rango de la simulación: ${fmt(p95)} con 95% de confianza, ${fmt(p50)} con 50%.`}
    >
      <rect className="band-track" x={pad} y={30} width={track} height={16} rx={4} />
      <rect
        className="band-range"
        x={x(lo)}
        y={30}
        width={Math.max(x(hi) - x(lo), 3)}
        height={16}
        rx={4}
      />
      <line className="band-mark" x1={x(p85)} x2={x(p85)} y1={24} y2={52} />
      <text className="chart-label" x={x(lo)} y={22} textAnchor="middle">
        {fmt(lo, 0)}
      </text>
      <text className="chart-label" x={x(hi)} y={22} textAnchor="middle">
        {fmt(hi, 0)}
      </text>
      <text className="chart-axis" x={pad} y={70}>
        {lowerIsSafer ? 'más seguro' : 'más conservador'}
      </text>
      <text className="chart-axis" x={width - pad} y={70} textAnchor="end">
        {unit}
      </text>
    </svg>
  )
}
