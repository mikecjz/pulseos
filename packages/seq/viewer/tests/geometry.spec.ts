/** Viewer geometry and selection matching on a real gre2d model. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SequenceModel } from '@pulseos/seq-protocol'
import { clampView, formatDuration, formatTime, interpolate, SequenceIndex, ticks, waveform } from '../src/client/geometry.ts'
import { changedIds, matchesSelection } from '../src/client/store.ts'
import { hitTest, layoutRows } from '../src/client/draw.ts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const python = `${repo}python/.venv/bin/python`
const SCRIPT = `
import json, warnings
warnings.simplefilter("ignore")
from pulseos_seq.recipe import load_recipe, build_sequence, bundled_recipe
from pulseos_seq.scanner import load_profile
src, fn = bundled_recipe("gre2d")
a = build_sequence(load_recipe(src, fn), load_profile(), {"Ny": 8})
b = build_sequence(load_recipe(src, fn), load_profile(), {"Ny": 8, "flip_angle": 30.0})
print(json.dumps([a, b]))
`

describe('pure helpers', () => {
  it('formats times and ticks', () => {
    expect(formatTime(0.0042, 1e-3)).toBe('4.2 ms')
    expect(formatTime(0.00021, 1e-5)).toBe('210 us')
    expect(formatDuration(1e-3)).toBe('1.00 ms')
    expect(ticks({ t0: 0, t1: 0.01 }, 5).values).toEqual([0, 0.002, 0.004, 0.006, 0.008, 0.01])
    expect(interpolate([0, 1, 2], [0, 10, 0], 0.5)).toBe(5)
    expect(interpolate([0, 1], [1, 1], 2)).toBe(0)
    expect(clampView({ t0: -1, t1: 0.5 }, 1)).toEqual({ t0: 0, t1: 1 })
    const clamped = clampView({ t0: 0.9, t1: 1.4 }, 1)
    expect(clamped.t0).toBeCloseTo(0.5, 12)
    expect(clamped.t1).toBeCloseTo(1, 12)
  })

  it('matches role-level selections against instances', () => {
    expect(matchesSelection('gre2d:excitation.rf', 'gre2d:excitation.rf@slice=0,line=3')).toBe(true)
    expect(matchesSelection('gre2d:excitation', 'gre2d:excitation.gz@slice=0,line=3')).toBe(true)
    expect(matchesSelection('gre2d:excitation.rf', 'gre2d:excitation.gz@slice=0,line=3')).toBe(false)
    expect(matchesSelection('gre2d:excitation.rf@slice=0,line=3', 'gre2d:excitation.rf@slice=0,line=4')).toBe(false)
    expect(matchesSelection('gre2d:excitation@slice=0,line=3', 'gre2d:excitation.rf@slice=0,line=3')).toBe(true)
    expect(matchesSelection('bad id', 'gre2d:excitation')).toBe(false)
  })

  it('lays out rows to fill the height', () => {
    const rows = layoutRows(600, false, [])
    expect(rows.map(r => r.key)).toEqual(['ruler', 'blocks', 'rf', 'rfPhase', 'gz', 'gy', 'gx', 'adc'])
    expect(Math.round(rows.at(-1)!.y + rows.at(-1)!.h)).toBe(600)
    expect(layoutRows(600, true, ['gy', 'rf']).map(r => r.key)).toEqual(['ruler', 'blocks', 'gz', 'gx', 'adc'])
  })
})

const at = (t: number) => (t / 0.02) * 1000

describe.skipIf(!existsSync(python))('on a gre2d model', () => {
  const run = spawnSync(python, ['-c', SCRIPT], { cwd: `${repo}python`, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (run.status !== 0) throw new Error(run.stderr)
  const [a, b] = JSON.parse(run.stdout) as [SequenceModel, SequenceModel]
  const index = new SequenceIndex(a)

  it('indexes events, repetitions and scales', () => {
    expect(index.repetitions).toHaveLength(8)
    expect(index.repetitions[1]!.start).toBeCloseTo(0.01, 9)
    expect(index.eventsIn('rf', 0, 0.0099).map(e => e.id)).toEqual(['gre2d:excitation.rf@slice=0,line=0'])
    expect(index.eventsIn('adc', 0.0101, 0.02)).toHaveLength(1)
    expect(index.gradMax).toBeGreaterThan(0)
    expect(index.rfMax).toBeCloseTo(a.events.find(e => e.kind === 'rf')!.peak as number, 6)
    expect(index.repetitionAt(0.035)).toBe(3)
  })

  it('samples waveforms and values at a time', () => {
    const rf = index.byChannel.rf[0]!
    const points = waveform(rf, a)!
    // RF samples sit at raster-centre times, half a raster after the pulse start.
    expect(points.t[0]! - rf.t0).toBeCloseTo(0.5e-6, 9)
    expect(index.valueAt('rf', rf.t0 + rf.duration / 2)).toBeCloseTo(rf.kind === 'rf' ? rf.peak : 0, 3)
    const adc = index.byChannel.adc[0]!
    expect(index.valueAt('adc', adc.t0 + adc.duration / 2)).toBe(1)
    expect(waveform(adc, a)).toBeNull()
  })

  it('hit-tests the RF row and the block lane', () => {
    const rows = layoutRows(600, false, [])
    const view = { t0: 0, t1: 0.02 }
    const rfRow = rows.find(r => r.key === 'rf')!
    const lane = rows.find(r => r.key === 'blocks')!
    expect(hitTest({ index, model: a, view, width: 1000, rows }, at(0.0007), rfRow.y + 20, false)?.id).toBe('gre2d:excitation.rf')
    expect(hitTest({ index, model: a, view, width: 1000, rows }, at(0.0007), rfRow.y + 20, true)?.id).toBe('gre2d:excitation.rf@slice=0,line=0')
    expect(hitTest({ index, model: a, view, width: 1000, rows }, at(0.005), lane.y + 5, false)?.id).toBe('gre2d:readout')
  })

  it('flashes only the events that changed', () => {
    expect([...changedIds(a, b)].toSorted()).toEqual(['gre2d:excitation.rf'])
    expect(changedIds(a, a).size).toBe(0)
  })
})
