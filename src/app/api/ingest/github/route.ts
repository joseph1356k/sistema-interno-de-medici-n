import { NextResponse } from 'next/server'
import { verifySignature } from '@/lib/github'
import { affectsBoard, ingestWebhook } from '@/lib/ingest-github'
import { requestRefresh } from '@/lib/live'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Webhook de la organizacion. Los tipos de evento que hay que marcar en GitHub
 * estan en SUBSCRIBED_EVENTS (src/lib/ingest-github.ts).
 */
export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'webhook sin configurar' }, { status: 500 })
  }

  // El cuerpo se lee como texto: la firma se calcula sobre los bytes tal como
  // llegaron, y un parse+stringify la invalidaria.
  const rawBody = await request.text()

  if (!verifySignature(rawBody, request.headers.get('x-hub-signature-256'), secret)) {
    return NextResponse.json({ error: 'firma invalida' }, { status: 401 })
  }

  const eventType = request.headers.get('x-github-event') ?? ''
  if (eventType === 'ping') return NextResponse.json({ ok: true })

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'json invalido' }, { status: 400 })
  }

  try {
    const stored = await ingestWebhook(
      eventType,
      payload,
      request.headers.get('x-github-delivery'),
    )

    // El tablero se recalcula aqui, no al visitarlo: la vista se refresca cada
    // minuto y por cada pestana abierta. Si ya se recalculo hace nada (rafagas de
    // CI), solo se marca como pendiente. Se espera el resultado a proposito, porque
    // en serverless una promesa sin await puede morir con la funcion.
    if (affectsBoard(eventType)) {
      try {
        await requestRefresh()
      } catch (e) {
        // Un fallo al refrescar no debe perder el evento, que ya esta guardado.
        console.error('no se pudo refrescar el tablero:', e)
      }
    }

    return NextResponse.json({ stored })
  } catch (e) {
    // 500 a proposito: GitHub no reintenta, pero el job de reconciliacion si
    // recupera lo perdido, y el error queda en los registros para poder verlo.
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
