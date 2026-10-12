/**
 * Ruta a la que envia de verdad el collector de cada PC.
 *
 * El exportador `otlphttp` no usa el endpoint tal cual: le anade `/v1/metrics` y
 * `/v1/logs`. Con la clave apuntando a `/api/ingest/otlp`, cada envio iba a
 * `/api/ingest/otlp/v1/metrics`, que no existia: 404, reintentos durante 24 horas
 * y despues los datos perdidos. La ruta base ya distingue metricas de eventos por
 * el contenido, asi que esta solo la reexpone.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export { POST } from '../../route'
