/** Viewer navigation targets resolved on real gre2d models. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findNavigation, kspaceRepetitions, type SequenceModel } from '../src/index.ts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const python = `${repo}python/.venv/bin/python`

const SCRIPT = `
import contextlib, io, json, warnings
warnings.simplefilter("ignore")
from pulseos_seq.recipe import load_recipe, build_sequence, bundled_recipe
from pulseos_seq.scanner import load_profile
src, fn = bundled_recipe("gre2d")
with contextlib.redirect_stdout(io.StringIO()):  # the pypulseq example prints its timing check
    epi = build_sequence(load_recipe(*bundled_recipe("pypulseq_epi")), load_profile())
print(json.dumps({
  "single": build_sequence(load_recipe(src, fn), load_profile(), {"Ny": 8}),
  "multi": build_sequence(load_recipe(src, fn), load_profile(), {"Ny": 4, "n_slices": 2}),
  "epi": epi,
}))
`

describe.skipIf(!existsSync(python))('navigation on gre2d', () => {
  const run = spawnSync(python, ['-c', SCRIPT], { cwd: `${repo}python`, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (run.status !== 0) throw new Error(run.stderr)
  const { single, multi, epi } = JSON.parse(run.stdout) as Record<'single' | 'multi' | 'epi', SequenceModel>

  it('numbers phase-encode lines from the k-space centre', () => {
    const reps = kspaceRepetitions(single)
    expect(reps.map(r => [r.loop.line, r.ky, r.kz])).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(line => [line, line - 4, 0]))
    expect(reps.every(r => r.adcRole === 'readout')).toBe(true)
  })

  it('goes to the ky = 0 block: the readout of the centre line, framed by its TR', () => {
    const result = findNavigation(single, { ky: 0 })
    expect(result).toMatchObject({ ok: true, select: 'gre2d:readout@slice=0,line=4', label: 'ky = 0 (slice=0,line=4)', matches: 1 })
    const rep = kspaceRepetitions(single)[4]!
    if (!result.ok) throw new Error(result.reason)
    expect(result.view.t0).toBeLessThan(rep.start)
    expect(result.view.t1).toBeGreaterThan(rep.end)
    expect(result.view.t1 - result.view.t0).toBeLessThan((rep.end - rep.start) * 1.2)
  })

  it('selects by loop index, other roles and block framing', () => {
    expect(findNavigation(single, { loop: { line: 0 } })).toMatchObject({ ok: true, select: 'gre2d:readout@slice=0,line=0', label: 'ky = -4 (slice=0,line=0)' })
    const block = findNavigation(single, { ky: -1, role: 'prephase', frame: 'block' })
    expect(block).toMatchObject({ ok: true, select: 'gre2d:prephase@slice=0,line=3' })
    const prephase = single.blocks.find(b => b.id === 'gre2d:prephase@slice=0,line=3')!
    if (!block.ok) throw new Error(block.reason)
    expect(block.view.t0).toBeLessThan(prephase.t0)
    expect(block.view.t1).toBeGreaterThan(prephase.t0 + prephase.duration)
  })

  it('picks the first slice when several match and narrows by loop', () => {
    expect(findNavigation(multi, { ky: 0 })).toMatchObject({ ok: true, select: 'gre2d:readout@slice=0,line=2', matches: 2 })
    expect(findNavigation(multi, { ky: 0, loop: { slice: 1 } })).toMatchObject({ ok: true, select: 'gre2d:readout@slice=1,line=2', matches: 1 })
  })

  it('goes to element IDs, framing their repetition', () => {
    expect(findNavigation(single, { element: 'gre2d:excitation.rf@slice=0,line=2' })).toMatchObject({ ok: true, select: 'gre2d:excitation.rf@slice=0,line=2' })
    expect(findNavigation(single, { element: 'gre2d:param.TE' })).toMatchObject({ ok: true, select: 'gre2d:param.TE' })
  })

  it('explains places that do not exist', () => {
    expect(findNavigation(single, { ky: 40 })).toEqual({ ok: false, reason: 'no repetition matches; ky lines are -4..3' })
    expect(findNavigation(single, { loop: { ky: 0 } })).toEqual({ ok: false, reason: 'there is no loop "ky"; loops are slice, line' })
    expect(findNavigation(single, { loop: { line: 8 } })).toEqual({ ok: false, reason: 'loop line runs 0..7, not 8' })
    expect(findNavigation(single, { element: 'gre2d:nope' })).toMatchObject({ ok: false, reason: 'gre2d:nope does not exist: no role "nope"' })
    expect(findNavigation(single, {})).toEqual({ ok: false, reason: 'give element, loop, ky or kz' })
  })

  it('keeps an echo train in one repetition: the inner loop n does not start a new one', () => {
    const reps = kspaceRepetitions(epi)
    expect(reps.map(r => r.loop)).toEqual([{ rep: 0 }, { rep: 1 }, { rep: 2 }])
    expect(reps.every(r => r.adcRole === 'readout')).toBe(true)
    const result = findNavigation(epi, { element: 'epi:readout.adc@rep=1,n=10' })
    if (!result.ok) throw new Error(result.reason)
    expect(result.view.t0).toBeLessThan(reps[1]!.start)
    expect(result.view.t1).toBeGreaterThan(reps[1]!.end)
    expect(findNavigation(epi, { loop: { rep: 2 } })).toMatchObject({ ok: true, select: 'epi:readout@rep=2,n=0' })
  })
})
