# Puesta en marcha

Estado actual y qué falta. Los dos primeros pasos son los únicos que no se pueden
automatizar, porque implican secretos que solo una persona puede leer.

## Lo que ya está hecho

| Pieza | Estado |
|---|---|
| Base de datos | Proyecto Supabase `medicion-interna` (eu-west-1), 8 migraciones |
| Acceso público | **Cerrado**: RLS en todas las tablas; las claves públicas no pueden leer ninguna tabla ni vista ni ejecutar ninguna función. Verificado asumiendo el rol `anon`, y `db/verify.sh` lo comprueba en cada cambio |
| Zona horaria | Los días se cortan en `America/Bogota` (ver «Zona horaria», abajo) |
| Datos de demostración | 16 semanas sembradas: 155 PRs, 283 ejecuciones de CI, 367 días agregados |
| Panel | Desplegado en Vercel, responde HTTP 200 |
| Protección de Vercel | Desactivada a propósito (bloquearía los webhooks y la telemetría); el panel tiene su propia contraseña |
| Cron | Uno diario, `/api/cron/daily` |

**URL del panel:** `https://medicion-interna-jose-david-s-projects-22dd4300.vercel.app`

## Paso 1 — Pegar la clave de servicio de Supabase (2 minutos)

Sin esto el panel muestra una pantalla que explica justo este paso, en vez de datos.

1. Supabase → proyecto `medicion-interna` → **Project Settings** → **API Keys**.
2. Copia la clave **`service_role`** (la secreta, no la `anon`).
3. Vercel → proyecto `medicion-interna` → **Settings** → **Environment Variables**.
4. Añade `SUPABASE_SERVICE_ROLE_KEY` con ese valor, marcando los tres entornos.
5. **Deployments** → el último → **⋯** → **Redeploy**.

Esa clave salta todas las políticas de acceso, así que solo debe vivir en las
variables de entorno del servidor. Nunca en el navegador ni en el repositorio.

## Paso 2 — Webhook de GitHub (5 minutos)

Es la fuente en tiempo casi real: llega en segundos, mientras que la telemetría de
herramientas tarda hasta un minuto.

En GitHub → el repositorio (o la organización) → **Settings** → **Webhooks** → **Add
webhook**:

- **Payload URL:** `https://medicion-interna-jose-david-s-projects-22dd4300.vercel.app/api/ingest/github`
- **Content type:** `application/json`
- **Secret:** el valor de `GITHUB_WEBHOOK_SECRET` (está en las variables de Vercel)
- **Which events:** *Let me select individual events* y marcar:
  - Pushes
  - Pull requests
  - Pull request reviews
  - Pull request review comments
  - Check suites
  - Workflow runs
  - Statuses
  - Releases
  - Deployment statuses

Para comprobar que funciona: en la pestaña **Recent Deliveries** del webhook, pulsa
**Redeliver** en el ping. Debe responder 200.

## Paso 3 — Un email de git distinto por persona (1 minuto cada uno)

Es lo que permite distinguir a quién atribuir los push **aunque la cuenta de GitHub
sea compartida**. Sin esto, la actividad aparece en la vista **Salud** como «sin
atribuir».

```bash
git config --global user.email ana@empresa.com
```

Y registrar a cada persona en la base de datos:

```sql
insert into people (display_name, git_emails, github_login) values
  ('Ana García', array['ana@empresa.com'], 'anagarcia');
```

## Paso 4 — Borrar los datos de demostración

Cuando ya entren datos reales: vista **Salud** → **Datos de demostración** → marcar la
casilla → **Borrar datos de demostración**. Solo borra las filas marcadas como demo;
los datos reales no se tocan.

El panel muestra un aviso amarillo mientras existan, así que no hay riesgo de
confundirlos con datos de verdad. Sin el panel, lo mismo desde SQL:
`select clear_demo_data();`

## Paso 5 — Los PCs

**Antes de instalar nada, entrega [`transparencia.md`](transparencia.md) al equipo.**
El sistema está diseñado para ser declarado; instalarlo en silencio lo convierte en
otra cosa, y según el país informar puede ser además un requisito legal.

### Construir el instalador

En GitHub → **Actions** → **Construir instalador** → **Run workflow**. Descarga el
artefacto `instalador-agente`.

Sin firmar, Windows mostrará un aviso de SmartScreen. Firmarlo requiere comprar un
certificado; ver «Firma de código» más abajo.

### Generar la clave de instalación

```powershell
.\installer\scripts\nueva-clave.ps1 `
  -Endpoint https://medicion-interna-jose-david-s-projects-22dd4300.vercel.app/api/ingest/otlp `
  -Token '<INGEST_TOKEN>'
