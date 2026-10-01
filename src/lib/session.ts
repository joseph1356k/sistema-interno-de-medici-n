/**
 * Puerta de acceso al panel.
 *
 * Es una contrasena compartida, y el panel es SIMETRICO: todo el equipo ve los
 * mismos numeros, los de todos. Es una decision de diseno, no un atajo. Si estos
 * datos solo los ve quien manda, es vigilancia; si los ve todo el equipo por
 * igual, es informacion compartida, y cualquiera puede detectar un numero mal
 * calculado.
 *
 * La cookie es `v2.<caducidad>.<firma>`: una firma HMAC con caducidad. La version
 * anterior guardaba un SHA-256 de la contrasena, que no caducaba nunca y que, si
 * se filtraba, permitia probar contrasenas sin limite fuera de linea. Ahora la
 * firma depende tambien de `SESSION_SECRET`, que no sale nunca del servidor, y
 * cambiar la contrasena o ese secreto cierra todas las sesiones.
 *
 * Funciona con Web Crypto para que sirva igual en el middleware (Edge) y en las
 * rutas de servidor (Node).
 */

export const SESSION_COOKIE = 'medicion_sesion'

/** 30 dias. Cuanto dura una sesion antes de tener que volver a entrar. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30

const encoder = new TextEncoder()

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacKey(material: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', encoder.encode(material))
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
}

async function hmacHex(key: CryptoKey, data: string): Promise<string> {
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))
}

/** Clave de firma de las sesiones. Sin contrasena configurada no hay sesiones. */
async function signingKey(): Promise<CryptoKey | null> {
  const password = process.env.DASHBOARD_PASSWORD
  if (!password) return null
  return hmacKey(`medicion:sesion:v2:${process.env.SESSION_SECRET ?? ''}:${password}`)
}

/** Comparacion en tiempo constante sobre strings hexadecimales. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Crea el valor de la cookie de sesion. Null si el panel no tiene contrasena. */
export async function createSessionToken(nowMs = Date.now()): Promise<string | null> {
  const key = await signingKey()
  if (!key) return null
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS
  return `v2.${exp}.${await hmacHex(key, `v2.${exp}`)}`
}

export async function isValidSession(
  cookieValue: string | undefined,
  nowMs = Date.now(),
): Promise<boolean> {
  // Sin contrasena configurada no se sirve nada. Es a proposito: un panel con
  // datos por persona no debe poder quedarse abierto por un despliegue a medias.
  if (!cookieValue) return false
  const key = await signingKey()
  if (!key) return false

  const [version, expRaw, signature, ...rest] = cookieValue.split('.')
  if (version !== 'v2' || !expRaw || !signature || rest.length > 0) return false

  const exp = Number(expRaw)
  if (!Number.isSafeInteger(exp) || exp * 1000 <= nowMs) return false

  return safeEqual(signature, await hmacHex(key, `v2.${exp}`))
}

/**
 * Comprueba la contrasena en tiempo constante. Se comparan sus HMAC, no las
 * cadenas, para que ni siquiera la longitud se filtre por el tiempo de respuesta.
 */
export async function passwordMatches(given: string): Promise<boolean> {
  const expected = process.env.DASHBOARD_PASSWORD
  if (!expected) return false
  const key = await hmacKey(`medicion:contrasena:${process.env.SESSION_SECRET ?? ''}`)
  const [a, b] = await Promise.all([hmacHex(key, given), hmacHex(key, expected)])
  return safeEqual(a, b)
}

/**
 * Huella de una IP para limitar intentos de acceso. Se guarda esto y nunca la IP:
 * sirve para contar intentos de un mismo origen, no para saber quien es. Ademas
 * se borra a las 24 horas.
 */
export async function ipFingerprint(ip: string): Promise<string> {
  const key = await hmacKey(
    `medicion:ip:${process.env.SESSION_SECRET ?? process.env.DASHBOARD_PASSWORD ?? ''}`,
  )
  return (await hmacHex(key, ip)).slice(0, 32)
}
