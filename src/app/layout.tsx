import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Medición interna',
  description: 'Adopción de herramientas de IA y ritmo de entrega del equipo',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  )
}