```

### Instalar

Doble clic, pegar la clave, siguiente. O en silencio, para Intune o un script de
inicio de GPO:

```
MedicionAgent-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLAVE=<clave>
```

Después, registrar el equipo:

```sql
insert into devices (hostname, person_id, os)
select 'pc-de-ana', id, 'Windows 11' from people where display_name = 'Ana García';
```

El hostname es el que se puso en el instalador, en minúsculas.

### Comprobar que reporta

Vista **Salud** del panel. Debe aparecer el equipo con «Reportando» en Claude Code.
Tarda hasta un minuto, que es el intervalo de exportación de métricas.

## Antes de desplegar a todos: el piloto

Hay cosas que la documentación de los proveedores no aclara. Merece la pena
confirmarlas en **un** PC antes de repartir el instalador:

- ¿Funciona la telemetría de Claude Code con la suscripción que usáis? (las docs lo
  confirman para OAuth, pero no hay una frase explícita para Pro/Max)
- ¿Llega `claude_code.active_time.total`?
- ¿Qué trae exactamente `codex.tool_result` en la versión instalada?

Para verlo en crudo, ejecuta el collector con
[`agent/otelcol/config.debug.yaml`](../agent/otelcol/config.debug.yaml), que imprime
por consola en vez de enviar.

## Ajustes

### Zona horaria

«Hoy» y los cortes de cada día se calculan en la zona del equipo, no en UTC. Con UTC,
en un equipo en América la vista «Ahora» se vaciaba cada tarde porque el día ya había
cambiado. Para cambiarla, en el SQL Editor de Supabase:

```sql
select set_team_timezone('America/Mexico_City');
```

Valida el nombre (tiene que ser una zona IANA) y recalcula los días que aún tienen
detalle, para que el histórico quede cortado igual que lo nuevo.

### Retención

90 días de detalle; después solo quedan los agregados por persona y día. Para
cambiar el plazo:

```sql
update settings set value = '120', updated_at = now() where key = 'retention_days';
```

La variable `RETENTION_DAYS` de Vercel ya no se usa: el plazo vive en la base, porque
el recálculo de días antiguos necesita saberlo para no vaciar los ya purgados. Se
puede borrar.

### Contraseña del panel

Es `DASHBOARD_PASSWORD` en Vercel. Para cambiarla: edita la variable y redespliega.
Al cambiarla se cierran todas las sesiones abiertas. Las sesiones duran 30 días, y
tras 10 intentos fallidos en 15 minutos desde un mismo origen se bloquea el acceso
durante 15 minutos.

## Opcional

### Reconciliación horaria

El plan Hobby de Vercel solo admite crons diarios. El tablero se refresca en cada
webhook, así que el cron solo es la red de seguridad que recupera eventos perdidos.
Si quieres cadencia horaria sin pagar el plan Pro, activa
[`.github/workflows/reconcile.yml`](../.github/workflows/reconcile.yml) añadiendo dos
secretos al repositorio: `PANEL_URL` y `CRON_SECRET`.

### Token de API de GitHub

Habilita la reconciliación y el refresco de `mergeable_state` (que el webhook casi
siempre manda nulo, porque GitHub lo calcula aparte). Sin él el sistema funciona,
pero el tablero no distingue un conflicto de un CI en rojo.

Crea un token de solo lectura con permisos de *Contents: read* y *Pull requests:
read*, y añádelo a Vercel como `GITHUB_API_TOKEN`.

### Medición de retrabajo

Ya está activada (`FILE_HASH_SALT` configurada). Guarda un HMAC de cada ruta de
archivo, nunca la ruta, así que puede contar archivos retocados sin que la base de
datos contenga ninguna ruta. **Cambiar la sal invalida el histórico**, porque los
hashes dejan de coincidir.

### Firma de código

Sin firmar, SmartScreen avisa en cada versión nueva. Los certificados EV **ya no
saltan SmartScreen** (Microsoft retiró ese comportamiento en 2024), así que EV y OV
acumulan reputación igual. Con un certificado:

```
signtool sign /fd sha256 /tr <url-rfc3161> /td sha256 MedicionAgent-Setup.exe
```

Siempre con marca de tiempo: sin ella, la firma caduca con el certificado.

## Dónde está cada secreto

Todos en las variables de entorno de Vercel. Ninguno en el repositorio.

| Variable | Para qué | Quién lo pone |
|---|---|---|
| `SUPABASE_URL` | Base de datos | ya configurado |
| `SUPABASE_SERVICE_ROLE_KEY` | Base de datos | **tú** (paso 1) |
| `DASHBOARD_PASSWORD` | Entrar al panel | ya configurado |
| `SESSION_SECRET` | Firma las sesiones del panel | ya configurado |
| `INGEST_TOKEN` | Lo presentan los PCs | ya configurado |
| `GITHUB_WEBHOOK_SECRET` | Firma del webhook | ya configurado |
| `CRON_SECRET` | Protege el cron | ya configurado |
| `FILE_HASH_SALT` | HMAC de rutas | ya configurado |
| `GITHUB_ORG` | Usuario u organización | ya configurado |
| `GITHUB_API_TOKEN` | Reconciliación | **tú**, opcional |
