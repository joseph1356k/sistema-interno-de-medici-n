/**
 * Tests de las proyecciones. La mitad comprueban que se NIEGAN a proyectar: es la
 * parte que evita que el panel muestre una linea inventada como si fuera
 * informacion.
 */

import { describe, expect, it } from 'vitest'
import {
  MIN_R2,
  MIN_WEEKS,
  forecastCompletion,
  forecastThroughput,
  linearTrend,
  projectMonthlyCost,
  quantile,
  seededRandom,
} from '@/lib/forecast'

const rng = () => seededRandom(42)

describe('se niega a proyectar sin base suficiente', () => {
  it('throughput con menos de MIN_WEEKS semanas', () => {
    const pocas = Array.from({ length: MIN_WEEKS - 1 }, () => 3)
    expect(forecastThroughput(pocas, 4, { rng: rng() })).toBeNull()
    // Con una semana mas, si proyecta.
    expect(forecastThroughput([...pocas, 3], 4, { rng: rng() })).not.toBeNull()
  })

  it('finalizacion con menos de MIN_WEEKS semanas', () => {
    expect(forecastCompletion([1, 2, 3], 10, { rng: rng() })).toBeNull()
  })

  it('finalizacion cuando el historico es todo ceros', () => {
    // Sin throughput no hay fecha. Devolver un numero enorme seria peor que nada.
    expect(forecastCompletion(new Array(12).fill(0), 10, { rng: rng() })).toBeNull()
  })

  it('tendencia con menos de MIN_WEEKS puntos', () => {
    expect(linearTrend([5, 4, 3])).toBeNull()
  })

  it('coste antes del dia 3 del mes', () => {
    // Proyectar el mes desde el dia 1 multiplica por 30 cualquier anomalia.
    const costes = [{ day: '2026-09-01', cost: 40 }]
    expect(projectMonthlyCost(costes, new Date('2026-09-02T12:00:00Z'))).toBeNull()
    expect(projectMonthlyCost(costes, new Date('2026-09-03T12:00:00Z'))).not.toBeNull()
  })

  it('throughput con horizonte invalido', () => {
    expect(forecastThroughput(new Array(12).fill(4), 0, { rng: rng() })).toBeNull()
  })

  it('finalizacion con objetivo invalido', () => {
    expect(forecastCompletion(new Array(12).fill(4), 0, { rng: rng() })).toBeNull()
  })
})

describe('forecastThroughput', () => {
  it('es determinista con la misma semilla', () => {
    const semanas = [1, 9, 2, 7, 0, 5, 4, 3, 6, 2, 8, 1]
    const a = forecastThroughput(semanas, 4, { rng: rng(), trials: 2000 })
    const b = forecastThroughput(semanas, 4, { rng: rng(), trials: 2000 })
    expect(a).toEqual(b)
  })

  it('la confianza alta promete menos que la baja', () => {
    // Es la direccion que se equivoca facil: prometer mas con mas confianza seria
    // exactamente al reves de lo que significa.
    const f = forecastThroughput([1, 9, 2, 7, 0, 5, 4, 3, 6, 2, 8, 1], 4, {
      rng: rng(),
      trials: 5000,
    })!
    expect(f.atLeast.p95).toBeLessThanOrEqual(f.atLeast.p85)
    expect(f.atLeast.p85).toBeLessThanOrEqual(f.atLeast.p50)
  })

  it('con un historico constante todas las simulaciones coinciden', () => {
    const f = forecastThroughput(new Array(12).fill(5), 4, { rng: rng(), trials: 1000 })!
    expect(f.atLeast.p50).toBe(20)
    expect(f.atLeast.p95).toBe(20)
    expect(f.mean).toBeCloseTo(20, 5)
  })

  it('la media cae cerca de la media historica por semana', () => {
    const semanas = [2, 4, 6, 4, 2, 6, 4, 4, 2, 6, 4, 4]
    const mediaSemanal = semanas.reduce((s, n) => s + n, 0) / semanas.length
    const f = forecastThroughput(semanas, 4, { rng: rng(), trials: 8000 })!
    expect(f.mean).toBeGreaterThan(mediaSemanal * 4 * 0.9)
    expect(f.mean).toBeLessThan(mediaSemanal * 4 * 1.1)
  })

  it('usa solo las ultimas SAMPLE_WEEKS semanas', () => {
    // 20 semanas viejas a cero y 12 recientes a 5: la prevision debe reflejar el
    // presente, no arrastrar un historico antiguo.
    const f = forecastThroughput(
      [...new Array(20).fill(0), ...new Array(12).fill(5)],
      4,
      { rng: rng(), trials: 1000 },
    )!
    expect(f.basedOnWeeks).toBe(12)
    expect(f.atLeast.p50).toBe(20)
  })

  it('ignora valores no finitos y negativos', () => {
    const f = forecastThroughput(
      [5, 5, 5, 5, 5, 5, 5, Number.NaN, -3, 5, 5, 5],
      2,
      { rng: rng(), trials: 500 },
    )!
    expect(f.atLeast.p50).toBe(10)
  })
})

