/** Formateo compartido. */

export function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('es', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function int(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('es')
}

export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)} %`
}

export function usd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `$${value.toLocaleString('es', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`
}

/** Horas legibles: minutos por debajo de una hora, dias por encima de 48. */
export function duration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${fmt(hours, 1)} h`
  return `${fmt(hours / 24, 1)} d`
}

export function seconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value < 60) return `${Math.round(value)} s`
  return `${fmt(value / 60, 1)} min`
}

/** "hace 40 s", para que la frescura del dato quede a la vista. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const secs = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (secs < 90) return `hace ${Math.round(secs)} s`
  if (secs < 5400) return `hace ${Math.round(secs / 60)} min`
  if (secs < 172800) return `hace ${Math.round(secs / 3600)} h`
  return `hace ${Math.round(secs / 86400)} d`
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}
