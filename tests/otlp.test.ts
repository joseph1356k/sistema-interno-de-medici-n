import { describe, expect, it } from 'vitest'
import { detectTool, flattenAttributes, nanosToIso, parseOtlp } from '@/lib/otlp'

const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } })
const NANOS = String(Date.parse('2026-09-26T10:00:00Z') * 1e6)
// "Ahora" fijo: el parser rechaza datos fuera de una ventana de tiempo, asi que
// sin esto los tests dejarian de pasar solos cuando la fecha real avanzara.
const NOW = Date.parse('2026-09-26T12:00:00Z')

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
      NOW,
    )
    expect(metrics[0]).toMatchObject({ value: 300, unit: 's', hostname: 'pc-07' })
  })

  it('lee un sum con asInt en string', () => {
    const { metrics } = parseOtlp(
      payload({
        name: 'claude_code.commit.count',
        sum: { dataPoints: [{ timeUnixNano: NANOS, asInt: '7' }] },
      }),
      NOW,
    )
    expect(metrics[0]!.value).toBe(7)
  })

  it('lee un gauge', () => {
    const { metrics } = parseOtlp(
      payload({
        name: 'codex.turn.token_usage',
        gauge: { dataPoints: [{ timeUnixNano: NANOS, asDouble: 1200 }] },
      }),
      NOW,
    )
    expect(metrics[0]).toMatchObject({ value: 1200, tool: 'codex' })
  })

  it('de un histograma guarda la suma, que es lo unico agregable', () => {
    const { metrics } = parseOtlp(
      payload({
        name: 'claude_code.cost.usage',
        histogram: { dataPoints: [{ timeUnixNano: NANOS, sum: 2.5, count: 3 }] },
      }),
      NOW,
    )
    expect(metrics[0]!.value).toBe(2.5)
  })

  it('descarta puntos sin valor o sin hora', () => {
    const sinValor = parseOtlp(
      payload({
        name: 'claude_code.session.count',
        sum: { dataPoints: [{ timeUnixNano: NANOS }] },
      }),
      NOW,
    )
    expect(sinValor.metrics).toHaveLength(0)

    const sinHora = parseOtlp(
      payload({
        name: 'claude_code.session.count',
        sum: { dataPoints: [{ asDouble: 1 }] },
      }),
      NOW,
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
    }, NOW)
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
    }, NOW)
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
      NOW,
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
      NOW,
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
      expect(() => parseOtlp(bad, NOW), JSON.stringify(bad)).not.toThrow()
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
    }, NOW)
    expect(result.metrics).toHaveLength(1)
    expect(result.events).toHaveLength(1)
  })
})

