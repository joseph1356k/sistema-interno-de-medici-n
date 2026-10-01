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
2. **Lo que ya es público en GitHub**, organizado para poder verlo: push, PRs,
   merges, revisiones, resultados de CI y despliegues.

De lo segundo salen métricas que probablemente os interesen tanto como a quien
manda:

- **Cuánto tarda un PR en recibir la primera revisión**, y en mergearse. Si el
  cuello de botella es la revisión, el dato lo dice en vez de suponerse.
- **Cuántas revisiones hace cada persona.** Revisar es trabajo real que casi nunca
  se cuenta en ninguna parte y por el que nadie recibe crédito. Aquí se cuenta.
- **Tamaño de PR contra velocidad de revisión.** Si los PR grandes tardan diez veces
  más, la conclusión es partir los PR, no pedir revisiones más rápidas.
- **Tests inestables**: los que fallan y pasan con el mismo código. Cuestan más de lo
  que parece, porque enseñan al equipo a relanzar CI sin leer el error.
- **Si alguien está trabajando de madrugada o en fin de semana de forma sostenida.**
  Se mira a nivel de equipo, y es una alerta de riesgo de quemarse, no una medalla.

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
- **No hay indicador de «activo ahora».** No existe una luz verde o roja por
  persona, ni una línea de tiempo por minutos.
- **No se guardan mensajes de commit, ni títulos de PR, ni el texto de los
  comentarios de revisión.** Solo se cuentan.

Consideramos medir el tiempo por aplicación y decidimos no hacerlo. Aparte de ser
invasivo, el dato sería malo: el tiempo con una ventana abierta no distingue
trabajar de estar esperando.

Y consideramos poner un indicador de actividad en tiempo real por persona. Lo
descartamos por una razón que conviene entender: **la telemetría solo ve Claude Code
y Codex**. Si estás leyendo documentación, en una reunión, depurando en el navegador,
en una pizarra o simplemente pensando, apareces como cero. Un semáforo de «inactivo»
estaría equivocado la mayor parte del tiempo, y equivocado justo contra el trabajo
más difícil.

Por eso el panel muestra **qué le pasa al trabajo** (qué PR está atascado y por qué)
en vez de qué está haciendo cada uno ahora mismo.

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

## Un cero no significa un día sin trabajar

Hay dos motivos para que aparezca un cero, y ninguno es «no trabajó»:

1. **Ese día el trabajo no pasó por Claude Code ni por Codex.** Reuniones, diseño,
   depuración en el navegador, pensar. La telemetría no lo ve.
2. **El agente dejó de reportar.** En Windows, la configuración de Codex se puede
   sobrescribir y no hay forma de forzarla. El panel tiene una vista **Salud** que
   avisa de qué equipos llevan días sin enviar nada, precisamente para que un fallo
   de instalación no se lea como inactividad de una persona.

Si ves un número tuyo que no te cuadra, dilo: es más probable que haya un error de
medición que un hallazgo.

## Todos veis lo mismo

El panel es **simétrico**: hay una sola contraseña y todo el equipo ve los mismos
datos, los de todos, incluidos los de quien pidió el sistema.

Es una decisión de diseño, no un descuido. Si estos datos solo los ve quien manda, es
vigilancia; si los ve todo el equipo por igual, es información compartida, y
cualquiera puede detectar un número mal calculado.

La tabla por persona está ordenada **alfabéticamente**, nunca por ninguna métrica.
Ordenarla por horas o por push la convertiría en un ranking, y no es para eso.

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
  después solo agregados por día.
- **Puedes desactivarlo** en tu PC desinstalando el agente: Configuración →
  Aplicaciones → «Medición interna - Agente» → Desinstalar (hace falta permiso de
  administrador del equipo). Quita todo lo que instaló. Si llegas a ese punto,
  preferimos que nos digas por qué.

## A quién preguntar

*(Completar antes de entregar: quién administra el sistema, quién responde dudas
de privacidad, y la fecha desde la que está activo.)*

---

*Nota para quien despliegue esto: según el país donde esté contratado el equipo,
informar puede no ser solo buena práctica sino requisito legal (en la UE, el RGPD
exige base legal e información previa). Conviene revisarlo con quien lleve lo
laboral antes de encenderlo.*
