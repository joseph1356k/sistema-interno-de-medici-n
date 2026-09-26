/**
 * Puerta de acceso al panel.
 *
 * Es una contrasena compartida, y el panel es SIMETRICO: todo el equipo ve los
 * mismos numeros, los de todos. Es una decision de diseno, no un atajo. Si estos
 * datos solo los ve quien manda, es vigilancia; si los ve todo el equipo por
 * igual, es informacion compartida, y cualquiera puede detectar un numero mal
 * calculado.
 *
 * Funciona con Web Crypto para que sirva igual en el middleware (Edge) y en las
 * rutas de servidor (Node).
 */

export const SESSION_COOKIE = 'medicion_sesion'

/** Derivacion determinista: la cookie guarda esto, nunca la contrasena. */
export async function sessionToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`medicion:v1:${password}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Comparacion en tiempo constante sobre strings hexadecimales. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function isValidSession(cookieValue: string | undefined): Promise<boolean> {
  const password = process.env.DASHBOARD_PASSWORD
  // Sin contrasena configurada no se sirve nada. Es a proposito: un panel con
  // datos por persona no debe poder quedarse abierto por un despliegue a medias.
  if (!password || !cookieValue) return false
  return safeEqual(cookieValue, await sessionToken(password))
}
