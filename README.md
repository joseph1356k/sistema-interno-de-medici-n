# Sistema interno de medición

Mide **adopción de herramientas de IA** (Claude Code, Codex) y **ritmo de entrega**
(push, PRs, merges, revisiones) por persona, en un equipo donde las cuentas de
Claude son compartidas.

No captura contenido: ni prompts, ni código, ni rutas, ni pulsaciones, ni
capturas, ni títulos de ventana, ni URLs. Ver [`PRIVACY.md`](PRIVACY.md) para la
lista literal de lo que sí se guarda, y
[`docs/transparencia.md`](docs/transparencia.md) para el documento que se entrega
al equipo **antes** de instalar nada.

## Cómo funciona

```
  PC Windows                                   Servidor
  ├─ Claude Code ──OTel──┐
  ├─ Codex ─────────OTel─┤                      Next.js en Vercel
  └─ OTel Collector local ├── OTLP/HTTP JSON ──►  /api/ingest/otlp    ──► Postgres
       · borra el contenido sensible                                      (Supabase)
       · bufferiza sin red                    GitHub ──webhook──────────►  /api/ingest/github
       · pone host.name                                                    /api/cron/reconcile
```

Dos ideas sostienen el diseño:

1. **La atribución va por equipo, no por cuenta.** Un PC = una persona
   (`host.name`). Es la única forma de distinguir personas cuando la cuenta de
   Claude es compartida. La tabla `people` es el único sitio donde vive un nombre.
2. **El contenido se borra en el PC, no en el servidor.** El collector local es
   obligatorio porque `codex.tool_result` envía siempre los argumentos de las
   herramientas y 2 KB de su salida, y Codex no ofrece forma de desactivarlo.

## Antes de empezar: dos cosas que ahorran trabajo

