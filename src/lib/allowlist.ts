/**
 * Barrera de privacidad del sistema.
 *
 * Funciona por ALLOWLIST, no por denylist: un atributo que no este nombrado
 * aqui no se guarda, aunque la herramienta lo mande. Asi, cuando Anthropic u
 * OpenAI anadan campos nuevos en una version futura, el comportamiento por
 * defecto es descartarlos, no filtrarlos.
 *
 * Esto importa especialmente por Codex: `codex.tool_result` incluye SIEMPRE los
 * argumentos de la herramienta (comandos, parches, rutas) y los primeros 2 KB
 * de la salida, y no existe opcion para desactivarlo. Se descartan aqui.
 *
 * Si cambias este archivo, actualiza PRIVACY.md en el mismo commit.
 */

/** Atributos de recurso: identifican el equipo y la version, nunca a la persona. */
export const RESOURCE_ATTRS = new Set([
  'host.name', // clave de atribucion: un PC = una persona
  'service.name', // claude-code | claude-code-desktop | codex...
  'service.version',
  'os.type',
  'os.version',
  'host.arch',
  'env', // Codex: [otel] environment
])

/** Atributos conservados en metricas. */
export const METRIC_ATTRS = new Set([
  'type', // active_time: user|cli / lines_of_code: added|removed
  'model',
  'decision', // accept | reject
  'source',
  'language',
  'tool_name',
  'start_type',
  'query_source',
  'effort',
  'terminal.type',
  'app.version',
  'app.entrypoint',
  'success',
])

/** Atributos conservados en eventos. */
export const EVENT_ATTRS = new Set([
  ...METRIC_ATTRS,
  'auth_mode',
  'originator',
  'slug',
  'duration_ms',
  'prompt_length', // longitud, NO el prompt
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost_usd',
  'error_type',
  'status_code',
  'mcp_server_name',
])

/**
 * Claves que NUNCA se guardan. No es el mecanismo de proteccion (ese es la
 * allowlist de arriba) sino documentacion ejecutable: la suite de tests
 * construye un payload con todas ellas y verifica que ninguna sobrevive.
 */
export const NEVER_STORED = [
  // Contenido de conversacion
  'prompt',
  'user_prompt',
  'assistant_response',
  'last_assistant_message',
  'message',
  'content',
  'text',
  'body',
  // Contenido de herramientas (Codex manda esto siempre)
  'arguments',
  'output',
  'command',
  'patch',
  'diff',
  'stdout',
  'stderr',
  'tool_input',
  // Rutas y estructura del proyecto
  'file_path',
  'cwd',
  'transcript_path',
  'repository',
  'git_branch',
  // Identidad de la cuenta compartida: no aporta informacion (es la misma para
  // todos) y es dato personal.
  'user.email',
  'user.id',
  'user.account_uuid',
  'user.account_id',
  'organization.id',
  // Navegacion, si alguna vez se anadiera una fuente de escritorio
  'title',
  'url',
] as const

/**
 * Valor maximo admitido para un atributo de texto. Todo lo que la allowlist
 * permite es corto (nombres de modelo, decisiones, lenguajes). Un valor largo
 * en una clave permitida es senal de que la herramienta cambio de formato: se
 * descarta en lugar de truncarse, porque truncar seguiria filtrando.
 */
export const MAX_ATTR_LENGTH = 120

export type AttrValue = string | number | boolean

/**
 * Deja pasar unicamente las claves de `allowed`, y solo con valores escalares
 * cortos. Devuelve un objeto plano listo para guardar como jsonb.
 */
export function filterAttrs(
  attrs: Record<string, unknown> | undefined,
  allowed: Set<string>,
): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {}
  if (!attrs) return out

  for (const [key, raw] of Object.entries(attrs)) {
    if (!allowed.has(key)) continue

    if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = raw
    } else if (typeof raw === 'boolean') {
      out[key] = raw
    } else if (typeof raw === 'string' && raw.length <= MAX_ATTR_LENGTH) {
      out[key] = raw
    }
    // Objetos, arrays, null y strings largos se descartan sin excepcion.
  }

  return out
}

/** El identificador de sesion no es contenido, pero si es de forma conocida. */
export function safeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(value)) return null
  return value
}

/** Hostname normalizado, o null si no tiene forma de hostname. */
export function safeHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(v)) return null
  return v
}
