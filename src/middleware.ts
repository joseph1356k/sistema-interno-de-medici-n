import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, isValidSession } from '@/lib/session'

/**
 * Protege el panel. Deja pasar las rutas de ingesta, que se autentican con su
 * propio token o con la firma de GitHub.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (
    pathname.startsWith('/api/ingest') ||
    pathname.startsWith('/api/cron') ||
    pathname.startsWith('/api/login') ||
    pathname === '/login'
  ) {
    return NextResponse.next()
  }

  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next()
  }

  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  return NextResponse.redirect(url)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
