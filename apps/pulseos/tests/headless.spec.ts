/**
 * REAL composition: boots `dsh headless` with the PulseOS overlay through the DSH Loader, driven by
 * a scripted model. Covers M2's "done when": list elements, change TE and flip angle, rebuild,
 * report timing, edit the recipe; the tool results the model saw are snapshotted keyless.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startScriptedLlm, toolResults, type ScriptedLlm, type ScriptStep } from './scripted-llm.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))

/** Landlock ABI of this host; builds are confined only where the kernel supports it (CI kernels may not). */
const landlockAbi = Number(spawnSync(join(repo, 'python/.venv/bin/python'), ['-c', 'from pulseos_seq.confine import abi_version; print(abi_version())'], { encoding: 'utf8' }).stdout.trim() || 0)
const confine = landlockAbi >= 4

const SCRIPT: ScriptStep[] = [
  { tool: 'seq_status', input: {} },
  { tool: 'seq_build', input: { cause: 'initial 2D GRE build' } },
  { tool: 'seq_status', input: {} },
  { tool: 'seq_get_element', input: { id: 'gre2d:excitation.rf' } },
  { tool: 'seq_set_params', input: { params: [{ name: 'TE', value: 0.005 }, { name: 'flip_angle', value: 25 }], cause: 'TE 5 ms, flip 25 deg' } },
  { tool: 'seq_set_params', input: { params: [{ name: 'TE', value: 0.001 }], cause: 'try TE 1 ms' } },
  { tool: 'seq_check_timing', input: {} },
  { tool: 'seq_edit_recipe', input: { edits: [{ old_text: 'b.block("excitation", rf=rf, gz=gz)', new_text: 'b.block("rf_excite", formerly="excitation", rf=rf, gz=gz)' }], cause: 'rename excitation role' } },
  { tool: 'seq_edit_recipe', input: { edits: [{ old_text: 'import math\n', new_text: 'import math\nimport os\n' }], cause: 'try a disallowed import' } },
  { tool: 'seq_get_element', input: { id: 'gre2d:excitation.rf', rev: 2 } },
  { tool: 'seq_diff', input: { from: 2 } },
  { text: 'Done: TE is 5 ms and the flip angle 25 degrees at [[gre2d:rf_excite.rf]].' },
]

function normalize(text: string): string {
  return text.replace(/sha256:[0-9a-f]{64}/g, 'sha256:<hash>').replace(/pypulseq \d[\w.]*/g, 'pypulseq <version>')
}

describe('dsh headless with the PulseOS overlay', () => {
  let llm: ScriptedLlm
  let scratch: string
  let exitCode: number | null
  let output = ''

  beforeAll(async () => {
    llm = await startScriptedLlm(SCRIPT)
    scratch = await mkdtemp(join(tmpdir(), 'pulseos-headless-'))
    const overlay = join(scratch, 'test.patch.yml')
    await writeFile(overlay, `- id: pulseos-seq-service\n  config:\n    dataDir: ${JSON.stringify(join(scratch, 'data'))}\n    confine: ${confine}\n`)
    const child = spawn(process.execPath, [join(repo, 'scripts/dsh.mjs'), 'headless', '--patch', overlay, 'Build the GRE and set TE to 5 ms'], {
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
    expect(output).toContain('[[gre2d:rf_excite.rf]]')
  })

  it('gives the model the expected tool results', async () => {
    const results = toolResults(llm.requests.at(-1)!)
    expect(results.map(r => [r.tool, r.isError])).toEqual([
      ['seq_status', false], ['seq_build', false], ['seq_status', false], ['seq_get_element', false],
      ['seq_set_params', false], ['seq_set_params', true], ['seq_check_timing', false],
      ['seq_edit_recipe', false], ['seq_edit_recipe', true], ['seq_get_element', false], ['seq_diff', false],
    ])
    expect(results[1]!.text).toContain('Built r1 (init, model)')
    expect(results[2]!.text).toContain('gre2d:param.TE: TE = 4.2 ms')
    expect(results[4]!.text).toMatch(/Built r2 \(param, model\)[\s\S]*gre2d:param.TE 0.0042 -> 0.005/)
    expect(results[5]!.text).toContain('TE = 1.00 ms is too short')
    expect(results[7]!.text).toContain('renamed excitation->rf_excite')
    expect(results[8]!.text).toContain('import of "os" is not allowed')
    expect(results[9]!.text).toContain('At r2:')
    expect(results[10]!.text).toContain('+            b.block("rf_excite", formerly="excitation", rf=rf, gz=gz)')
    await expect(results.map(r => `## ${r.tool}${r.isError ? ' (error)' : ''}\n${normalize(r.text)}`).join('\n\n'))
      .toMatchFileSnapshot('./__snapshots__/headless-tool-results.md')
  })

  it('stores the built models by content address', async () => {
    const models = await readdir(join(scratch, 'data/models'))
    expect(models.length).toBe(3)
    const model = JSON.parse(await readFile(join(scratch, 'data/models', models[0]!), 'utf8')) as { confinement: { landlockAbi: number } | null }
    expect(model.confinement === null ? 0 : model.confinement.landlockAbi).toBe(confine ? landlockAbi : 0)
    expect((await readdir(join(scratch, 'data/seq'))).length).toBe(3)
  })
})
