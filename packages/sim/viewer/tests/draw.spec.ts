/** Pixel mapping and signal envelopes of the Simulation page. */
import { describe, expect, it } from 'vitest'
import { linePeak, num, pixels, signalEnvelope } from '../src/client/draw.ts'
import { phantomChoices, shownRun, type ComplexArray, type SimSnapshot } from '../src/client/store.ts'
import type { SimPanelState } from '../src/routes.ts'

const array = (values: [number, number][], rows: number, cols: number): ComplexArray => ({ rows, cols, data: new Float32Array(values.flat()) })

describe('pixels', () => {
  const a = array([[0, 0], [3, 4], [0, 2], [-1, 0]], 2, 2)

  it('scales magnitude to the peak', () => {
    expect([...pixels(a, 'magnitude')].filter((_, i) => i % 4 === 0)).toEqual([0, 255, 102, 51])
  })

  it('masks the phase of near-zero pixels and maps -pi..pi to grey', () => {
    const p = [...pixels(a, 'phase')].filter((_, i) => i % 4 === 0)
    expect(p[0]).toBe(0)
    expect(p[2]).toBe(Math.round(255 * 0.75))
    expect(p[3]).toBe(255)
  })

  it('compresses dynamic range on the log scale', () => {
    const log = [...pixels(array([[1000, 0], [1, 0]], 1, 2), 'log')].filter((_, i) => i % 4 === 0)
    expect(log[0]).toBe(255)
    expect(log[1]).toBeGreaterThan(60)
  })
})

describe('signal', () => {
  const s = array([[1, 0], [0, 2], [3, 0], [0, 0], [0, 1], [0, 0]], 2, 3)

  it('decimates to the available width keeping maxima', () => {
    const { columns, peak } = signalEnvelope(s, 2)
    expect(peak).toBe(3)
    expect([...columns]).toEqual([3, 1])
    expect(linePeak(s, 1)).toBe(1)
    expect(num(0.000123)).toBe('1.23e-4')
    expect(num(431.68)).toBe('432')
  })
})

const run = (id: string, rev: number, phantom = 'tubes') => ({ id, rev, phantom, engine: 'mrzero' }) as SimPanelState['runs'][number]

describe('store helpers', () => {
  const state = {
    runs: [run('a', 1), run('b', 2, 'brainweb-axial')], lastFailure: null, jobs: [], revisions: [],
    engines: [{ id: 'mrzero', launcher: 'docker', status: 'stopped', error: null, info: null, phantoms: null }],
    defaults: { engine: 'mrzero', phantom: 'brainweb-axial' },
  } as SimPanelState

  it('follows the latest run unless one is pinned', () => {
    const snap = { state, pinnedRun: null } as SimSnapshot
    expect(shownRun(snap)?.id).toBe('b')
    expect(shownRun({ ...snap, pinnedRun: 'a' })?.id).toBe('a')
  })

  it('offers the default and used phantoms before the engine has listed its own', () => {
    expect(phantomChoices(state, 'mrzero').map(p => p.id)).toEqual(['brainweb-axial', 'tubes'])
    const listed = { ...state, engines: [{ ...state.engines[0]!, phantoms: [{ id: 'x', title: 'X' }, { id: 'broken', title: 'B' }] }] } as SimPanelState
    expect(phantomChoices(listed, 'mrzero')).toEqual([{ id: 'x', title: 'X' }])
  })
})
