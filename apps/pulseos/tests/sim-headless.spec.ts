/**
 * REAL composition for the simulator: `dsh headless` with the PulseOS overlay and the fake engine
 * (a real MCP server over stdio), driven by a scripted model. The model builds, simulates, changes
 * the flip angle, simulates again and summarizes the contrast in one turn; the tool results it saw
 * are snapshotted keyless.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startScriptedLlm, toolResults, type ScriptedLlm, type ScriptStep } from './scripted-llm.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const landlockAbi = Number(spawnSync(join(repo, 'python/.venv/bin/python'), ['-c', 'from pulseos_seq.confine import abi_version; print(abi_version())'], { encoding: 'utf8' }).stdout.trim() || 0)

const SCRIPT: ScriptStep[] = [
  { tool: 'sim_run', input: { cause: 'too early' } },
  { tool: 'seq_build', input: { cause: 'initial 2D GRE build' } },
  { tool: 'sim_summary', input: {} },
  { tool: 'sim_run', input: { phantom: 'tubes', cause: 'baseline contrast' } },
  { tool: 'seq_set_params', input: { params: [{ name: 'flip_angle', value: 30 }], cause: 'flip 15 -> 30 deg' } },
  { tool: 'sim_run', input: { phantom: 'tubes', cause: 'contrast at flip 30' } },
  { tool: 'sim_run', input: { rev: 1, phantom: 'tubes', cause: 'baseline again (cached)' } },
  { tool: 'sim_run', input: { phantom: 'nope', cause: 'unknown phantom' } },
  { tool: 'sim_summary', input: { rev: 2 } },
  { text: 'At flip 30 [[sim:r2/tubes]] the vials are brighter than at flip 15 [[sim:r1/tubes]].' },
]

function normalize(text: string): string {
  return text.replace(/sha256:[0-9a-f]{64}/g, 'sha256:<hash>')
}

describe('dsh headless: build, simulate and explain the contrast in one turn', () => {
  let llm: ScriptedLlm
  let scratch: string
  let exitCode: number | null
  let output = ''

  beforeAll(async () => {
    llm = await startScriptedLlm(SCRIPT, 'sim_')
    scratch = await mkdtemp(join(tmpdir(), 'pulseos-sim-headless-'))
    const overlay = join(scratch, 'test.patch.yml')
    await writeFile(overlay, `- id: pulseos-seq-service\n  config:\n    dataDir: ${JSON.stringify(join(scratch, 'data'))}\n    confine: ${landlockAbi >= 4}\n`
      + `- id: pulseos-sim-service\n  config:\n    dataDir: ${JSON.stringify(join(scratch, 'data'))}\n    defaultEngine: fake\n    defaultPhantom: tubes\n    engines:\n      fake:\n        launcher: fake\n        fakeDelayMs: 1\n`)
    const child = spawn(process.execPath, [join(repo, 'scripts/dsh.mjs'), 'headless', '--patch', overlay, 'Build the GRE, simulate it and explain the contrast'], {
      env: { ...process.env, DSH_HOME: join(scratch, 'home'), DEEPSEEK_BASE_URL: llm.url, DEEPSEEK_API_KEY: 'mock-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    exitCode = await new Promise<number | null>(resolve => child.on('exit', resolve))
  }, 240_000)

  afterAll(async () => {
    await llm?.close()
    if (scratch) await rm(scratch, { recursive: true, force: true })
  })

  it('runs the scripted conversation to completion', () => {
    expect(exitCode, output).toBe(0)
    expect(output).toContain('[[sim:r2/tubes]]')
  })

  it('gives the model the expected tool results', async () => {
    const results = toolResults(llm.requests.at(-1)!)
    expect(results.map(r => [r.tool, r.isError])).toEqual([
      ['sim_run', true], ['seq_build', false], ['sim_summary', true], ['sim_run', false], ['seq_set_params', false],
      ['sim_run', false], ['sim_run', false], ['sim_run', true], ['sim_summary', false],
    ])
    expect(results[0]!.text).toContain('no sequence has been built in this session yet')
    expect(results[3]!.text).toContain('Simulation [[sim:r1/tubes]]: r1 (gre2d) on phantom tubes with fake 1')
    expect(results[3]!.text).toContain('Sequence at r1: TE 4.2 ms, TR 10 ms, flip_angle 15 deg')
    expect(results[5]!.text).toContain('Compared with r1 on the same phantom:')
    expect(results[6]!.text).toContain('from cache')
    expect(results[7]!.text).toContain('has no phantom "nope"')
    await expect(results.map(r => `## ${r.tool}${r.isError ? ' (error)' : ''}\n${normalize(r.text)}`).join('\n\n'))
      .toMatchFileSnapshot('./__snapshots__/headless-sim-tool-results.md')
  })

  it('stores each distinct result once, by content key', async () => {
    const entries = (await readdir(join(scratch, 'data/sim'))).filter(name => /^[0-9a-f]{64}$/.test(name))
    expect(entries).toHaveLength(2)
  })
})