**Compartir cuentas de Claude va contra los [términos de
Anthropic](https://www.anthropic.com/legal/consumer-terms)** ("You may not share
your Account login information... with anyone else"). Un plan **Team** (una silla
por persona) es compatible **y** ya trae analíticas de uso por persona: panel de
uso, [panel específico de Claude Code](https://code.claude.com/docs/en/analytics)
con ranking y export CSV, y en Enterprise una Analytics API. Con eso, la mitad de
este sistema deja de hacer falta. Merece la pena valorarlo antes de desplegar.

**Las métricas de git ya existen hechas.** Si solo interesa esa parte,
[Middleware](https://github.com/middlewarehq/middleware) (Apache-2.0) da DORA y
tiempo de ciclo de PR en una imagen Docker.

## Fase 0: piloto en 1 PC (hacer esto primero)

Hay cosas que la documentación de los proveedores no aclara y que conviene
confirmar **antes** de construir el resto:

- ¿Funciona la telemetría de Claude Code con la suscripción que usáis? (las docs
  lo confirman para OAuth, pero no hay una frase explícita para Pro/Max)
- ¿Llega `claude_code.active_time.total`?
- ¿Qué trae exactamente `codex.tool_result` en la versión instalada?
- ¿Afecta `OTEL_RESOURCE_ATTRIBUTES` a Codex? (probablemente sí, sin verificar)

Cómo:

1. Descarga `otelcol-contrib` para `windows_amd64` de las
   [releases oficiales](https://github.com/open-telemetry/opentelemetry-collector-releases/releases).
2. Ejecútalo con [`agent/otelcol/config.debug.yaml`](agent/otelcol/config.debug.yaml),
   que imprime por consola en vez de enviar.
3. Configura Claude Code y Codex apuntando a `http://127.0.0.1:4318`.
4. Trabaja media hora normal y mira la salida.

**No sigas hasta que esto funcione.** Si algo no aparece, el resto del sistema no
lo va a arreglar.

## Despliegue

### 1. Base de datos

Crea un proyecto en Supabase y aplica las migraciones en orden:

```bash
psql "$DATABASE_URL" -f db/migrations/0001_init.sql
psql "$DATABASE_URL" -f db/migrations/0002_views.sql
```

Registra a las personas y sus identidades:

```sql
insert into people (display_name, git_emails, github_login) values
  ('Ana García',  array['ana@empresa.com'],  'anagarcia'),
  ('Luis Pérez',  array['luis@empresa.com'], null);

-- Un PC = una persona.
insert into devices (hostname, person_id, os)
select 'pc-07', id, 'Windows 11' from people where display_name = 'Ana García';
```

### 2. Servidor

Despliega en Vercel con estas variables (ver [`.env.example`](.env.example)):

| Variable | Para qué |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Base de datos |
| `INGEST_TOKEN` | Token que presenta el collector de cada PC |
| `GITHUB_WEBHOOK_SECRET` | Secreto del webhook |
| `GITHUB_API_TOKEN`, `GITHUB_ORG` | Job de reconciliación |
| `DASHBOARD_PASSWORD` | Acceso al panel |
| `CRON_SECRET` | Protege el cron (opcional pero recomendado) |

Sin `DASHBOARD_PASSWORD` el panel no sirve nada: es a propósito, para que un
despliegue a medias no deje datos por persona accesibles.

### 3. GitHub

Webhook a nivel de **organización** (hace falta ser owner):

- URL: `https://TU-DOMINIO/api/ingest/github`
- Content type: `application/json`
- Secret: el mismo valor de `GITHUB_WEBHOOK_SECRET`
- Eventos: **Pushes**, **Pull requests**, **Pull request reviews**

Y que **cada programador configure un email de git distinto**, incluso si la
cuenta de GitHub es compartida — es lo que permite atribuir push y commits:

```bash
git config --global user.email ana@empresa.com
```

El cron de reconciliación (`vercel.json`) rellena a diario lo que no llegó por
webhook. Hace falta porque GitHub no reintenta las entregas fallidas y el reenvío
manual solo está disponible 3 días.

### 4. Los PCs

**Primero entrega [`docs/transparencia.md`](docs/transparencia.md) al equipo.**
El sistema está diseñado para ser declarado; instalarlo en silencio lo convierte
en otra cosa, y según el país puede ser además un requisito legal informar antes.

Luego, en cada PC, como Administrador:

```powershell
# El binario del collector se coloca a mano a proposito: conviene revisar lo que
# se instala en todos los PCs en vez de bajarlo a ciegas.
# Copialo en C:\ProgramData\MedicionAgent\otelcol-contrib.exe

.\agent\windows\install.ps1 `
  -IngestEndpoint https://TU-DOMINIO/api/ingest/otlp `
  -IngestToken   '<INGEST_TOKEN>' `
  -DeviceName    pc-07
```

Para revertirlo todo: `.\agent\windows\uninstall.ps1`.

## Límites conocidos

Conviene tenerlos claros de antemano:

- **Codex en Windows no se puede forzar.** El usuario puede sobrescribir la
  configuración del admin, no hay opción de registro, y el `managed_config.toml`
  por usuario se eliminó ([PR #38947](https://github.com/openai/codex/pull/38947)).
  Fijar OTel desde la consola de admin tampoco está soportado
  ([issue #16248](https://github.com/openai/codex/issues/16248)). La vista
  `v_device_health` y la sección "Salud del sistema" del panel existen para
  vigilarlo.
- **Claude Code sí se puede forzar** vía `managed-settings.json`, pero alguien con
  admin local puede editarlo.
- **El tiempo de Codex es estimado**, no medido: Codex no expone una métrica de
  tiempo activo, así que se deriva sumando huecos entre eventos con un tope de
  5 min. El panel lo etiqueta como estimación; no debe compararse de tú a tú con
  `active_time.total` de Claude Code.
- **La app de escritorio de Codex no exporta logs**
  ([issue #28810](https://github.com/openai/codex/issues/28810)), así que ese uso
  puede quedar subcontado. Igual `codex exec` no exporta tokens
  ([issue #33668](https://github.com/openai/codex/issues/33668)).
- **No se mide el chat de Claude en navegador ni en la app de escritorio**, ni el
  tiempo en github.com. Medirlo requeriría un monitor de ventanas, que se decidió
  no incluir (el razonamiento está en el plan y en `docs/transparencia.md`).
- **Las cifras de coste son aproximaciones** según la documentación de Anthropic.
- El endpoint `/activity` de GitHub no documenta su retención, así que no conviene
  depender de él para históricos largos.

## Desarrollo

```bash
npm install
npm run check     # typecheck + tests
npm test          # 87 tests
npm run dev
```

Los tests que importan:

| Archivo | Qué garantiza |
|---|---|
| `tests/privacy.test.ts` | Inyecta un marcador en todos los campos sensibles posibles y verifica que no sobrevive |
| `tests/routes.test.ts` | Que lo que **llega a la tabla** no contiene contenido |
| `tests/allowlist-sync.test.ts` | Que el filtro del PC y el del servidor no se han separado, y que `PRIVACY.md` no miente por omisión |
| `tests/github.test.ts` | Firma HMAC con el vector oficial de GitHub, y atribución con cuentas compartidas |

Si cambias [`src/lib/allowlist.ts`](src/lib/allowlist.ts), hay que actualizar en el
mismo commit `agent/otelcol/config.yaml` y `PRIVACY.md`. Los tests fallan si no.

## Cómo leer los números

Push por día, tiempo entre push y horas en una herramienta son métricas de
**flujo**, no de rendimiento. Son fáciles de inflar (partir commits, dejar
sesiones abiertas) y castigan justo el trabajo difícil: refactors grandes,
depuración, pensar antes de escribir.

- **A nivel de equipo y de tendencia.** "Los PR tardan 4 días en mergearse" es
  accionable; "Ana hizo 12 push y Luis 7" no dice nada. Por eso la tabla por
  persona del panel está ordenada alfabéticamente y no por ninguna métrica.
- **Para ROI de herramientas**, que sí es una pregunta legítima por persona: ¿vale
  lo que cuesta? ¿a alguien le vendría bien formación?
- **Para detectar bloqueos.** Un PR abierto 10 días es un problema de proceso.
- **Siempre junto a una señal de calidad**: la tasa de aceptación de ediciones
  (`code_edit_tool.decision`) está en el panel por este motivo.
