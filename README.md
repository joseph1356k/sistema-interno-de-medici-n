# Sistema interno de medición

Mide **adopción de herramientas de IA** (Claude Code, Codex) y **ritmo de entrega**
(DORA, tiempo de ciclo, revisión, CI) en un equipo donde las cuentas de Claude son
compartidas.

No captura contenido: ni prompts, ni código, ni rutas, ni pulsaciones, ni capturas,
ni títulos de ventana, ni URLs. La lista literal de lo que sí se guarda está en
[`PRIVACY.md`](PRIVACY.md), y un test falla si ese documento se queda corto.

**Panel:** `https://medicion-interna-jose-david-s-projects-22dd4300.vercel.app`
**Para terminar de arrancarlo:** [`docs/puesta-en-marcha.md`](docs/puesta-en-marcha.md)

---

## Cómo funciona

```
  PC Windows                                        Servidor (Vercel)
  ├─ Claude Code ──OTel──┐
  ├─ Codex ─────────OTel─┤
  └─ OTel Collector local ├── OTLP/HTTP JSON ──►  /api/ingest/otlp    ──► Postgres
       · borra el contenido sensible                                       (Supabase)
       · bufferiza sin red                    GitHub ──webhook────────►  /api/ingest/github
       · pone host.name                                                  /api/cron/daily
```

Tres ideas sostienen el diseño:

1. **La atribución va por equipo, no por cuenta.** Un PC = una persona (`host.name`).
   Es la única forma de distinguir personas cuando la cuenta de Claude es compartida.
   La tabla `people` es el único sitio donde vive un nombre.
2. **El contenido se borra en el PC, no en el servidor.** El collector local es
   obligatorio porque `codex.tool_result` envía siempre los argumentos de las
   herramientas y 2 KB de su salida, y Codex no ofrece forma de desactivarlo.
3. **Los webhooks son la única fuente realmente en tiempo real.** La telemetría de
   herramientas se exporta cada 60 s, así que el panel no finge ser más fresco que
   eso y muestra la antigüedad del dato.

---

## Las seis vistas

| Vista | Qué responde |
|---|---|
| **Ahora** | ¿Qué le pasa al trabajo? PRs por motivo de bloqueo y cuánto llevan así, CI, actividad de hoy, alertas |
| **Entrega** | DORA, tiempo de ciclo desglosado, WIP, tamaño de PR contra velocidad de revisión |
| **Revisión y CI** | Carga de revisión, quién revisa a quién, salud de CI, tests inestables |
| **IA y coste** | Uso, aceptación de ediciones, **coste por PR mergeado**, adopción |
| **Proyecciones** | Throughput por Monte Carlo, coste a fin de mes, tendencias |
| **Salud** | ¿Me puedo creer estos datos? Equipos reportando, actividad sin atribuir |

### Lo que el panel hace a propósito

- **No hay indicador de «activo ahora» por persona.** La telemetría solo ve Claude
  Code y Codex, así que marcaría como inactivo a quien lee, piensa o está en una
  reunión. Sería mentir con datos.
- **La tabla por persona está en orden alfabético**, nunca por métrica. Ordenarla por
  horas la convertiría en un ranking.
- **Es simétrico:** una contraseña, todo el equipo ve los mismos datos. Si solo los ve
  quien manda, es vigilancia; si los ve todo el equipo, es información compartida.
- **Las proyecciones se niegan a proyectar** con menos de 6 semanas de datos, y la
  tendencia dice «sin tendencia clara» cuando el ajuste es malo en vez de afirmar una
  mejora que no está en los datos.

---

## Antes de empezar: dos cosas que ahorran trabajo

