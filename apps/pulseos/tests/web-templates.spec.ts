/**
 * Browser test on the real composition (`dsh web` with the PulseOS overlay and Chromium): the viewer
 * builds a pypulseq example template as a revision, and renders an uploaded `.seq` file read-only
 * without adding it to the session.
 * Set PULSEOS_SCREENSHOTS=<dir> to keep screenshots.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { diagnose, findChromium } from './browser.ts'
import { startScriptedLlm, type ScriptedLlm } from './scripted-llm.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const python = join(repo, 'python/.venv/bin/python')
const executablePath = findChromium()
const landlockAbi = Number(spawnSync(python, ['-c', 'from pulseos_seq.confine import abi_version; print(abi_version())'], { encoding: 'utf8' }).stdout.trim() || 0)

describe.skipIf(executablePath === undefined)('sequence viewer templates and read-only .seq files', () => {
  let llm: ScriptedLlm
  let scratch: string
  let child: ChildProcess
  let browser: Browser
  let page: Page
  let log = ''
  let seqFile: string
  const shots = process.env.PULSEOS_SCREENSHOTS
  const shot = async (name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }) }
  const viewer = () => page.locator('[data-pulseos-viewer]')
  const send = async (text: string) => {
    await page.locator('[contenteditable="true"]').last().click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }

  beforeAll(async () => {
    if (shots) mkdirSync(shots, { recursive: true })
    llm = await startScriptedLlm([{ text: 'Hello.' }])
    scratch = mkdtempSync(join(tmpdir(), 'pulseos-web-templates-'))
    // A .seq file written by the bundled gre2d recipe, as a user would upload it.
    seqFile = join(scratch, 'my_gre.seq')
    const written = spawnSync(python, ['-c', [
      'import sys',
      'from pulseos_seq.recipe import build_sequence, bundled_recipe, load_recipe',
      'from pulseos_seq.scanner import load_profile',
      'recipe = load_recipe(*bundled_recipe("gre2d"))',
      'build_sequence(recipe, load_profile("generic", sys.argv[2]), {"Ny": 8}, sys.argv[1])',
    ].join('\n'), seqFile, join(repo, 'profiles/scanner')], { encoding: 'utf8' })
    if (written.status !== 0) throw new Error(`writing the test .seq file failed: ${written.stderr}`)
    writeFileSync(join(scratch, 'broken.seq'), '[VERSION]\nmajor 1\nnot a sequence\n')
    const overlay = join(scratch, 'test.patch.yml')
    // documentsDirectory: the default Workspace otherwise depends on the host's Documents lookup.
    writeFileSync(overlay, `- id: pulseos-seq-service\n  config:\n    dataDir: ${JSON.stringify(join(scratch, 'data'))}\n    confine: ${landlockAbi >= 4}\n`
      + `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(scratch, 'Documents'))}\n`)
    child = spawn(process.execPath, [join(repo, 'scripts/dsh.mjs'), 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      env: { ...process.env, DSH_HOME: join(scratch, 'home'), DEEPSEEK_BASE_URL: llm.url, DEEPSEEK_API_KEY: 'mock-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', (c: Buffer) => { log += c.toString() })
    child.stderr!.on('data', (c: Buffer) => { log += c.toString() })
    let url: string | undefined
    for (let i = 0; i < 360 && url === undefined; i++) {
      await new Promise(resolve => setTimeout(resolve, 500))
      url = /dsh web: (http\S+)/.exec(log)?.[1]
      if (child.exitCode !== null) throw new Error(`dsh web exited:\n${log}`)
    }
    if (url === undefined) throw new Error(`dsh web did not start:\n${log}`)
    browser = await chromium.launch({ executablePath: executablePath! })
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    await page.goto(url)
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 30_000 }).catch(() => undefined)
  }, 240_000)

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page !== undefined) await diagnose(page, `web-templates-${context.task.name.replace(/\W+/g, '-')}`, log)
  })

  afterAll(async () => {
    await browser?.close()
    child?.kill('SIGTERM')
    await llm?.close()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('builds a pypulseq example template from the empty viewer as r1', async () => {
    await send('hello')
    await viewer().waitFor({ timeout: 30_000 })
    const picker = page.getByRole('combobox', { name: 'Build from template' }).first()
    await expect.poll(() => picker.locator('option').allTextContents(), { timeout: 15_000 })
      .toEqual(expect.arrayContaining(['2D gradient echo (PulseOS)', '2D echo-planar imaging', '2D turbo spin echo', '3D MPRAGE']))
    await shot('templates-empty')
    await picker.selectOption({ label: '2D echo-planar imaging' })
    await page.getByRole('combobox', { name: 'Revision' }).locator('option', { hasText: 'r1 · init · template: 2D echo-planar imaging' }).waitFor({ state: 'attached', timeout: 60_000 })
    await viewer().getByText('seq epi').waitFor({ timeout: 30_000 })
    // Three slices: each excitation starts a repetition; the echo train's blocks stay inside it (inner loop n).
    await viewer().getByText(/Overview · 3 repetitions/).waitFor({ timeout: 15_000 })
    await viewer().getByRole('button', { name: 'epi:readout', exact: true }).dispatchEvent('click') // screen-reader role list; canvas covers it
    await page.getByRole('region', { name: 'Inspector' }).getByText('epi:readout').first().waitFor({ timeout: 10_000 })
    await expect.poll(() => page.getByRole('region', { name: 'Inspector' }).getByRole('row', { name: /Blocks/ }).textContent()).toContain('192')
    await shot('templates-epi')
  }, 120_000)

  it('renders an uploaded .seq file read-only and returns to the session sequence', async () => {
    await viewer().locator('input[type="file"]').first().setInputFiles(seqFile)
    await viewer().getByText('Read-only render of').waitFor({ timeout: 60_000 })
    await viewer().getByText('my_gre.seq', { exact: true }).first().waitFor()
    await expect.poll(() => viewer().getByRole('combobox', { name: 'Revision' }).count()).toBe(0)
    // Roles come from block contents: the gre2d file has 8 excitations, so 8 repetitions.
    await viewer().getByText(/Overview · 8 repetitions/).waitFor({ timeout: 15_000 })
    await viewer().getByRole('button', { name: 'gre2d:excitation', exact: true }).dispatchEvent('click')
    const inspector = page.getByRole('region', { name: 'Inspector' })
    await inspector.getByText('An uploaded .seq file has no recipe', { exact: false }).waitFor({ timeout: 10_000 })
    expect(await inspector.getByRole('button', { name: /Reference in chat/ }).count()).toBe(0)
    await shot('seq-file-read-only')

    await viewer().getByRole('button', { name: 'Close file' }).click()
    await viewer().getByText('seq epi').waitFor({ timeout: 30_000 })
    await expect.poll(() => viewer().getByRole('combobox', { name: 'Revision' }).locator('option').count()).toBe(2) // latest + r1: the file added no revision
  }, 120_000)

  it('reports a file pypulseq cannot read and keeps the session sequence', async () => {
    await viewer().locator('input[type="file"]').first().setInputFiles(join(scratch, 'broken.seq'))
    await viewer().getByText(/Could not read broken\.seq/).waitFor({ timeout: 60_000 })
    await viewer().getByText('seq epi').waitFor()
    expect(await viewer().getByText('Read-only render of').count()).toBe(0)
  }, 90_000)
})
