import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { refreshSnapshot } from '@/lib/live'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Borra los datos de demostracion desde la vista Salud.
 *
 * La sesion la exige el middleware, como en el resto del panel. Ademas se
 * comprueba el origen: la cookie de sesion es SameSite=lax y ya no viaja en un
 * POST desde otro sitio, pero un borrado que no se puede deshacer merece las dos
 * barreras.
 */
export async function POST(request: Request) {
  const origin = request.headers.get('origin')
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: 'origen no permitido' }, { status: 403 })
  }

  const form = await request.formData()
  if (form.get('confirm') !== 'si') {
    return NextResponse.redirect(new URL('/salud#demo', request.url), 303)
  }

  const { error } = await db().rpc('clear_demo_data')
  if (error) {
    console.error('clear_demo_data:', error.message)
    return NextResponse.redirect(new URL('/salud?demo=error', request.url), 303)
  }

  // El tablero guardado se calculo con la demo dentro: se rehace ya, para que el
  // aviso amarillo desaparezca en la siguiente visita.
  try {
    await refreshSnapshot()
  } catch (e) {
    console.error('no se pudo refrescar el tablero:', e)
  }

  return NextResponse.redirect(new URL('/salud?demo=borrado', request.url), 303)
}
