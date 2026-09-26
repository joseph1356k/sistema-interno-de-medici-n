import { timingSafeEqual } from 'node:crypto'

/**
 * Comprueba el Bearer token que presenta el OTel Collector de cada PC.
 * Comparacion en tiempo constante.
 */
export function checkIngestToken(authorization: string | null): boolean {
  const expected = process.env.INGEST_TOKEN
  if (!expected) return false
  if (!authorization?.startsWith('Bearer ')) return false

  const given = authorization.slice('Bearer '.length)
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
