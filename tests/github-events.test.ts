/**
 * Parsers de los eventos que producen estado: revisiones, PR y despliegues.
 *
 * Se prueban junto con la fusion de estado, porque lo que importa no es el parche
 * suelto sino como queda la fila despues de aplicarlo.
 */

import { describe, expect, it } from 'vitest'
import {
  parseDeploymentStatusEvent,
  parsePullRequestState,
  parseReviewEvent,
} from '@/lib/github-events'
import { mergePrState, type PrPatch, type PrSnapshot } from '@/lib/pr-state'

const repository = { full_name: 'empresa/app' }

function fold(existing: PrSnapshot | null, patches: PrPatch[]): PrSnapshot {
  let row = existing
  for (const p of patches) row = mergePrState(row, p)
  return row!
}

function review(
  over: { reviewer?: string; author?: string; state?: string; submitted?: string } = {},
  pr: Record<string, unknown> = {},
) {
  return {
    action: 'submitted',
    repository,
    review: {
      id: 1,
      user: { login: over.reviewer ?? 'luis' },
      state: over.state ?? 'APPROVED',
      submitted_at: over.submitted ?? '2026-09-21T10:00:00Z',
    },
    pull_request: { number: 10, user: { login: over.author ?? 'ana' }, ...pr },
  }
}

describe('parseReviewEvent', () => {
  it('la revision va antes que el estado del PR', () => {
    const parsed = parseReviewEvent(
      review({}, { state: 'open', updated_at: '2026-09-21T10:00:05Z' }),
    )!
    expect(parsed.pr).toHaveLength(2)
    expect(parsed.pr[0]).toMatchObject({ last_review_state: 'approved' })
    expect(parsed.pr[1]).toMatchObject({ state: 'open' })
  })

  it('un updated_at posterior no se traga el veredicto', () => {
    // Antes habia pedido cambios. El PR del payload lleva una marca unos segundos
    // posterior a la revision: aplicado primero, la aprobacion se perdia.
    const antes = fold(null, [
      {
        repo: 'empresa/app',
        number: 10,
        event_ts: '2026-09-20T09:00:00Z',
        state: 'open',
        last_review_state: 'changes_requested',
      },
    ])
    const despues = fold(
      antes,
      parseReviewEvent(review({}, { state: 'open', updated_at: '2026-09-21T10:00:05Z' }))!.pr,
    )
    expect(despues.last_review_state).toBe('approved')
  })

  it('la revision de un PR desconocido no deja un fantasma abierto', () => {
    const fila = fold(
      null,
      parseReviewEvent(
        review(
          { submitted: '2026-09-21T10:00:00Z' },
          {
            state: 'closed',
            created_at: '2026-09-20T08:00:00Z',
            updated_at: '2026-09-22T12:00:00Z',
            merged_at: '2026-09-22T12:00:00Z',
            closed_at: '2026-09-22T12:00:00Z',
          },
        ),
      )!.pr,
    )
    expect(fila).toMatchObject({
      state: 'merged',
      author_login: 'ana',
      created_at: '2026-09-20T08:00:00.000Z',
      first_review_at: '2026-09-21T10:00:00.000Z',
    })
  })

  it('la revision de un bot no cuenta como primera revision', () => {
    const parsed = parseReviewEvent(review({ reviewer: 'coderabbitai[bot]' }))!
    const fila = fold(null, parsed.pr)
    expect(fila.first_review_at).toBeNull()
    expect(fila.approved_at).toBeNull()
    expect(fila.last_review_state).toBeNull()
    // Pero la revision se guarda: la base la excluye de las metricas, no la borra.
    expect(parsed.review.reviewer_login).toBe('coderabbitai[bot]')
  })

  it('el autor revisando su propio PR tampoco cuenta, aunque cambie mayusculas', () => {
    const fila = fold(null, parseReviewEvent(review({ reviewer: 'Ana', author: 'ana' }))!.pr)
    expect(fila.first_review_at).toBeNull()
  })
})

describe('parsePullRequestState con payloads parciales', () => {
  it('no inventa draft ni revisores si el payload no los trae', () => {
    const patch = parsePullRequestState({
      action: 'submitted',
      repository,
      pull_request: { number: 10, state: 'open', updated_at: '2026-09-21T10:00:00Z' },
    })!
    expect(patch.draft).toBeUndefined()
    expect(patch.requested_reviewers).toBeUndefined()

    // Un borrador con revisores pedidos sigue igual tras un payload parcial.
    const borrador = fold(null, [
      {
        repo: 'empresa/app',
        number: 10,
        event_ts: '2026-09-20T09:00:00Z',
        draft: true,
        requested_reviewers: 2,
      },
    ])
    expect(fold(borrador, [patch])).toMatchObject({ draft: true, requested_reviewers: 2 })
  })

  it('guarda la rama de origen, que delata las reversiones', () => {
    const patch = parsePullRequestState({
      action: 'opened',
      repository,
      pull_request: {
        number: 11,
        state: 'open',
        head: { sha: 'abc', ref: 'revert-10-feature' },
        updated_at: '2026-09-21T10:00:00Z',
      },
    })!
    expect(patch.head_ref).toBe('revert-10-feature')
  })
})

describe('parseDeploymentStatusEvent', () => {
  const evento = (state: string) => ({
    repository,
    deployment: { id: 99, environment: 'Production', sha: 'abc', ref: 'main' },
    deployment_status: { state, created_at: '2026-09-21T10:00:00Z' },
  })

  it('guarda tambien los fallidos, con su estado', () => {
    expect(parseDeploymentStatusEvent(evento('failure'))).toMatchObject({ status: 'failure' })
    expect(parseDeploymentStatusEvent(evento('error'))).toMatchObject({ status: 'error' })
    expect(parseDeploymentStatusEvent(evento('success'))).toMatchObject({ status: 'success' })
  })

  it('ignora los estados intermedios', () => {
    expect(parseDeploymentStatusEvent(evento('pending'))).toBeNull()
    expect(parseDeploymentStatusEvent(evento('in_progress'))).toBeNull()
  })

  it('un reintento con exito sustituye al fallo: misma clave', () => {
    expect(parseDeploymentStatusEvent(evento('failure'))!.dedup_key).toBe(
      parseDeploymentStatusEvent(evento('success'))!.dedup_key,
    )
  })
})
