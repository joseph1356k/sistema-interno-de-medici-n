import { NextResponse } from 'next/server'
import { SESSION_COOKIE, safeEqual, sessionToken } from '@/lib/session'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const expected = process.env.DASHBOARD_PASSWORD
  if (!expected) {
    return NextResponse.json({ error: 'panel sin configurar' }, { status: 500 })
  }

  const form = await request.formData()
  const given = String(form.get('password') ?? '')

  const givenToken = await sessionToken(given)
  const expectedToken = await sessionToken(expected)

  if (!safeEqual(givenToken, expectedToken)) {
    return NextResponse.redirect(new URL('/login?error=1', request.url))
  }

  const response = NextResponse.redirect(new URL('/', request.url))
  response.cookies.set(SESSION_COOKIE, expectedToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return response
}
