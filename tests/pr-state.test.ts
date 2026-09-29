/**
 * Los webhooks de GitHub llegan desordenados. Estos tests fijan que el estado
 * resultante sea correcto de todas formas, porque un tablero en vivo que muestra
 * PRs cerrados como abiertos no sirve para nada.
 */

import { describe, expect, it } from 'vitest'
import { blockReason, mergePrState, type PrPatch, type PrSnapshot } from '@/lib/pr-state'

const T = (iso: string) => `2026-09-${iso}:00Z`

function patch(over: Partial<PrPatch> & { event_ts: string }): PrPatch {
  return { repo: 'e/app', number: 7, ...over }
}

describe('mergePrState: PR nuevo', () => {
  it('crea el estado desde cero con valores por defecto sensatos', () => {
    const pr = mergePrState(
      null,
      patch({
        event_ts: T('20T09'),
        state: 'open',
        author_login: 'ana',
        created_at: T('20T09'),
        head_sha: 'aaa',
      }),
    )

    expect(pr).toMatchObject({
      repo: 'e/app',
      number: 7,
      state: 'open',
      author_login: 'ana',
      draft: false,
      requested_reviewers: 0,
      head_sha: 'aaa',
    })
  })
})

describe('mergePrState: eventos fuera de orden', () => {
  const current: PrSnapshot = mergePrState(
    null,
    patch({
      event_ts: T('20T15'),
      state: 'open',
      author_login: 'ana',
      created_at: T('20T09'),
      head_sha: 'nuevo',
      draft: false,
    }),
  )

  it('un evento viejo no pisa el estado presente', () => {
    const pr = mergePrState(
      current,
      patch({ event_ts: T('20T10'), head_sha: 'viejo', draft: true }),
    )
    expect(pr.head_sha).toBe('nuevo')
    expect(pr.draft).toBe(false)
    expect(pr.event_ts).toBe(T('20T15'))
  })

  it('un evento nuevo si lo pisa', () => {
    const pr = mergePrState(
      current,
      patch({ event_ts: T('20T18'), head_sha: 'mas_nuevo' }),
    )
    expect(pr.head_sha).toBe('mas_nuevo')
    expect(pr.event_ts).toBe(T('20T18'))
  })

  it('los hitos se quedan con el valor mas antiguo, llegue cuando llegue', () => {
    // Una revision de las 11 que llega despues de un evento de las 15.
    const pr = mergePrState(
      { ...current, first_review_at: T('20T14') },
      patch({ event_ts: T('20T10'), first_review_at: T('20T11') }),
    )
    expect(pr.first_review_at).toBe(T('20T11'))
  })

  it('un hito nuevo no reemplaza uno anterior ya registrado', () => {
    const pr = mergePrState(
      { ...current, first_review_at: T('20T11') },
      patch({ event_ts: T('20T20'), first_review_at: T('20T19') }),
    )
    expect(pr.first_review_at).toBe(T('20T11'))
  })
})

describe('mergePrState: merged es terminal', () => {
  const merged = mergePrState(
    null,
    patch({
      event_ts: T('21T10'),
      state: 'merged',
      merged_at: T('21T10'),
      created_at: T('20T09'),
    }),
  )

  it('un synchronize retrasado no des-mergea el PR', () => {
    const pr = mergePrState(merged, patch({ event_ts: T('22T10'), state: 'open' }))
    expect(pr.state).toBe('merged')
  })

  it('tampoco lo cierra como no mergeado', () => {
    const pr = mergePrState(merged, patch({ event_ts: T('23T10'), state: 'closed' }))
    expect(pr.state).toBe('merged')
  })

  it('un PR mergeado nunca queda como borrador', () => {
    const pr = mergePrState(merged, patch({ event_ts: T('24T10'), draft: true }))
    expect(pr.draft).toBe(false)
  })

  it('una fecha de merge fuerza el estado, aunque el evento llegue fuera de orden', () => {
    const abierto = mergePrState(null, patch({ event_ts: T('25T10'), state: 'open' }))
    const pr = mergePrState(abierto, patch({ event_ts: T('24T10'), merged_at: T('24T10') }))
    expect(pr.state).toBe('merged')
  })
})

