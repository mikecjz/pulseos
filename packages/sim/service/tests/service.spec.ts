/** Launch commands, settings canonicalisation and the session-record fold. */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SimSettings } from '@pulseos/sim-protocol'
import { applySimRecord, canonicalSettings, type SimulationState } from '../src/index.ts'
import { launchSpec, type EngineConfig } from '../src/launch.ts'

const engine: EngineConfig = { launcher: 'docker', image: 'pulseos/mrzero-mcp:dev', gpu: 2, command: ['mrzero-mcp', 'serve'], device: 'cuda:1', env: { MRZERO_PHANTOMS: '/p' }, memory: '8g', fakeDelayMs: 0 }

describe('launchSpec', () => {
  it('runs Docker hardened: no network, read-only root, non-root, no capabilities, one writable mount', () => {
    const spec = launchSpec(engine, '/data/sim', { uid: 1234, gid: 99 })
    expect(spec.command).toBe('docker')
    const args = spec.args.join(' ')
    for (const flag of ['run -i --rm', '--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 1234:99', '--volume /data/sim:/data:rw', '--gpus device=2', '--memory 8g']) {
      expect(args).toContain(flag)
    }
    expect(spec.args.filter(a => a === '--volume')).toHaveLength(1)
    expect(spec.args.at(-1)).toBe('pulseos/mrzero-mcp:dev')
  })

  it('never runs the container as root and runs on the CPU without a GPU', () => {
    const spec = launchSpec({ ...engine, gpu: null }, '/d', { uid: 0, gid: 0 })
    expect(spec.args.join(' ')).toContain('--user 10001:10001')
    expect(spec.args).not.toContain('--gpus')
    expect(spec.args).toContain('MRZERO_DEVICE=cpu')
  })

  it('runs the local launcher with the result directory and device', () => {
    const spec = launchSpec({ ...engine, launcher: 'local' }, '/d', { uid: 1, gid: 1 })
    expect([spec.command, ...spec.args]).toEqual(['mrzero-mcp', 'serve', '--out', '/d', '--device', 'cuda:1'])
    expect(spec.env.MRZERO_PHANTOMS).toBe('/p')
  })
})

describe('simulation state', () => {
  const record = (type: string, data: unknown) => ({ type, data, seq: 1, time: 0, ignorable: true }) as unknown as SessionEvent

  it('folds runs and failures and ignores other events', () => {
    const empty: SimulationState = { runs: [], lastFailure: null }
    let state = applySimRecord(empty, record('plugin:pulseos/sim-run', { id: 'a', rev: 1 }))
    state = applySimRecord(state, record('plugin:pulseos/sim-failed', { id: 'b', rev: 2, error: { kind: 'input', message: 'm' } }))
    expect(state.runs.map(r => r.id)).toEqual(['a'])
    expect(state.lastFailure).toMatchObject({ id: 'b', afterRuns: 1 })
    expect(applySimRecord(state, record('plugin:pulseos/revision', {}))).toBe(state)
  })

  it('canonicalises settings so equal settings hash equally', () => {
    expect(JSON.stringify(canonicalSettings({ noise: 0.1, b0: true, resolution: undefined } as unknown as SimSettings))).toBe('{"b0":true,"noise":0.1}')
  })
})
