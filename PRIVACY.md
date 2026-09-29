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

Todo lo de esta sección son metadatos que ya son visibles para cualquiera con acceso
al repositorio. Se guardan organizados, no se descubre nada nuevo.

| Campo | Qué es |
|---|---|
| `repo` | Repositorio. |
| `actor_login` | Cuenta de GitHub que disparó el evento. |
| `author_email` | Email de autor de los commits (de tu `git config user.email`). Es lo que permite distinguir personas cuando la cuenta de GitHub es compartida. |
| `ref`, `base_ref` | Rama. |
| `commit_count`, `additions`, `deletions`, `changed_files`, `commits` | Tamaño del cambio en números. **No el contenido del cambio.** |
| `head_sha` | Identificador del commit. Sirve para cruzar un PR con su resultado de CI. |

**No se guardan mensajes de commit, ni títulos de PR, ni diffs.** El panel enlaza a
GitHub para el contenido, que es donde ya vive y donde ya hay permisos.

### Estado de los pull requests

Necesario para el tablero en vivo: saber qué está bloqueado ahora no se puede
deducir sumando hechos pasados.

| Campo | Qué es |
|---|---|
| `number`, `state`, `draft` | Número del PR, si está abierto/cerrado/mergeado, si es borrador. |
| `mergeable`, `mergeable_state` | Si se puede mergear, y qué lo impide (conflicto, CI en rojo, bloqueado). |
| `requested_reviewers` | **Cuántos** revisores hay pedidos, no quiénes. |
| `last_review_state` | Veredicto de la última revisión: aprobado, cambios pedidos, comentado. |
| `created_at`, `ready_at`, `first_review_at`, `approved_at`, `merged_at`, `closed_at` | Los hitos del ciclo. Son lo que permite ver **dónde** se atasca el trabajo. |

### Revisiones

| Campo | Qué es |
|---|---|
| `reviewer_login`, `pr_author_login` | Quién revisó y a quién. |
| `state` | Aprobado, cambios pedidos, comentado, descartado. |
| `submitted_at` | Cuándo. |

De los comentarios de revisión se guarda **quién** y **cuándo**, nunca el texto. Solo
se cuentan, para medir profundidad de revisión.

### CI y despliegues

| Campo | Qué es |
|---|---|
| `name`, `branch`, `status`, `conclusion` | Nombre del workflow y su resultado. |
| `attempt`, `started_at`, `completed_at`, `duration_seconds` | Intento y duración. |
| `environment`, `ref`, `is_rollback` | Entorno de despliegue y si fue una reversión. |

No se guardan registros de ejecución ni salidas de CI.

### Archivos retocados (opcional, desactivable)

Para medir retrabajo hace falta saber qué archivos se vuelven a tocar. Las rutas de
archivo están en la lista de lo que nunca se guarda, así que se guarda un **HMAC de
la ruta con una sal secreta**, nunca la ruta:

| Campo | Qué es |
|---|---|
| `path_hash` | HMAC-SHA256 de la ruta. Permite contar «este archivo se retocó» sin que la base de datos contenga ninguna ruta. |
| `change_type` | Añadido, modificado o eliminado. |

Es **opcional**: sin `FILE_HASH_SALT` configurada no se recoge nada, y el panel dice
que está desactivado en vez de mostrar un cero engañoso.

Límite honesto: quien tenga la sal **y** acceso al repositorio puede rehacer los
hashes y deducir los archivos. Protege la base de datos, no es anonimato fuerte.

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

## Quién puede leer la base de datos

Solo el servidor del panel. Las tablas tienen las políticas de acceso activadas sin
ninguna excepción, y las claves públicas de Supabase no tienen permiso sobre ninguna
tabla ni vista. Está verificado asumiendo el rol público y comprobando que no puede
leer nada.

Esto importa porque, por defecto, Supabase deja cualquier tabla accesible a quien
tenga la clave anónima, que es pública por diseño.

## Cómo comprobar que esto es verdad

```bash
npm test          # tipos y 148 tests
./db/verify.sh    # aplica el esquema y comprueba los cálculos
```

Los tests que respaldan este documento:

| Test | Qué garantiza |
|---|---|
| `tests/privacy.test.ts` | Inyecta un marcador único en todos los campos sensibles posibles —incluidos los argumentos y la salida de `codex.tool_result`— y verifica que no aparece en el resultado |
| `tests/routes.test.ts` | Que lo que **llega a la tabla** no contiene contenido, ni mensajes de commit |
| `tests/allowlist-sync.test.ts` | Que el filtro del PC y el del servidor no se han separado, y que **este documento no miente por omisión**: falla si se guarda un campo que no esté listado aquí |

Ese último test es el que hace que este documento siga siendo cierto con el tiempo.
Corren todos en cada push (`.github/workflows/ci.yml`).
