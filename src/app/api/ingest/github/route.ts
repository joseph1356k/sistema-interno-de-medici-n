import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseWebhook, verifySignature } from '@/lib/github'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Webhook de la organizacion: push, pull_request, pull_request_review. */
export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'webhook sin configurar' }, { status: 500 })
  }

  // El cuerpo se lee como texto: la firma se calcula sobre los bytes tal como
  // llegaron, y un parse+stringify la invalidaria.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifySignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'firma invalida' }, { status: 401 })
  }

  const eventType = request.headers.get('x-github-event') ?? ''
  const deliveryId = request.headers.get('x-github-delivery')

  if (eventType === 'ping') return NextResponse.json({ ok: true })

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'json invalido' }, { status: 400 })
  }

  const rows = parseWebhook(eventType, payload, deliveryId)
  if (rows.length === 0) return NextResponse.json({ stored: 0 })

  // GitHub permite reenvio manual durante 3 dias, asi que el mismo evento puede
  // llegar dos veces. La unicidad de dedup_key lo absorbe sin error.
  const { error } = await db()
    .from('git_events')
    .upsert(rows, { onConflict: 'dedup_key', ignoreDuplicates: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ stored: rows.length })
}
