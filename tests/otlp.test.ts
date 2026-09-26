import { describe, expect, it } from 'vitest'
import { detectTool, flattenAttributes, nanosToIso, parseOtlp } from '@/lib/otlp'

const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } })
const NANOS = String(Date.parse('2026-09-26T10:00:00Z') * 1e6)

describe('nanosToIso', () => {
  it('convierte nanosegundos en string, que es como llegan en OTLP JSON', () => {
    expect(nanosToIso('1790000000000000000')).toBe(
      new Date(1790000000000).toISOString(),
    )
  })

  it('devuelve null para valores no utilizables', () => {
    for (const v of [undefined, null, 0, -1, 'abc', '']) {
      expect(nanosToIso(v), String(v)).toBeNull()
    }
  })
})

describe('flattenAttributes', () => {
  it('desempaqueta los tipos escalares de AnyValue', () => {
    const out = flattenAttributes([
      { key: 's', value: { stringValue: 'x' } },
      { key: 'b', value: { boolValue: true } },
      { key: 'd', value: { doubleValue: 1.5 } },
      { key: 'i', value: { intValue: '42' } },
    ])
    expect(out).toEqual({ s: 'x', b: true, d: 1.5, i: 42 })
  })

  it('deja fuera array, kvlist y bytes, que pueden traer contenido', () => {
    const out = flattenAttributes([
      { key: 'arr', value: { arrayValue: { values: [] } } },
      { key: 'kv', value: { kvlistValue: { values: [] } } },
      { key: 'by', value: { bytesValue: 'AAA=' } },
    ])
    expect(out).toEqual({})
  })

  it('tolera entradas malformadas sin lanzar', () => {
    expect(flattenAttributes(undefined)).toEqual({})
    expect(flattenAttributes([{ key: 'x' }, {}, { value: { stringValue: 'y' } }])).toEqual(
      {},
    )
  })
})

describe('detectTool', () => {
  it('deduce la herramienta por prefijo del nombre', () => {
    expect(detectTool('claude_code.session.count', null)).toBe('claude_code')
    expect(detectTool('codex.api_request', null)).toBe('codex')
  })

  it('cae al service.name cuando el nombre no tiene prefijo', () => {
    expect(detectTool('otra.metrica', 'claude-code-desktop')).toBe('claude_code')
    expect(detectTool('otra.metrica', 'codex-cli')).toBe('codex')
  })

  it('devuelve null para telemetria de terceros', () => {
    expect(detectTool('http.server.duration', 'nginx')).toBeNull()
  })
})

describe('parseOtlp: metricas', () => {
  const payload = (metric: Record<string, unknown>) => ({
    resourceMetrics: [
      {
        resource: {
          attributes: [attr('host.name', 'PC-07'), attr('service.name', 'claude-code')],
        },
        scopeMetrics: [{ metrics: [metric] }],
      },
    ],
  })

  it('lee un sum con asDouble', () => {
    const { metrics } = parseOtlp(
      payload({
        name: 'claude_code.active_time.total',
        unit: 's',
        sum: { dataPoints: [{ timeUnixNano: NANOS, asDouble: 300 }] },
      }),
    )
    expect(metrics[0]).toMatchObject({ value: 300, unit: 's', hostname: 'pc-07' })
  })

  it('lee un sum con asInt en string', () => {
    const { metrics } = parseOtlp(
      payload({
        name: 'claude_code.commit.count',
        sum: { dataPoints: [{ timeUnixNano: NANOS, asInt: '7' }] },
      }),
    )
    expect(metrics[0]!.value).toBe(7)
  })

  it('lee un gauge', () => {
    const { metrics } = parseOtlp(
      payload({
        name: 'codex.turn.token_usage',
        gauge: { dataPoints: [{ timeUnixNano: NANOS, asDouble: 1200 }] },
      }),
    )
    expect(metrics[0]).toMatchObject({ value: 1200, tool: 'codex' })
  })

  it('de un histograma guarda la suma, que es lo unico agregable', () => {
    const { metrics } = parseOtlp(
      payload({
        name: 'claude_code.cost.usage',
        histogram: { dataPoints: [{ timeUnixNano: NANOS, sum: 2.5, count: 3 }] },
      }),
    )
    expect(metrics[0]!.value).toBe(2.5)
  })

  it('descarta puntos sin valor o sin hora', () => {
    const sinValor = parseOtlp(
      payload({
        name: 'claude_code.session.count',
        sum: { dataPoints: [{ timeUnixNano: NANOS }] },
      }),
    )
    expect(sinValor.metrics).toHaveLength(0)

    const sinHora = parseOtlp(
      payload({
        name: 'claude_code.session.count',
        sum: { dataPoints: [{ asDouble: 1 }] },
      }),
    )
    expect(sinHora.metrics).toHaveLength(0)
  })

  it('cuenta como descartado lo que no se puede atribuir a un equipo', () => {
    const { metrics, dropped } = parseOtlp({
      resourceMetrics: [
        {
          resource: { attributes: [attr('service.name', 'claude-code')] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.session.count',
                  sum: { dataPoints: [{ timeUnixNano: NANOS, asDouble: 1 }] },
                },
              ],
            },
          ],
        },
      ],
    })
    // Sin host.name no hay a quien atribuirlo: se descarta y se cuenta.
    expect(metrics).toHaveLength(0)
    expect(dropped).toBe(1)
  })

  it('ignora un hostname con forma invalida', () => {
    const { dropped } = parseOtlp({
      resourceMetrics: [
        {
          resource: {
            attributes: [
              attr('host.name', 'no es un hostname / con barras'),
              attr('service.name', 'claude-code'),
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.session.count',
                  sum: { dataPoints: [{ timeUnixNano: NANOS, asDouble: 1 }] },
                },
              ],
            },
          ],
        },
      ],
    })
    expect(dropped).toBe(1)
  })
})