describe('mergePrState: valores nulos de GitHub', () => {
  // GitHub calcula `mergeable` de forma asincrona: los webhooks suelen traerlo
  // nulo. Si un nulo borrase el valor bueno, el tablero perderia el motivo de
  // bloqueo cada vez que alguien empuja un commit.
  const conEstado = mergePrState(
    null,
    patch({
      event_ts: T('20T09'),
      state: 'open',
      mergeable: true,
      mergeable_state: 'clean',
      additions: 120,
      changed_files: 4,
    }),
  )

  it('un nulo entrante no borra un valor bueno', () => {
    const pr = mergePrState(
      conEstado,
      patch({
        event_ts: T('20T12'),
        mergeable: null,
        mergeable_state: null,
        additions: null,
      }),
    )
    expect(pr.mergeable).toBe(true)
    expect(pr.mergeable_state).toBe('clean')
    expect(pr.additions).toBe(120)
  })

  it('pero un valor real si lo actualiza', () => {
    const pr = mergePrState(
      conEstado,
      patch({ event_ts: T('20T12'), mergeable_state: 'dirty', additions: 200 }),
    )
    expect(pr.mergeable_state).toBe('dirty')
    expect(pr.additions).toBe(200)
  })

  it('false no se confunde con nulo', () => {
    const pr = mergePrState(conEstado, patch({ event_ts: T('20T12'), mergeable: false }))
    expect(pr.mergeable).toBe(false)
  })
})

describe('mergePrState: secuencia realista y desordenada', () => {
  it('llega al estado correcto con los eventos revueltos', () => {
    // El mismo PR, con los eventos en el peor orden posible.
    const eventos: PrPatch[] = [
      patch({ event_ts: T('22T16'), state: 'merged', merged_at: T('22T16') }),
      patch({ event_ts: T('20T09'), state: 'open', created_at: T('20T09'), author_login: 'ana', draft: true }),
      patch({ event_ts: T('21T11'), first_review_at: T('21T11'), last_review_state: 'changes_requested' }),
      patch({ event_ts: T('20T14'), draft: false, ready_at: T('20T14') }),
      patch({ event_ts: T('22T09'), head_sha: 'final', additions: 80 }),
      patch({ event_ts: T('22T15'), last_review_state: 'approved', approved_at: T('22T15') }),
    ]

    let state: PrSnapshot | null = null
    for (const e of eventos) state = mergePrState(state, e)

    expect(state).toMatchObject({
      state: 'merged',
      draft: false,
      author_login: 'ana',
      created_at: T('20T09'),
      ready_at: T('20T14'),
      first_review_at: T('21T11'),
      approved_at: T('22T15'),
      merged_at: T('22T16'),
      head_sha: 'final',
      additions: 80,
    })
  })

  it('da el mismo resultado en cualquier orden', () => {
    const eventos: PrPatch[] = [
      patch({ event_ts: T('20T09'), state: 'open', created_at: T('20T09'), author_login: 'luis' }),
      patch({ event_ts: T('21T11'), first_review_at: T('21T11') }),
      patch({ event_ts: T('22T16'), state: 'merged', merged_at: T('22T16') }),
    ]

    const enOrden = eventos.reduce<PrSnapshot | null>((s, e) => mergePrState(s, e), null)
    const alReves = [...eventos].reverse().reduce<PrSnapshot | null>(
      (s, e) => mergePrState(s, e),
      null,
    )

    expect(alReves!.state).toBe(enOrden!.state)
    expect(alReves!.created_at).toBe(enOrden!.created_at)
    expect(alReves!.first_review_at).toBe(enOrden!.first_review_at)
    expect(alReves!.merged_at).toBe(enOrden!.merged_at)
  })
})

describe('blockReason', () => {
  const base = {
    draft: false,
    mergeable_state: 'clean' as string | null,
    last_review_state: null as string | null,
    first_review_at: null as string | null,
    requested_reviewers: 0,
  }

  it('borrador primero: no tiene sentido pedir revision de algo sin terminar', () => {
    expect(blockReason({ ...base, draft: true, mergeable_state: 'dirty' })).toBe('draft')
  })

  it('el conflicto va antes que CI', () => {
    // Pedir que arreglen tests de una rama que primero hay que rebasar es ruido.
    expect(
      blockReason({ ...base, mergeable_state: 'dirty', ci_conclusion: 'failure' }),
    ).toBe('conflict')
  })

  it('detecta CI en rojo por conclusion o por mergeable_state', () => {
    expect(blockReason({ ...base, ci_conclusion: 'failure' })).toBe('ci_red')
    expect(blockReason({ ...base, mergeable_state: 'unstable' })).toBe('ci_red')
  })

  it('distingue cambios solicitados de esperando revision', () => {
    expect(blockReason({ ...base, last_review_state: 'changes_requested' })).toBe(
      'changes_requested',
    )
    expect(blockReason(base)).toBe('awaiting_review')
  })

  it('aprobado y limpio es listo para mergear', () => {
    expect(blockReason({ ...base, last_review_state: 'approved' })).toBe('ready_to_merge')
  })

  it('un comentario suelto no cuenta como aprobacion ni como cambios', () => {
    expect(blockReason({ ...base, last_review_state: 'commented' })).toBe('awaiting_review')
  })
})