describe('forecastCompletion', () => {
  it('la confianza alta da MAS semanas, al contrario que atLeast', () => {
    const f = forecastCompletion([1, 9, 2, 7, 0, 5, 4, 3, 6, 2, 8, 1], 20, {
      rng: rng(),
      trials: 5000,
    })!
    expect(f.withinWeeks.p95).toBeGreaterThanOrEqual(f.withinWeeks.p85)
    expect(f.withinWeeks.p85).toBeGreaterThanOrEqual(f.withinWeeks.p50)
  })

  it('con throughput constante da el resultado aritmetico', () => {
    // 5 por semana, 20 items -> 4 semanas exactas.
    const f = forecastCompletion(new Array(12).fill(5), 20, { rng: rng(), trials: 1000 })!
    expect(f.withinWeeks.p50).toBe(4)
    expect(f.withinWeeks.p95).toBe(4)
  })

  it('tolera semanas a cero mientras alguna produzca', () => {
    const f = forecastCompletion([0, 0, 5, 0, 5, 0, 5, 0, 5, 0, 5, 0], 10, {
      rng: rng(),
      trials: 2000,
    })
    expect(f).not.toBeNull()
    expect(f!.withinWeeks.p50).toBeGreaterThan(2)
  })

  it('respeta el tope de semanas y no se cuelga', () => {
    const f = forecastCompletion([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 1000, {
      rng: rng(),
      trials: 200,
      maxWeeks: 50,
    })!
    expect(f.withinWeeks.p95).toBeLessThanOrEqual(50)
  })
})

describe('projectMonthlyCost', () => {
  const costes = [
    { day: '2026-07-15', cost: 100 },
    { day: '2026-08-10', cost: 200 },
    { day: '2026-09-01', cost: 10 },
    { day: '2026-09-02', cost: 10 },
    { day: '2026-09-03', cost: 10 },
    { day: '2026-09-04', cost: 10 },
    { day: '2026-09-05', cost: 10 },
  ]

  it('proyecta por ritmo de gasto', () => {
    // 50 USD en 5 dias -> 10/dia -> 300 en septiembre (30 dias).
    const p = projectMonthlyCost(costes, new Date('2026-09-05T12:00:00Z'))!
    expect(p.monthToDate).toBe(50)
    expect(p.daysElapsed).toBe(5)
    expect(p.daysInMonth).toBe(30)
    expect(p.projectedMonthEnd).toBeCloseTo(300, 5)
  })

  it('da los meses anteriores como contexto', () => {
    const p = projectMonthlyCost(costes, new Date('2026-09-05T12:00:00Z'))!
    expect(p.previousMonths).toEqual([
      { month: '2026-08', cost: 200 },
      { month: '2026-07', cost: 100 },
    ])
  })

  it('cuenta bien los dias de febrero', () => {
    const p = projectMonthlyCost(
      [{ day: '2026-02-01', cost: 28 }],
      new Date('2026-02-04T12:00:00Z'),
    )!
    expect(p.daysInMonth).toBe(28)
  })
})

describe('linearTrend', () => {
  it('detecta mejora cuando bajar es mejor', () => {
    const t = linearTrend([50, 45, 40, 35, 30, 25, 20], { lowerIsBetter: true })!
    expect(t.direction).toBe('improving')
    expect(t.slopePerWeek).toBeLessThan(0)
    expect(t.r2).toBeGreaterThan(0.99)
  })

  it('la misma serie es empeoramiento si subir es mejor', () => {
    // Sin el parametro, la palabra "mejorando" no significa nada.
    const t = linearTrend([50, 45, 40, 35, 30, 25, 20], { lowerIsBetter: false })!
    expect(t.direction).toBe('worsening')
  })

  it('dice "sin tendencia clara" cuando el ajuste es malo', () => {
    // Serie ruidosa sin direccion: afirmar una mejora seria inventarse la
    // conclusion. Es la razon de ser de MIN_R2.
    const t = linearTrend([10, 80, 15, 70, 20, 90, 12, 65], { lowerIsBetter: true })!
    expect(t.r2).toBeLessThan(MIN_R2)
    expect(t.direction).toBe('unclear')
  })

  it('una serie plana no tiene direccion', () => {
    const t = linearTrend(new Array(8).fill(30))!
    expect(t.slopePerWeek).toBe(0)
    expect(t.direction).toBe('unclear')
  })

  it('la pendiente esta en unidades por semana', () => {
    const t = linearTrend([10, 20, 30, 40, 50, 60], { lowerIsBetter: false })!
    expect(t.slopePerWeek).toBeCloseTo(10, 5)
  })
})

describe('quantile', () => {
  it('interpola entre valores', () => {
    expect(quantile([0, 10], 0.5)).toBe(5)
  })

  it('devuelve los extremos en 0 y 1', () => {
    const s = [1, 2, 3, 4, 5]
    expect(quantile(s, 0)).toBe(1)
    expect(quantile(s, 1)).toBe(5)
  })

  it('tolera listas vacias y de un elemento', () => {
    expect(Number.isNaN(quantile([], 0.5))).toBe(true)
    expect(quantile([7], 0.9)).toBe(7)
  })

  it('acota probabilidades fuera de rango', () => {
    expect(quantile([1, 2, 3], -1)).toBe(1)
    expect(quantile([1, 2, 3], 5)).toBe(3)
  })
})

describe('seededRandom', () => {
  it('da la misma secuencia con la misma semilla', () => {
    const a = seededRandom(7)
    const b = seededRandom(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('devuelve valores en [0, 1)', () => {
    const r = seededRandom(123)
    for (let i = 0; i < 1000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
