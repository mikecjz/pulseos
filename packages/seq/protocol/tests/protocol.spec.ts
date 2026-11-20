/** The TypeScript resolver agrees with the Python resolver on real gre2d models. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  findReferences, formatElementId, formatReference, parseElementId, paramChanges, resolve, resolveBetween, roleDiff,
  type SequenceModel,
} from '../src/index.ts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const python = `${repo}python/.venv/bin/python`

const SCRIPT = `
import json, sys, warnings
warnings.simplefilter("ignore")
from pulseos_seq.recipe import load_recipe, build_sequence, bundled_recipe
from pulseos_seq.scanner import load_profile
from pulseos_seq.resolve import resolve, resolve_between
src, fn = bundled_recipe("gre2d")
base = build_sequence(load_recipe(src, fn), load_profile(), {"Ny": 8})
small = build_sequence(load_recipe(src, fn), load_profile(), {"Ny": 4, "flip_angle": 20.0})
renamed = build_sequence(load_recipe(src.replace('b.block("excitation", rf=rf, gz=gz)', 'b.block("rf_excite", formerly="excitation", rf=rf, gz=gz)'), "recipe.py"), load_profile(), {"Ny": 8})
ids = json.loads(sys.argv[1])
out = {"models": {"base": base, "small": small, "renamed": renamed},
       "resolve": {i: resolve(base, i)["status"] for i in ids},
       "between": {i: resolve_between(base, small, i)["status"] for i in ids},
       "renamed": {i: resolve_between(base, renamed, i)["status"] for i in ids}}
print(json.dumps(out))
`

const IDS = [
  'gre2d:excitation', 'gre2d:excitation.rf', 'gre2d:excitation.rf@slice=0,line=6', 'gre2d:readout.adc@slice=0,line=2',
  'gre2d:readout@slice=0,line=7', 'gre2d:te_fill', 'gre2d:param.TE', 'gre2d:param.flip_angle', 'gre2d:param.nope',
  'gre2d:nonexistent', 'gre2d:readout.rf', 'gre2d:readout@line=0', 'other:readout',
]

describe.skipIf(!existsSync(python))('parity with pulseos_seq.resolve', () => {
  const run = spawnSync(python, ['-c', SCRIPT, JSON.stringify(IDS)], { cwd: `${repo}python`, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (run.status !== 0) throw new Error(run.stderr)
  const out = JSON.parse(run.stdout) as {
    models: Record<'base' | 'small' | 'renamed', SequenceModel>
    resolve: Record<string, string>
    between: Record<string, string>
    renamed: Record<string, string>
  }
  const { base, small, renamed } = out.models

  it.each(IDS)('%s', (id) => {
    expect(resolve(base, id).status).toBe(out.resolve[id])
    expect(resolveBetween(base, small, id).status).toBe(out.between[id])
    expect(resolveBetween(base, renamed, id).status).toBe(out.renamed[id])
  })

  it('follows declared renames and diffs roles', () => {
    const result = resolveBetween(base, renamed, 'gre2d:excitation.rf@slice=0,line=3')
    expect(result).toMatchObject({ status: 'same', id: 'gre2d:rf_excite.rf@slice=0,line=3', renamedFrom: 'gre2d:excitation.rf@slice=0,line=3' })
    expect(roleDiff(base, renamed).renamed).toEqual(['excitation->rf_excite'])
    expect(paramChanges(base, small).map(c => c.name).toSorted()).toEqual(['Ny', 'flip_angle'])
  })
})

describe('element IDs', () => {
  it.each(['gre2d:excitation', 'gre2d:excitation.rf', 'gre2d:readout.adc@slice=0,line=64', 'gre2d:param.TE'])('round-trips %s', (id) => {
    expect(formatElementId(parseElementId(id))).toBe(id)
  })
  it.each(['excitation', 'gre2d:', 'gre2d:a-b', 'gre2d:readout@line=1,line=2', 'gre2d:param', 'gre2d:param.TE@line=1'])('rejects %s', (id) => {
    expect(() => parseElementId(id)).toThrow()
  })
})

describe('reference tokens', () => {
  it('finds tokens with and without revisions and flags malformed IDs', () => {
    const text = 'Shorten [[gre2d:excitation.rf]] and compare [[gre2d:readout.adc@slice=0,line=3|r4]]; ignore [[nope:a-b]].'
    expect(findReferences(text).map(t => [t.id, t.rev, t.valid])).toEqual([
      ['gre2d:excitation.rf', null, true], ['gre2d:readout.adc@slice=0,line=3', 4, true], ['nope:a-b', null, false],
    ])
    expect(formatReference('gre2d:excitation.rf', 5)).toBe('[[gre2d:excitation.rf|r5]]')
  })
})
