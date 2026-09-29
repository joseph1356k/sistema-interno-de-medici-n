'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

/**
 * Refresca los datos del servidor cada `seconds` sin recargar la página, así que
 * no se pierde el scroll ni el estado de los desplegables.
 *
 * Se pausa cuando la pestaña no está visible: un panel abierto y olvidado en una
 * pestaña de fondo no debe seguir invocando la función toda la noche.
 */
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter()
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    const onVisibility = () => {
      const hidden = document.visibilityState === 'hidden'
      setPaused(hidden)
      // Al volver a la pestaña, refrescar de inmediato en vez de esperar el turno.
      if (!hidden) router.refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [router])

  useEffect(() => {
    if (paused) return
    const id = setInterval(() => router.refresh(), seconds * 1000)
    return () => clearInterval(id)
  }, [paused, router, seconds])

  return null
}
