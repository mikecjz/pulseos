/**
 * `ctx.pulseSim`'s MCP client against the fake engine over real stdio: identity, phantoms,
 * progress, cancellation, error results and an engine that cannot start.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodePart } from '@pulseos/sim-protocol'
import type { Progress } from '@pulseos/sim-protocol'
import { EngineConnection, EngineToolError, EngineUnavailableError } from '../src/engine.ts'
import { launchSpec, type EngineConfig } from '../src/launch.ts'

const fake: EngineConfig = { launcher: 'fake', image: '', gpu: null, command: [], device: 'cpu', env: {}, memory: '1g', fakeDelayMs: 2 }
const SEQ = `[BLOCKS]\n 1 10 1 0 0 1 0 0\n 2 10 0 1 0 0 1 0\n 3 10 0 1 0 0 1 0\n 4 10 0 1 0 0 1 0\n 5 10 0 1 0 0 1 0\n\n[ADC]\n1 8 100 0 0 0\n`
const key = (c: string) => c.repeat(64)

let dir: string
let engine: EngineConnection

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pulseos-sim-engine-'))
  engine = new EngineConnection('fake', () => launchSpec(fake, dir, { uid: 1000, gid: 1000 }), { connectTimeoutMs: 20_000, idleShutdownMs: 0 })
})
afterAll(async () => {
  await engine?.close()
  await rm(dir, { recursive: true, force: true })
})

describe('engine connection over MCP stdio', () => {
  it('starts lazily and lists identity and phantoms', async () => {
    expect(engine.status).toBe('stopped')
    const live = await engine.connect()
    expect(engine.status).toBe('ready')
    expect(live.info).toMatchObject({ protocol: 'pulseos.sim/1', engine: 'fake' })
    expect(live.phantoms.map(p => p.id)).toContain('tubes')
  })

  it('simulates with progress and writes the arrays by key', async () => {
    const progress: Progress[] = []
    const reply = await engine.simulate({ seqText: SEQ, seqHash: 'sha256:a', phantom: 'tubes', resultKey: key('a') },
      { signal: new AbortController().signal, timeoutMs: 20_000, onprogress: p => progress.push(p) })
    expect(reply.grid).toMatchObject({ nx: 8, ny: 4 })
    expect(progress.map(p => p.done)).toEqual([1, 2, 3, 4])
    expect(progress.at(-1)!.total).toBe(4)
    const bytes = await readFile(join(dir, key('a'), reply.parts.image.file))
    expect(decodePart(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), reply.parts.image)).toHaveLength(8 * 4 * 2)
  })

  it('cancels a running call between steps and keeps serving', async () => {
    const slow = new EngineConnection('fake', () => launchSpec({ ...fake, fakeDelayMs: 200 }, dir, { uid: 1000, gid: 1000 }), { connectTimeoutMs: 20_000, idleShutdownMs: 0 })
    try {
      const controller = new AbortController()
      const seen: Progress[] = []
      const call = slow.simulate({ seqText: SEQ, seqHash: 'sha256:b', phantom: 'tubes', resultKey: key('b') },
        { signal: controller.signal, timeoutMs: 20_000, onprogress: (p) => { seen.push(p); controller.abort() } })
      await expect(call).rejects.toThrow()
      expect(seen.length).toBe(1)
      await new Promise(resolve => setTimeout(resolve, 500))
      await expect(readFile(join(dir, key('b'), 'meta.json'))).rejects.toThrow()
      const again = await slow.simulate({ seqText: SEQ, seqHash: 'sha256:c', phantom: 'tubes', resultKey: key('c') },
        { signal: new AbortController().signal, timeoutMs: 20_000, onprogress: () => undefined })
      expect(again.resultKey).toBe(key('c'))
    } finally {
      await slow.close()
    }
  })

  it('turns error results into EngineToolError', async () => {
    const opts = { signal: new AbortController().signal, timeoutMs: 20_000, onprogress: () => undefined }
    await expect(engine.simulate({ seqText: SEQ, seqHash: 'h', phantom: 'broken', resultKey: key('d') }, opts)).rejects.toThrow(EngineToolError)
    await expect(engine.simulate({ seqText: 'no adc', seqHash: 'h', phantom: 'tubes', resultKey: key('e') }, opts)).rejects.toThrow('no [ADC] section')
  })

  it('reports an engine that cannot start as unavailable', async () => {
    const missing = new EngineConnection('x', () => ({ command: join(dir, 'no-such-engine'), args: [], env: {} }), { connectTimeoutMs: 5_000, idleShutdownMs: 0 })
    await expect(missing.connect()).rejects.toThrow(EngineUnavailableError)
    expect(missing.status).toBe('unavailable')
    expect(missing.error).toContain('could not start the x engine')
  })
})
