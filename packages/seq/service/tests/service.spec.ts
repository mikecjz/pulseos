/** Model store addressing and the session-record fold. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { RevisionRecord, SequenceModel } from '@pulseos/seq-protocol'
import { applyRecord, ModelUnavailableError, type SequenceState } from '../src/index.ts'
import { ModelStore, sha256 } from '../src/store.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))) })

const model = { schema: 'pulseos.sequence/1', seq: 'gre2d', duration: 1 } as unknown as SequenceModel

describe('ModelStore', () => {
  it('stores by content address and reads back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulseos-store-'))
    dirs.push(dir)
    const store = new ModelStore(dir, 2)
    const hash = await store.put(model, new Uint8Array([1, 2, 3]))
    expect(hash).toBe(sha256(JSON.stringify(model)))
    expect(await new ModelStore(dir, 2).get(hash)).toEqual(model)
    await expect(store.get(sha256('other'))).rejects.toBeInstanceOf(ModelUnavailableError)
    await expect(store.get('not-a-hash')).rejects.toBeInstanceOf(ModelUnavailableError)
  })

  it('rejects a stored model whose content does not match its address', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulseos-store-'))
    dirs.push(dir)
    const hash = await new ModelStore(dir, 2).put(model, null)
    await writeFile(join(dir, 'models', `${hash.slice(7)}.json`), '{"tampered":true}')
    await expect(new ModelStore(dir, 2).get(hash)).rejects.toThrow('does not match')
  })
})

const record = (type: string, data: unknown, seq: number) => ({ type, data, seq, time: 0, ignorable: true }) as unknown as SessionEvent

describe('applyRecord', () => {
  const empty: SequenceState = { recipes: {}, revisions: [], lastFailure: null }

  it('folds recipe, revision and failure records and ignores other events', () => {
    let state = applyRecord(empty, record('plugin:pulseos/recipe', { recipeHash: 'h1', source: 'x' }, 1))
    state = applyRecord(state, record('plugin:pulseos/revision', { rev: 1 } as RevisionRecord, 2))
    state = applyRecord(state, record('plugin:pulseos/build-failed', { cause: 'c', error: { kind: 'build', message: 'm', line: 3 } }, 3))
    expect(Object.keys(state.recipes)).toEqual(['h1'])
    expect(state.revisions.map(r => r.rev)).toEqual([1])
    expect(state.lastFailure).toMatchObject({ afterRev: 1, error: { line: 3 } })
    const unrelated = { type: 'turn/start', data: {}, seq: 4, time: 0 } as unknown as SessionEvent
    expect(applyRecord(state, unrelated)).toBe(state)
    expect(applyRecord(state, { ...record('plugin:other/x', {}, 5) })).toBe(state)
  })
})
