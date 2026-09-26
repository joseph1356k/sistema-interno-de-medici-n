# Qué guarda este sistema, campo por campo

Este documento es la lista literal de lo que se almacena. Está pensado para que
cualquiera del equipo pueda auditarlo sin leer código.

La lista no es una promesa: es lo que hace el código. La fuente de verdad es
[`src/lib/allowlist.ts`](src/lib/allowlist.ts), y
[`tests/privacy.test.ts`](tests/privacy.test.ts) verifica en cada ejecución que
nada fuera de esta lista sobrevive. Si esta lista y el código se separan, los
tests fallan.

## Cómo funciona el filtro

Por **allowlist**, no por lista negra: un campo que no esté nombrado aquí no se
guarda, aunque la herramienta lo envíe. Cuando Anthropic u OpenAI añadan campos
nuevos en una versión futura, el comportamiento por defecto es descartarlos.

Hay **dos barreras**:

1. **En tu PC** — el OTel Collector local borra el contenido sensible antes de
   que salga de la máquina ([`agent/otelcol/config.yaml`](agent/otelcol/config.yaml)).
2. **En el servidor** — la ingesta vuelve a filtrar por allowlist.

La primera es la que importa: el contenido no sale de tu equipo.

## Lo que NO se guarda nunca

- **El texto de tus prompts** y de las respuestas del modelo.
- **Tu código**, diffs o parches.
- **Rutas de archivo**, nombres de rama, comandos que ejecutas.
- **Pulsaciones de teclas, capturas de pantalla, cámara, micrófono.** El sistema
  no tiene ninguna pieza capaz de hacer esto.
- **Títulos de ventana, URLs o historial de navegación.** No hay monitor de
  ventanas ni extensión de navegador instalada.
- **Qué aplicaciones usas fuera de Claude Code, Codex y git.**
- **La identidad de la cuenta compartida de Claude** (`user.email`,
  `user.account_uuid`, `organization.id`): se descarta porque es la misma para
  todos y no aporta nada.

Dos notas sobre cómo se consigue:

- Claude Code redacta el prompt por defecto. Las variables que lo desactivarían
  (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`) **no se ponen**, y eso se
  puede comprobar en
  [`agent/windows/managed-settings.json`](agent/windows/managed-settings.json).
- Codex **sí envía siempre** los argumentos de las herramientas (comandos,
  parches, rutas) y 2 KB de su salida en `codex.tool_result`, y no ofrece forma
  de desactivarlo. El collector local los borra antes de que salgan del PC. Este
  es el motivo por el que el collector es obligatorio y no opcional.

## Lo que sí se guarda

### Identificación

| Campo | Qué es |
|---|---|
| `host.name` | Nombre de tu equipo. Es la clave de atribución, porque las cuentas de Claude son compartidas. |
| `service.name` | Qué cliente lo generó: `claude-code`, `claude-code-desktop`, `codex`… |
| `service.version`, `app.version` | Versión de la herramienta. |
| `os.type`, `os.version`, `host.arch` | Sistema operativo del equipo. |
| `env` | Entorno declarado en la config de Codex. |
| `session.id` / `conversation.id` | Identificador opaco de sesión. Permite medir cuántas sesiones hubo y cuánto duraron. No contiene nada del contenido. |
| `terminal.type`, `app.entrypoint` | Si fue terminal, VS Code, JetBrains o la app. |

### Métricas de uso

| Campo | Qué es |
|---|---|
| `type` | Para tiempo activo: `user` (escribir y leer) o `cli` (ejecución y respuestas). Para líneas: `added` o `removed`. |
| `model` | Modelo usado. |
| `decision` | Si aceptaste o rechazaste una edición sugerida. |
| `tool_name` | Qué herramienta se usó (por nombre: `Edit`, `Bash`…), **nunca con qué argumentos**. |
| `language` | Lenguaje del archivo editado. |
| `start_type`, `source`, `query_source`, `effort`, `slug`, `originator`, `auth_mode` | Metadatos de la sesión y la petición. |
| `success`, `error_type`, `status_code` | Si la operación salió bien. |
| `duration_ms` | Cuánto tardó. |
| `prompt_length` | **La longitud** del prompt en caracteres, no el prompt. |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` | Recuento de tokens. |
| `cost_usd` | Coste aproximado. |
| `mcp_server_name` | Nombre de servidor MCP conectado. |

Cualquier valor de texto de más de 120 caracteres se descarta incluso si su
campo está permitido: todo lo de esta lista es corto, y un valor largo señala que
la herramienta cambió de formato.

### Actividad de git (viene de GitHub, no de tu PC)

| Campo | Qué es |
|---|---|
| `repo` | Repositorio. |
| `actor_login` | Cuenta de GitHub que disparó el evento. |
| `author_email` | Email de autor de los commits (de tu `git config user.email`). Es lo que permite distinguir personas cuando la cuenta de GitHub es compartida. |
| `ref` | Rama. |
| `commit_count`, `additions`, `deletions`, `changed_files` | Tamaño del cambio en números. **No el contenido del cambio.** |
| `pr_number`, `pr_created_at`, `pr_merged_at`, `review_state` | Fechas y estado de PRs y revisiones. |

No se guardan mensajes de commit ni diffs.

## Cuánto tiempo se guarda

- **90 días** de detalle.
- Después, solo agregados mensuales.
- Los datos aún no enviados viven en tu PC, en
  `%ProgramData%\MedicionAgent\queue`, y se borran al desinstalar.

## Quién lo ve

- Cada persona puede ver **sus propios datos** en el panel.
- La vista agregada de equipo la ve quien administre el sistema.
- La única tabla que asocia estos datos con un nombre es `people`.

## Cómo desactivarlo

`agent/windows/uninstall.ps1` lo revierte todo en un comando. Los datos ya
enviados siguen en el servidor; para que se borren, pídelo a quien administre el
panel.

## Cómo comprobar que esto es verdad

```bash
npm test          # incluye el test de privacidad
```

El test `tests/privacy.test.ts` inyecta un marcador único en todos los campos
sensibles posibles —incluidos los argumentos y la salida de `codex.tool_result`—
y verifica que ese marcador no aparece en ninguna parte del resultado.
`tests/allowlist-sync.test.ts` verifica que el filtro del PC y el del servidor no
se han separado.
