import { describe, expect, it } from 'vitest'
import { median } from '@/lib/metrics'

/**
 * La mediana es una decision de diseno, no un detalle: el promedio de "horas
 * entre push" lo desplaza cualquier fin de semana o vacaciones hasta volverlo
 * inutil. Estos tests fijan ese comportamiento.
 */
describe('median', () => {
  it('con numero impar de valores devuelve el central', () => {
    expect(median([5, 1, 3])).toBe(3)
  })

  it('con numero par promedia los dos centrales', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it('resiste un valor extremo, que es el motivo de usarla', () => {
    const conFinDeSemana = [1, 1.5, 2, 2, 72]
    expect(median(conFinDeSemana)).toBe(2)
    // El promedio seria 15.7 h y no describiria ningun dia real.
    const promedio = conFinDeSemana.reduce((a, b) => a + b, 0) / conFinDeSemana.length
    expect(promedio).toBeGreaterThan(15)
  })

  it('ignora nulos, indefinidos y no finitos', () => {
    expect(median([1, null, 3, undefined, Number.NaN, Infinity])).toBe(2)
  })

  it('devuelve null si no queda ningun valor', () => {
    expect(median([])).toBeNull()
    expect(median([null, undefined])).toBeNull()
  })

  it('no altera el array de entrada', () => {
    const input = [3, 1, 2]
    median(input)
    expect(input).toEqual([3, 1, 2])
  })
})
