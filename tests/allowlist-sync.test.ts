/**
 * La allowlist existe en dos sitios: en TypeScript (barrera del servidor) y en
 * el YAML del collector (barrera del PC, la que impide que el contenido salga de
 * la maquina). Este test falla si se separan.
 *
 * Sin esto, el riesgo real es anadir una clave en el servidor y olvidarla en el
 * collector, o al contrario: la proteccion quedaria a medias sin que nadie lo note.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EVENT_ATTRS, METRIC_ATTRS, NEVER_STORED, RESOURCE_ATTRS } from '@/lib/allowlist'

const config = readFileSync(join(process.cwd(), 'agent/otelcol/config.yaml'), 'utf8')
const privacyDoc = readFileSync(join(process.cwd(), 'PRIVACY.md'), 'utf8')
const managedSettings = readFileSync(
  join(process.cwd(), 'agent/windows/managed-settings.json'),
  'utf8',
)

/** Extrae cada `keep_keys(attributes, [...])` del YAML como lista de claves. */
function keepKeysLists(source: string): string[][] {
  const lists: string[][] = []
  const re = /keep_keys\(attributes,\s*\[([^\]]*)\]\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const keys = [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
    lists.push(keys)
  }
  return lists
}

const lists = keepKeysLists(config)

describe('sincronia entre la allowlist del servidor y la del collector', () => {
  it('encuentra las cuatro listas esperadas en el YAML', () => {
    // resource (metricas), datapoint, resource (logs), log
    expect(lists).toHaveLength(4)
  })

  it('las dos listas de recurso coinciden con RESOURCE_ATTRS', () => {
    const expected = [...RESOURCE_ATTRS].sort()
    expect([...lists[0]!].sort()).toEqual(expected)
    expect([...lists[2]!].sort()).toEqual(expected)
  })

  it('la lista de datapoint coincide con METRIC_ATTRS', () => {
    expect([...lists[1]!].sort()).toEqual([...METRIC_ATTRS].sort())
  })

  it('la lista de log cubre EVENT_ATTRS mas las claves de identificacion', () => {
    const logKeys = new Set(lists[3]!)

    for (const key of EVENT_ATTRS) {
      expect(logKeys, `el collector borraria "${key}", que el servidor espera`).toContain(
        key,
      )
    }

    // El parser las lee aparte (eventNameOf / safeSessionId), asi que no estan
    // en EVENT_ATTRS, pero el collector tiene que dejarlas pasar.
    for (const key of ['event.name', 'event_name', 'session.id', 'conversation.id']) {
      expect(logKeys, `falta la clave de identificacion "${key}"`).toContain(key)
    }
  })

  it('ninguna lista del collector permite una clave de NEVER_STORED', () => {
    for (const [index, list] of lists.entries()) {
      for (const forbidden of NEVER_STORED) {
        expect(list, `lista ${index} permite "${forbidden}"`).not.toContain(forbidden)
      }
    }
  })

  it('el collector vacia los cuerpos de log que no sean nombres de evento', () => {
    // Sin esta regla, un prompt en el cuerpo del log viajaria hasta el servidor.
    expect(config).toContain('set(body, "") where not IsMatch(body,')
  })

  it('el receptor solo escucha en loopback', () => {
    expect(config).toContain('endpoint: 127.0.0.1:4318')
    expect(config).not.toMatch(/endpoint:\s*0\.0\.0\.0/)
  })

  it('la cola en disco esta activada, para no perder datos sin red', () => {
    expect(config).toContain('storage: file_storage/queue')
    expect(config).toMatch(/retry_on_failure:\s*\n\s*enabled: true/)
  })
})

describe('PRIVACY.md dice la verdad', () => {
  // El documento es lo que el equipo lee para confiar en el sistema. Si una
  // clave se guarda pero no esta documentada, el documento miente por omision.
  const documented = [...RESOURCE_ATTRS, ...METRIC_ATTRS, ...EVENT_ATTRS]

  it('documenta cada campo que el sistema guarda', () => {
    for (const key of new Set(documented)) {
      expect(privacyDoc, `PRIVACY.md no menciona "${key}"`).toContain(key)
    }
  })

  it('nombra las variables que activarian el envio de contenido', () => {
    // Son las que NO se ponen. Que esten nombradas permite verificar la ausencia.
    expect(privacyDoc).toContain('OTEL_LOG_USER_PROMPTS')
    expect(privacyDoc).toContain('OTEL_LOG_TOOL_DETAILS')
  })
})

describe('managed-settings.json de Claude Code', () => {
  const parsed = JSON.parse(managedSettings) as { env: Record<string, string> }

  it('no activa el envio de prompts ni de detalles de herramientas', () => {
    expect(parsed.env).not.toHaveProperty('OTEL_LOG_USER_PROMPTS')
    expect(parsed.env).not.toHaveProperty('OTEL_LOG_TOOL_DETAILS')
  })

  it('apunta al collector local, no directo a internet', () => {
    expect(parsed.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:4318')
  })

  it('fija host.name, que Claude Code no envia por su cuenta', () => {
    expect(parsed.env.OTEL_RESOURCE_ATTRIBUTES).toContain('host.name=')
  })

  it('usa http/json, que es lo que la ruta de ingesta sabe leer', () => {
    expect(parsed.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/json')
  })
})
