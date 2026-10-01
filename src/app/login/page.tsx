export const metadata = { title: 'Entrar' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main>
      <div className="login card">
        <h1>Medición interna</h1>
        <p>Panel del equipo. Todo el equipo ve los mismos datos.</p>
        <form method="post" action="/api/login">
          <input
            type="password"
            name="password"
            placeholder="Contraseña del panel"
            autoComplete="current-password"
            aria-label="Contraseña del panel"
            required
          />
          <button type="submit">Entrar</button>
        </form>
        {error ? (
          <p className="error" role="alert" style={{ marginTop: 12 }}>
            {error === 'bloqueado'
              ? 'Demasiados intentos fallidos. Espera 15 minutos y vuelve a probar.'
              : 'Contraseña incorrecta.'}
          </p>
        ) : null}
      </div>
    </main>
  )
}
