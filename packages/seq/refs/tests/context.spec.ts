/** Reference context against real gre2d models from the Python backend. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RevisionRecord, SequenceModel } from '@pulseos/seq-protocol'
import { referenceContext, type ReferenceSource } from '../src/context.ts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const python = `${repo}python/.venv/bin/python`
const SCRIPT = `
import json, warnings
warnings.simplefilter("ignore")
from pulseos_seq.recipe import load_recipe, build_sequence, bundled_recipe
from pulseos_seq.scanner import load_profile
src, fn = bundled_recipe("gre2d")
r1 = build_sequence(load_recipe(src, fn), load_profile(), {"Ny": 8})
r2 = build_sequence(load_recipe(src, fn), load_profile(), {"Ny": 4, "flip_angle": 30.0})
print(json.dumps({"r1": r1, "r2": r2, "source": src}))
`
const limits = { maxReferences: 3, maxCharsPerReference: 2000 }
const rev = (n: number) => ({ rev: n, modelHash: `m${n}` }) as RevisionRecord

describe.skipIf(!existsSync(python))('referenceContext', () => {
  const run = spawnSync(python, ['-c', SCRIPT], { cwd: `${repo}python`, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (run.status !== 0) throw new Error(run.stderr)
  const { r1, r2, source } = JSON.parse(run.stdout) as { r1: SequenceModel; r2: SequenceModel; source: string }
  const models: Record<string, SequenceModel> = { m1: r1, m2: r2 }
  const built: ReferenceSource = {
    latest: rev(2),
    revision: n => (n === 1 || n === 2 ? rev(n) : undefined),
    model: async r => models[r.modelHash]!,
    recipe: async () => source,
  }

  it('returns nothing for text without references', async () => {
    expect(await referenceContext('Shorten TE please', built, limits)).toBeUndefined()
  })

  it('describes the latest revision and compares pinned revisions with it', async () => {
    const context = (await referenceContext('Why does [[gre2d:excitation.rf]] differ from [[gre2d:excitation.rf|r1]]?', built, limits))!
    expect(context.outcomes).toEqual([
      { id: 'gre2d:excitation.rf', rev: null, status: 'resolved', resolvedRev: 2 },
      { id: 'gre2d:excitation.rf', rev: 1, status: 'changed', resolvedRev: 1 },
    ])
    expect(context.text).toContain('[[gre2d:excitation.rf]] — at r2 (latest):')
    expect(context.text).toContain('flip angle 30 deg')
    expect(context.text).toContain('[[gre2d:excitation.rf|r1]] — at r1:')
    expect(context.text).toContain('At the latest revision r2 it is changed.')
    expect(context.text).toContain('b.block("excitation", rf=rf, gz=gz)')
  })

  it('reports instances removed since the referenced revision, unknown elements and bad IDs', async () => {
    const context = (await referenceContext('[[gre2d:readout.adc@slice=0,line=6|r1]] [[gre2d:nope]] [[gre2d:a-b]] [[gre2d:param.TE|r9]]', built, { ...limits, maxReferences: 8 }))!
    expect(context.outcomes.map(o => o.status)).toEqual(['gone', 'gone', 'unresolved', 'unresolved'])
    expect(context.text).toContain('At the latest revision r2 this element no longer exists')
    expect(context.text).toContain('[[gre2d:nope]] — at r2: gre2d:nope does not exist (no role "nope").')
    expect(context.text).toContain('there is no revision r9')
  })

  it('deduplicates tokens and caps the number expanded', async () => {
    const context = (await referenceContext('[[gre2d:te_fill]] [[gre2d:te_fill]] [[gre2d:spoil]] [[gre2d:readout]] [[gre2d:prephase]]', built, limits))!
    expect(context.outcomes.map(o => o.id)).toEqual(['gre2d:te_fill', 'gre2d:spoil', 'gre2d:readout'])
    expect(context.text).toContain('1 more reference(s) were not expanded')
  })

  it('explains that nothing is built yet', async () => {
    const context = (await referenceContext('[[gre2d:excitation]]', { ...built, latest: undefined }, limits))!
    expect(context.outcomes[0]!.status).toBe('unresolved')
    expect(context.text).toContain('no sequence has been built in this session yet')
  })
})
