# Qué vamos a medir y por qué

*Documento para el equipo. Entregar **antes** de instalar nada.*

## Por qué

Pagamos Claude y Codex, y no sabemos si nos sirven. No tenemos forma de responder
preguntas básicas: si las herramientas están ayudando, si a alguien le falta
formación para aprovecharlas, si nuestros PRs se quedan parados esperando
revisión. Hoy eso se decide por intuición.

Además, todos entramos con las mismas cuentas de Claude, así que las analíticas
que trae la propia herramienta no distinguen personas y no nos dicen nada.

## Qué se mide

Dos cosas, nada más:

1. **Uso de Claude Code y Codex**: tiempo activo, número de sesiones, tokens,
   coste, y cuántas sugerencias de edición se aceptan o se rechazan.
2. **Ritmo de entrega**: push, PRs, merges y revisiones — lo que ya es público en
   GitHub, organizado para poder verlo por persona y por equipo.

## Qué NO se mide

Esto es tan importante como lo anterior:

- **No se guarda el texto de los prompts** ni las respuestas del modelo.
- **No se guarda código**, ni diffs, ni parches, ni rutas de archivo, ni los
  comandos que ejecutas.
- **No hay capturas de pantalla, ni registro de teclas, ni cámara, ni micrófono.**
  El sistema no incluye ninguna pieza capaz de hacerlo.
- **No se mira qué aplicaciones usas**, ni qué páginas visitas, ni los títulos de
  tus ventanas. No hay monitor de ventanas ni extensión de navegador.
- **No se mide nada fuera de Claude Code, Codex y git.** Si abres Spotify, Slack o
  cualquier otra cosa, el sistema no lo ve.

Consideramos medir el tiempo por aplicación y decidimos no hacerlo. Aparte de ser
invasivo, el dato sería malo: el tiempo con una ventana abierta no distingue
trabajar de estar esperando.

## Cómo funciona

En cada PC corre un pequeño servicio local. Antes de enviar nada, **borra el
contenido sensible en tu propia máquina**. Lo que sale son contadores y
duraciones, no texto.

Se sabe de quién es cada dato por el **nombre del equipo**, no por la cuenta de
Claude (que es compartida). El único sitio donde un nombre se asocia con datos es
una tabla del servidor.

Un caso que merece mención explícita, porque es la parte menos limpia: Codex envía
siempre los argumentos de los comandos que ejecuta, y no ofrece forma de
desactivarlo. Por eso el servicio local existe: los borra antes de que salgan del
PC.

## Cómo lo compruebas tú

No hay que creernos. Todo el código está en este repositorio:

- [`PRIVACY.md`](../PRIVACY.md) — la lista literal, campo por campo, de lo que se
  guarda.
- [`src/lib/allowlist.ts`](../src/lib/allowlist.ts) — el filtro. Lo que no está
  en esa lista no se guarda.
- `npm test` — incluye un test que mete un marcador en todos los campos
  sensibles posibles y verifica que no aparece en ningún lado.

Si ves algo que no te cuadra, dilo. Preferimos discutirlo ahora que después.

## Qué se hace con esto

**Para qué sí:**

- Decidir si Claude y Codex valen lo que cuestan.
- Detectar quién podría aprovecharlas mejor con algo de formación.
- Encontrar bloqueos de proceso: un PR abierto diez días es un problema nuestro,
  no de quien lo abrió.

**Para qué no:**

- **No es una herramienta de evaluación de rendimiento individual.** Los push por
  día y las horas en una herramienta son métricas de flujo, fáciles de inflar y
  malas para juzgar a nadie. Castigan justo el trabajo difícil: refactors
  grandes, depuración, pensar antes de escribir.
- No se van a comparar personas entre sí en reuniones.
- Ningún número de aquí va a ser, por sí solo, motivo de una conversación
  disciplinaria.

Si en algún momento estos datos se usan de una forma que no está en esta lista, se
os dice antes.

## Tus derechos sobre esto

- **Puedes ver tus propios datos** en el panel, cuando quieras.
- **Puedes pedir que se borren.** La retención normal es de 90 días de detalle y
  después solo agregados mensuales.
- **Puedes desactivarlo** en tu PC con `agent/windows/uninstall.ps1`. Si llegas a
  ese punto, preferimos que nos digas por qué.

## A quién preguntar

*(Completar antes de entregar: quién administra el sistema, quién responde dudas
de privacidad, y la fecha desde la que está activo.)*

---

*Nota para quien despliegue esto: según el país donde esté contratado el equipo,
informar puede no ser solo buena práctica sino requisito legal (en la UE, el RGPD
exige base legal e información previa). Conviene revisarlo con quien lleve lo
laboral antes de encenderlo.*