**Compartir cuentas de Claude va contra los [términos de
Anthropic](https://www.anthropic.com/legal/consumer-terms)** («You may not share your
Account login information... with anyone else»). Un plan **Team** (una silla por
persona) es compatible **y** ya trae analíticas de uso por persona: panel de uso,
[panel específico de Claude Code](https://code.claude.com/docs/en/analytics) con
ranking y export CSV, y en Enterprise una Analytics API. Con eso, buena parte de este
sistema deja de hacer falta.

**Las métricas de git ya existen hechas.** Si solo interesa esa parte,
[Middleware](https://github.com/middlewarehq/middleware) da DORA y tiempo de ciclo en
una imagen Docker.

---

## Estructura

```
src/lib/
  allowlist.ts      ← barrera de privacidad. Lo que no está aquí no se guarda
  otlp.ts           parser de OTLP/HTTP JSON
  github.ts         firma HMAC y eventos históricos
  github-events.ts  estado de PR, CI, revisiones, despliegues
  pr-state.ts       fusión tolerante a webhooks desordenados
  live.ts           cálculo del tablero en vivo
  forecast.ts       Monte Carlo y tendencias
  analytics.ts      cargadores de las vistas
  jobs.ts           trabajos programados
db/
  migrations/       8 migraciones
  verify.sh         aplica el esquema y comprueba los cálculos con aserciones
  seed/demo.sql     16 semanas de datos de demostración
installer/
  medicion-agent.iss  produce UN .exe con el collector dentro
agent/otelcol/      configuración del collector, con el filtro de privacidad
```

---

## Desarrollo

```bash
npm install
npm run check        # tipos + tests
./db/verify.sh       # esquema y cálculos, contra un Postgres local
npm run dev
```

Los tests que importan:

| Archivo | Qué garantiza |
|---|---|
| `tests/privacy.test.ts` | Inyecta un marcador en todos los campos sensibles y verifica que no sobrevive |
| `tests/routes.test.ts` | Que lo que **llega a la tabla** no contiene contenido |
| `tests/pr-state.test.ts` | Que una secuencia **desordenada** de webhooks deja el estado correcto |
| `tests/forecast.test.ts` | Que las proyecciones se **niegan** con pocos datos, y que los percentiles no se invierten |
| `tests/allowlist-sync.test.ts` | Que el filtro del PC y el del servidor no se han separado, y que `PRIVACY.md` no miente por omisión |
| `tests/security.test.ts` | Que la sesión caduca y no se puede falsificar ni alargar, y que el cron sin secreto lo rechaza todo |
| `tests/live.test.ts` | Que una ráfaga de eventos cuesta un solo recálculo del tablero sin perder el último |
| `db/verify.sql` | Valores de cada métrica comprobados a mano una vez, fijados como aserciones; y que la clave pública no lee ni ejecuta nada |

**Si cambias [`src/lib/allowlist.ts`](src/lib/allowlist.ts)**, hay que actualizar en el
mismo commit `agent/otelcol/config.yaml` y `PRIVACY.md`. Los tests fallan si no.

---

## Límites conocidos

Conviene tenerlos claros de antemano:

- **Codex en Windows no se puede forzar.** El usuario puede sobrescribir la
  configuración del admin, no hay opción de registro, y el `managed_config.toml` por
  usuario se eliminó ([PR #38947](https://github.com/openai/codex/pull/38947)). Fijar
  OTel desde la consola de admin tampoco está soportado ([issue
  #16248](https://github.com/openai/codex/issues/16248)). La vista **Salud** existe
  para vigilarlo.
- **El tiempo de Codex es estimado**, no medido: Codex no expone métrica de tiempo
  activo, así que se deriva sumando huecos entre eventos con un tope de 5 minutos. El
  panel lo etiqueta como estimación.
- **La app de escritorio de Codex no exporta registros** ([issue
  #28810](https://github.com/openai/codex/issues/28810)), así que ese uso puede quedar
  subcontado. Igual `codex exec` no exporta tokens ([issue
  #33668](https://github.com/openai/codex/issues/33668)).
- **No se mide el chat de Claude en navegador ni en la app de escritorio**, ni el
  tiempo en github.com. Requeriría un monitor de ventanas, que se decidió no instalar:
  su servidor no tiene autenticación, el instalador de Windows es por usuario y se
  desactiva en dos clics, y la extensión no existe para Edge.
- **`mergeable_state` llega nulo casi siempre** por webhook, porque GitHub lo calcula
  aparte. Hace falta `GITHUB_API_TOKEN` para refrescarlo; sin él el tablero no
  distingue un conflicto de un CI en rojo.
- **Los intentos de CI se cuentan sobre el commit final** de cada PR, no sobre los
  anteriores, así que la cifra es un mínimo.
- **Las cifras de coste son aproximaciones** que reporta la propia herramienta.
- **El plan Hobby de Vercel solo admite crons diarios.** El tablero se refresca en cada
  webhook, así que el cron solo es la red de seguridad.

---

## Cómo leer los números

Push por día, tiempo entre push y horas en una herramienta son métricas de **flujo**,
no de rendimiento. Son fáciles de inflar y castigan justo el trabajo difícil:
refactors grandes, depuración, pensar antes de escribir.

- **A nivel de equipo y de tendencia.** «Los PR tardan 4 días en mergearse» es
  accionable; «Ana hizo 12 push y Luis 7» no dice nada.
- **Para ROI de herramientas**, que sí es una pregunta legítima por persona: el **coste
  por PR mergeado** es la cifra que la responde.
- **Para detectar bloqueos.** Un PR abierto 10 días es un problema de proceso.
- **Siempre junto a una señal de calidad**: tasa de aceptación de ediciones,
  retrabajo, PRs abandonados.

Y **entrega [`docs/transparencia.md`](docs/transparencia.md) al equipo antes de
instalar nada.** El sistema está diseñado para ser declarado; instalarlo en silencio lo
convierte en otra cosa, y según el país informar puede ser además un requisito legal.
