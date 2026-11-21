/**
 * REAL composition for M3: a second headless turn on the same session refers to elements with
 * [[id]] tokens. The model's request must carry the reference context, and the durable session log
 * must hold exactly that context, so replay reproduces what the model saw.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startScriptedLlm, type ScriptStep } from './scripted-llm.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const landlockAbi = Number(spawnSync(join(repo, 'python/.venv/bin/python'), ['-c', 'from pulseos_seq.confine import abi_version; print(abi_version())'], { encoding: 'utf8' }).stdout.trim() || 0)
const PROMPT = 'Why is [[gre2d:excitation.rf|r1]] different from [[gre2d:excitation.rf]]? Also check [[gre2d:readout.adc@slice=0,line=40|r1]] and [[gre2d:bogus]].'

async function runHeadless(scratch: string, overlay: string, script: ScriptStep[], args: string[]) {
  const llm = await startScriptedLlm(script)
  let output = ''
  try {
    const child = spawn(process.execPath, [join(repo, 'scripts/dsh.mjs'), 'headless', '--patch', overlay, '--json', ...args], {
      env: { ...process.env, DSH_HOME: join(scratch, 'home'), DEEPSEEK_BASE_URL: llm.url, DEEPSEEK_API_KEY: 'mock-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    const exitCode = await new Promise<number | null>(resolve => child.on('exit', resolve))
    return { exitCode, output, requests: llm.requests }
  } finally {
    await llm.close()
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter(e => e.isFile()).map(e => join(e.parentPath, e.name))
}

describe('[[id]] references in a resumed session', () => {
  let scratch: string
  let first: Awaited<ReturnType<typeof runHeadless>>
  let second: Awaited<ReturnType<typeof runHeadless>>

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'pulseos-refs-'))
    const overlay = join(scratch, 'test.patch.yml')
    await writeFile(overlay, `- id: pulseos-seq-service\n  config:\n    dataDir: ${JSON.stringify(join(scratch, 'data'))}\n    confine: ${landlockAbi >= 4}\n`)
    first = await runHeadless(scratch, overlay, [
      { tool: 'seq_build', input: { cause: 'initial build' } },
      { tool: 'seq_set_params', input: { params: [{ name: 'flip_angle', value: 30 }, { name: 'Ny', value: 32 }], cause: 'flip 30, Ny 32' } },
      { text: 'Built r1 and r2.' },
    ], ['Build the GRE'])
    const sessionId = /"sessionId":"([^"]+)"/.exec(first.output)?.[1]
    if (sessionId === undefined) throw new Error(`no session id in the first run's output:\n${first.output}`)
    second = await runHeadless(scratch, overlay, [{ text: 'The flip angle doubled.' }], ['--session-id', sessionId, PROMPT])
  }, 300_000)

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  })

  it('runs both turns', () => {
    expect(first.exitCode, first.output).toBe(0)
    expect(second.exitCode, second.output).toBe(0)
  })

  it('sends the reference context right after the user message', () => {
    const messages = second.requests.at(-1)!.messages
    const userIndex = messages.findIndex(m => JSON.stringify(m.content).includes('Why is [[gre2d:excitation.rf|r1]]'))
    expect(userIndex).toBeGreaterThan(0)
    const context = JSON.stringify(messages.slice(userIndex).map(m => m.content))
    expect(context).toContain('<sequence-references>')
    expect(context).toContain('[[gre2d:excitation.rf|r1]] — at r1:')
    expect(context).toContain('At the latest revision r2 it is changed.')
    expect(context).toContain('[[gre2d:excitation.rf]] — at r2 (latest):')
    expect(context).toContain('flip angle 30 deg')
    expect(context).toContain('At the latest revision r2 this element no longer exists')
    expect(context).toContain('[[gre2d:bogus]] — at r2: gre2d:bogus does not exist')
  })

  it('logs exactly the context the model saw', async () => {
    const sent = second.requests.at(-1)!.messages
      .flatMap(m => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]))
      .map(block => (block as { text?: unknown }).text)
      .find((text): text is string => typeof text === 'string' && text.startsWith('<sequence-references>'))
    expect(sent).toBeDefined()
    // The JSONL persistence backend writes one zstd-compressed log per session.
    const files = (await filesUnder(join(scratch, 'home'))).filter(file => file.endsWith('.jsonl.zstd'))
    const logs = await Promise.all(files.map(async file => ({ file, text: zstdDecompressSync(await readFile(file)).toString('utf8') })))
    const logged = logs.filter(({ text }) => text.includes('"pulseos-reference"'))
    expect(logged.length, 'session log with the reference context').toBeGreaterThan(0)
    const events = logged.flatMap(({ text }) => text.split('\n').filter(line => line.includes('"pulseos-reference"')))
      .map(line => JSON.parse(line) as { type: string; data: { content: { text: string }[]; source: { references: { status: string }[] } } })
    const event = events.find(e => e.type === 'user/message')!
    expect(event.data.content[0]!.text).toBe(sent)
    expect(event.data.source.references.map(r => r.status)).toEqual(['changed', 'resolved', 'gone', 'gone'])
  })
})
