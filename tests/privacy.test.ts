/**
 * Test de la barrera de privacidad.
 *
 * Este es el test que se le muestra al equipo: construye payloads OTLP con
 * contenido sensible en todos los campos donde las herramientas podrian ponerlo
 * -- incluido `codex.tool_result`, que manda SIEMPRE los argumentos de la
 * herramienta y 2 KB de salida sin opcion de desactivarlo -- y verifica que nada
 * de eso sobrevive al parseo.
 */

import { describe, expect, it } from 'vitest'
import { NEVER_STORED, MAX_ATTR_LENGTH, filterAttrs, METRIC_ATTRS } from '@/lib/allowlist'
import { parseOtlp } from '@/lib/otlp'

/** Marcadores unicos: si alguno aparece en la salida, hay una fuga. */
const SECRET = 'CANARIO_NO_DEBE_APARECER_JAMAS'

const attr = (key: string, value: string | number | boolean) => ({
  key,
  value:
    typeof value === 'number'
      ? { doubleValue: value }
      : typeof value === 'boolean'
        ? { boolValue: value }
        : { stringValue: value },
})

const NOW_NANOS = String(Date.parse('2026-09-26T10:00:00Z') * 1e6)
// "Ahora" fijo: el parser rechaza datos fuera de una ventana de tiempo.
const NOW = Date.parse('2026-09-26T12:00:00Z')

/** Un atributo con el canario por cada clave que nunca debe guardarse. */
const poisonedAttrs = NEVER_STORED.map((key) => attr(key, `${SECRET}:${key}`))

function metricsPayload() {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            attr('host.name', 'PC-07'),
            attr('service.name', 'claude-code'),
            // Identidad de la cuenta compartida: debe caer.
            attr('user.email', `${SECRET}@empresa.com`),
            attr('user.account_uuid', SECRET),
            attr('organization.id', SECRET),
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.active_time.total',
                unit: 's',
                sum: {
                  dataPoints: [
                    {
                      timeUnixNano: NOW_NANOS,
                      asDouble: 420,
                      attributes: [attr('type', 'user'), ...poisonedAttrs],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  }
}

function logsPayload() {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [attr('host.name', 'PC-07'), attr('service.name', 'codex')],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: NOW_NANOS,
                body: { stringValue: 'codex.tool_result' },
                attributes: [
                  attr('event.name', 'codex.tool_result'),
                  attr('conversation.id', 'conv-123'),
                  attr('success', true),
                  attr('duration_ms', 1500),
                  // Lo que Codex manda siempre y no se puede desactivar:
                  attr('arguments', `rm -rf /tmp && cat .env # ${SECRET}`),
                  attr('output', `AWS_SECRET_KEY=${SECRET}`),
                  ...poisonedAttrs,
                ],
              },
              {
                timeUnixNano: NOW_NANOS,
                attributes: [
                  attr('event.name', 'claude_code.user_prompt'),
                  attr('prompt_length', 240),
                  attr('prompt', `arregla el login roto ${SECRET}`),
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

describe('barrera de privacidad', () => {
  it('no deja pasar ninguna clave de la lista NEVER_STORED', () => {
    const result = parseOtlp({ ...metricsPayload(), ...logsPayload() }, NOW)
    const rows = [...result.metrics, ...result.events]
    expect(rows.length).toBeGreaterThan(0)

    for (const row of rows) {
      for (const forbidden of NEVER_STORED) {
        expect(
          Object.keys(row.attrs),
          `la clave "${forbidden}" sobrevivio al filtro`,
        ).not.toContain(forbidden)
      }
    }
  })

  it('el canario no aparece en ninguna parte del resultado serializado', () => {
    const result = parseOtlp({ ...metricsPayload(), ...logsPayload() }, NOW)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('descarta los argumentos y la salida de codex.tool_result', () => {
    const { events } = parseOtlp(logsPayload(), NOW)
    const toolResult = events.find((e) => e.event_name === 'codex.tool_result')

    expect(toolResult).toBeDefined()
    expect(toolResult!.attrs).not.toHaveProperty('arguments')
    expect(toolResult!.attrs).not.toHaveProperty('output')
    // Lo que si se conserva: el hecho de que ocurrio, y cuanto tardo.
    expect(toolResult!.attrs).toMatchObject({ success: true, duration_ms: 1500 })
  })

  it('guarda la longitud del prompt pero no el prompt', () => {
    const { events } = parseOtlp(logsPayload(), NOW)
    const prompt = events.find((e) => e.event_name === 'claude_code.user_prompt')

    expect(prompt!.attrs).toMatchObject({ prompt_length: 240 })
    expect(prompt!.attrs).not.toHaveProperty('prompt')
  })

  it('conserva lo que si es util para medir', () => {
    const { metrics } = parseOtlp(metricsPayload(), NOW)
    expect(metrics).toHaveLength(1)
    expect(metrics[0]).toMatchObject({
      hostname: 'pc-07',
      tool: 'claude_code',
      metric: 'claude_code.active_time.total',
      value: 420,
      unit: 's',
      attrs: { type: 'user' },
    })
  })

  it('no guarda la identidad de la cuenta compartida', () => {
    const { metrics } = parseOtlp(metricsPayload(), NOW)
    const serialized = JSON.stringify(metrics)
    expect(serialized).not.toContain('user.email')
    expect(serialized).not.toContain('organization.id')
  })
})

describe('filterAttrs', () => {
  it('descarta un valor largo aunque la clave este permitida', () => {
    const long = 'x'.repeat(MAX_ATTR_LENGTH + 1)
    expect(filterAttrs({ model: long }, METRIC_ATTRS)).toEqual({})
    // Justo en el limite si pasa.
    const ok = 'x'.repeat(MAX_ATTR_LENGTH)
    expect(filterAttrs({ model: ok }, METRIC_ATTRS)).toEqual({ model: ok })
  })

  it('descarta objetos y arrays, que podrian traer contenido estructurado', () => {
    const attrs = { model: { nested: 'x' }, type: ['a', 'b'], decision: null }
    expect(filterAttrs(attrs, METRIC_ATTRS)).toEqual({})
  })

  it('no inventa claves cuando la entrada esta vacia', () => {
    expect(filterAttrs(undefined, METRIC_ATTRS)).toEqual({})
    expect(filterAttrs({}, METRIC_ATTRS)).toEqual({})
  })
})