describe('parseOtlp: eventos', () => {
  const logs = (records: Record<string, unknown>[]) => ({
    resourceLogs: [
      {
        resource: {
          attributes: [attr('host.name', 'PC-07'), attr('service.name', 'codex')],
        },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  })

  it('toma el nombre del atributo event.name', () => {
    const { events } = parseOtlp(
      logs([
        {
          timeUnixNano: NANOS,
          attributes: [attr('event.name', 'codex.conversation_starts')],
        },
      ]),
    )
    expect(events[0]!.event_name).toBe('codex.conversation_starts')
  })

  it('acepta el cuerpo solo si tiene forma de nombre de evento', () => {
    const bueno = parseOtlp(
      logs([{ timeUnixNano: NANOS, body: { stringValue: 'codex.api_request' } }]),
    )
    expect(bueno.events[0]!.event_name).toBe('codex.api_request')

    // Un cuerpo de texto libre podria ser contenido: se ignora el registro.
    const malo = parseOtlp(
      logs([
        {
          timeUnixNano: NANOS,
          body: { stringValue: 'El usuario pidio arreglar el login de produccion' },
        },
      ]),
    )
    expect(malo.events).toHaveLength(0)
  })

  it('toma session.id de Claude o conversation.id de Codex', () => {
    const { events } = parseOtlp(
      logs([
        {
          timeUnixNano: NANOS,
          attributes: [
            attr('event.name', 'codex.api_request'),
            attr('conversation.id', 'conv-abc-123'),
          ],
        },
      ]),
    )
    expect(events[0]!.session_id).toBe('conv-abc-123')
  })

  it('rechaza un session_id con forma sospechosa', () => {
    const { events } = parseOtlp(
      logs([
        {
          timeUnixNano: NANOS,
          attributes: [
            attr('event.name', 'codex.api_request'),
            attr('conversation.id', 'esto no es un id; es texto con espacios'),
          ],
        },
      ]),
    )
    expect(events[0]!.session_id).toBeNull()
  })

  it('cae a observedTimeUnixNano si no hay timeUnixNano', () => {
    const { events } = parseOtlp(
      logs([
        {
          observedTimeUnixNano: NANOS,
          attributes: [attr('event.name', 'codex.api_request')],
        },
      ]),
    )
    expect(events[0]!.occurred_at).toBe('2026-09-26T10:00:00.000Z')
  })
})

describe('parseOtlp: robustez', () => {
  it('no lanza con entradas basura', () => {
    for (const bad of [null, undefined, 0, 'texto', [], {}, { resourceMetrics: 'x' }]) {
      expect(() => parseOtlp(bad), JSON.stringify(bad)).not.toThrow()
    }
  })

  it('procesa metricas y logs en el mismo payload', () => {
    const result = parseOtlp({
      resourceMetrics: [
        {
          resource: {
            attributes: [attr('host.name', 'pc-01'), attr('service.name', 'claude-code')],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.session.count',
                  sum: { dataPoints: [{ timeUnixNano: NANOS, asDouble: 1 }] },
                },
              ],
            },
          ],
        },
      ],
      resourceLogs: [
        {
          resource: {
            attributes: [attr('host.name', 'pc-01'), attr('service.name', 'codex')],
          },
          scopeLogs: [
            {
              logRecords: [
                { timeUnixNano: NANOS, attributes: [attr('event.name', 'codex.api_request')] },
              ],
            },
          ],
        },
      ],
    })
    expect(result.metrics).toHaveLength(1)
    expect(result.events).toHaveLength(1)
  })
})
