/**
 * REAL composition: boots `dsh headless` with the PulseOS overlay through the launcher, with
 * PULSEOS_MODEL selecting a provider other than DeepSeek. One run uses the native Anthropic
 * Messages route, the other a custom OpenAI-compatible Chat Completions route (the protocol
 * OpenAI, OpenRouter, Kimi, GLM and DeepSeek share). Both must reach the scripted endpoint with
 * the selected model and key, and the PulseOS tools must work over them.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startScriptedLlm, type ScriptedLlm, type ScriptStep } from './scripted-llm.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))

const SCRIPT: ScriptStep[] = [
  { tool: 'seq_status', input: {} },
  { text: 'No sequence yet.' },
]

interface Run { llm: ScriptedLlm; exitCode: number | null; output: string }

async function run(scratch: string, name: string, env: (url: string) => Record<string, string>): Promise<Run> {
  const llm = await startScriptedLlm(SCRIPT)
  const overlay = join(scratch, `${name}.patch.yml`)
  await writeFile(overlay, `- id: pulseos-seq-service\n  config:\n    dataDir: ${JSON.stringify(join(scratch, name, 'data'))}\n    confine: false\n`)
  // No DeepSeek key: a request that fell back to the default route would fail.
  const { DEEPSEEK_API_KEY: _key, DEEPSEEK_BASE_URL: _url, ...inherited } = process.env
  const child = spawn(process.execPath, [join(repo, 'scripts/dsh.mjs'), 'headless', '--patch', overlay, 'What is built?'], {
    env: { ...inherited, DSH_HOME: join(scratch, name, 'home'), ...env(llm.url.replace(/\/v1$/, '')) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const exitCode = await new Promise<number | null>(resolve => child.on('exit', resolve))
  return { llm, exitCode, output }
}

describe('dsh headless with PULSEOS_MODEL', () => {
  let scratch: string
  let anthropic: Run
  let custom: Run

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'pulseos-models-'))
    ;[anthropic, custom] = await Promise.all([
      run(scratch, 'anthropic', url => ({ PULSEOS_MODEL: 'anthropic/claude-sonnet-4-5', PULSEOS_LLM_BASE_URL: url, ANTHROPIC_API_KEY: 'mock-anthropic-key' })),
      run(scratch, 'custom', url => ({ PULSEOS_MODEL: 'local/acme-coder', PULSEOS_LLM_BASE_URL: `${url}/v1`, PULSEOS_LLM_API_KEY: 'mock-custom-key' })),
    ])
  }, 240_000)

  afterAll(async () => {
    await anthropic?.llm.close()
    await custom?.llm.close()
    if (scratch) await rm(scratch, { recursive: true, force: true })
  })

  it('drives the PulseOS tools over the Anthropic Messages route', () => {
    expect(anthropic.exitCode, anthropic.output).toBe(0)
    expect(anthropic.output).toContain('No sequence yet.')
    const last = anthropic.llm.requests.at(-1)!
    expect(last.model).toBe('claude-sonnet-4-5')
    expect(anthropic.llm.meta.every(m => m.path === '/v1/messages' && m.headers['x-api-key'] === 'mock-anthropic-key')).toBe(true)
    expect(JSON.stringify(last.messages)).toContain('No sequence has been built')
  })

  it('drives the PulseOS tools over a custom OpenAI-compatible route', () => {
    expect(custom.exitCode, custom.output).toBe(0)
    expect(custom.output).toContain('No sequence yet.')
    const last = custom.llm.requests.at(-1)!
    expect(last.model).toBe('acme-coder')
    expect(custom.llm.meta.every(m => m.path === '/v1/chat/completions' && m.headers.authorization === 'Bearer mock-custom-key')).toBe(true)
    const toolMessage = last.messages.find(m => m.role === 'tool')
    expect(JSON.stringify(toolMessage)).toContain('No sequence has been built')
  })
})