describe('deduplicacion: los reintentos del collector no cuentan dos veces', () => {
  const payload = () => ({
    resourceMetrics: [
      {
        resource: {
          attributes: [attr('host.name', 'pc-01'), attr('service.name', 'claude-code')],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.active_time.total',
                sum: {
                  dataPoints: [
                    {
                      startTimeUnixNano: String(Date.parse('2026-09-26T09:59:00Z') * 1e6),
                      timeUnixNano: NANOS,
                      asDouble: 60,
                      attributes: [attr('type', 'user')],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  })

  it('el mismo lote reenviado produce la misma clave', () => {
    // Es lo que pasa cuando la respuesta se pierde y el collector reintenta un
    // lote que el servidor ya habia guardado.
    const a = parseOtlp(payload(), NOW).metrics[0]!
    const b = parseOtlp(payload(), NOW).metrics[0]!
    expect(a.dedup_key).toBe(b.dedup_key)
  })

  it('el mismo valor en otra ventana de tiempo es otro punto', () => {
    const otro = payload()
    otro.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.sum.dataPoints[0]!.timeUnixNano =
      String(Date.parse('2026-09-26T10:01:00Z') * 1e6)
    expect(parseOtlp(otro, NOW).metrics[0]!.dedup_key).not.toBe(
      parseOtlp(payload(), NOW).metrics[0]!.dedup_key,
    )
  })

  it('el mismo instante con otros atributos es otra serie', () => {
    const cli = payload()
    cli.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.sum.dataPoints[0]!.attributes = [
      attr('type', 'cli'),
    ]
    expect(parseOtlp(cli, NOW).metrics[0]!.dedup_key).not.toBe(
      parseOtlp(payload(), NOW).metrics[0]!.dedup_key,
    )
  })

  it('el orden de los atributos no cambia la clave', () => {
    const point = (attrs: { key: string; value: { stringValue: string } }[]) => ({
      resourceMetrics: [
        {
          resource: {
            attributes: [attr('host.name', 'pc-01'), attr('service.name', 'claude-code')],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.token.usage',
                  sum: { dataPoints: [{ timeUnixNano: NANOS, asDouble: 5, attributes: attrs }] },
                },
              ],
            },
          ],
        },
      ],
    })
    const a = parseOtlp(point([attr('type', 'input'), attr('model', 'm')]), NOW).metrics[0]!
    const b = parseOtlp(point([attr('model', 'm'), attr('type', 'input')]), NOW).metrics[0]!
    expect(a.dedup_key).toBe(b.dedup_key)
  })

  it('los eventos tambien llevan clave estable', () => {
    const logs = {
      resourceLogs: [
        {
          resource: { attributes: [attr('host.name', 'pc-01'), attr('service.name', 'codex')] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: NANOS,
                  attributes: [
                    attr('event.name', 'codex.api_request'),
                    attr('conversation.id', 'c1'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(parseOtlp(logs, NOW).events[0]!.dedup_key).toBe(
      parseOtlp(logs, NOW).events[0]!.dedup_key,
    )
  })
})

describe('saneamiento: datos imposibles no entran', () => {
  const metricAt = (timeIso: string, value: number, name = 'claude_code.active_time.total') => ({
    resourceMetrics: [
      {
        resource: {
          attributes: [attr('host.name', 'pc-01'), attr('service.name', 'claude-code')],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name,
                sum: {
                  dataPoints: [{ timeUnixNano: String(Date.parse(timeIso) * 1e6), asDouble: value }],
                },
              },
            ],
          },
        ],
      },
    ],
  })

  it('rechaza datos del futuro: un PC con el reloj adelantado', () => {
    // Un dato con fecha de la semana que viene contaminaria el rollup de un dia que
    // aun no ha pasado.
    const r = parseOtlp(metricAt('2026-10-05T10:00:00Z', 60), NOW)
    expect(r.metrics).toHaveLength(0)
    expect(r.rejected.bad_time).toBe(1)
  })

  it('tolera el desfase normal de un reloj', () => {
    // Unos minutos por delante es lo habitual y no debe perderse.
    expect(parseOtlp(metricAt('2026-09-26T12:10:00Z', 60), NOW).metrics).toHaveLength(1)
  })

  it('rechaza datos demasiado viejos: reescribirian dias ya cerrados', () => {
    const r = parseOtlp(metricAt('2026-08-01T10:00:00Z', 60), NOW)
    expect(r.metrics).toHaveLength(0)
    expect(r.rejected.bad_time).toBe(1)
  })

  it('acepta un retraso razonable, como un portatil que vuelve a tener red', () => {
    expect(parseOtlp(metricAt('2026-09-24T10:00:00Z', 60), NOW).metrics).toHaveLength(1)
  })

  it('rechaza valores negativos', () => {
    const r = parseOtlp(metricAt('2026-09-26T10:00:00Z', -5, 'claude_code.cost.usage'), NOW)
    expect(r.metrics).toHaveLength(0)
    expect(r.rejected.bad_value).toBe(1)
  })

  it('rechaza mas de un dia de tiempo activo en un solo punto', () => {
    // La metrica se exporta cada 60 s: un punto con 2 dias de actividad no es un
    // dato raro, es un dato roto.
    const r = parseOtlp(metricAt('2026-09-26T10:00:00Z', 2 * 86_400), NOW)
    expect(r.metrics).toHaveLength(0)
    expect(r.rejected.bad_value).toBe(1)
  })

  it('el tope de duracion no afecta a otras metricas', () => {
    // 200.000 tokens en un punto es perfectamente posible.
    const r = parseOtlp(
      metricAt('2026-09-26T10:00:00Z', 200_000, 'claude_code.token.usage'),
      NOW,
    )
    expect(r.metrics).toHaveLength(1)
  })

  it('desglosa el motivo de cada descarte', () => {
    const r = parseOtlp(metricAt('2030-01-01T00:00:00Z', 60), NOW)
    expect(r.rejected).toEqual({ no_host: 0, bad_time: 1, bad_value: 0 })
    expect(r.dropped).toBe(1)
  })
})
