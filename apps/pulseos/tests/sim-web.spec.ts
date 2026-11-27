/**
 * Browser test of the Simulation page on the real composition: `dsh web` with the PulseOS overlay,
 * the fake engine (a real MCP server over stdio), a scripted keyless model and Chromium. Covers the
 * page's states (empty, running, result, stale, failed, engine unavailable), its three views, ADC
 * names on hover, and `[[sim:...]]` references from the page into chat and back to the model.
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
const executablePath = findChromium()
const landlockAbi = Number(spawnSync(join(repo, 'python/.venv/bin/python'), ['-c', 'from pulseos_seq.confine import abi_version; print(abi_version())'], { encoding: 'utf8' }).stdout.trim() || 0)

describe.skipIf(executablePath === undefined)('simulation page in dsh web', () => {
  let llm: ScriptedLlm
  let scratch: string
  let child: ChildProcess
  let browser: Browser
  let page: Page
  let log = ''
  const shots = process.env.PULSEOS_SCREENSHOTS
  const shot = async (name: string) => { if (shots) await page.screenshot({ path: join(shots, `sim-${name}.png`) }) }
  const panel = () => page.locator('[data-pulseos-sim]')
  const say = async (text: string) => {
    const composer = page.locator('[contenteditable="true"]').last()
    await composer.click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }

  beforeAll(async () => {
    if (shots) mkdirSync(shots, { recursive: true })
    llm = await startScriptedLlm([
      { tool: 'sim_run', input: { cause: 'simulate before building' } },
      { text: 'Build the sequence first.' },
      { tool: 'seq_build', input: { cause: 'initial 2D GRE build' } },
      { text: 'Built r1.' },
      { tool: 'sim_run', input: { phantom: 'tubes', cause: 'baseline contrast' } },
      { text: 'Simulated [[sim:r1/tubes]].' },
      { text: 'The short-T1 vial is brightest.' },
      { tool: 'seq_set_params', input: { params: [{ name: 'flip_angle', value: 30 }], cause: 'flip 15 -> 30 deg' } },
      { text: 'Raised the flip angle.' },
      { tool: 'sim_run', input: { phantom: 'broken', cause: 'a phantom that fails' } },
      { text: 'That simulation failed.' },
    ])
    scratch = mkdtempSync(join(tmpdir(), 'pulseos-sim-web-'))
    const overlay = join(scratch, 'test.patch.yml')
    writeFileSync(overlay, `- id: pulseos-seq-service\n  config:\n    dataDir: ${JSON.stringify(join(scratch, 'data'))}\n    confine: ${landlockAbi >= 4}\n`
      + `- id: pulseos-sim-service\n  config:\n    dataDir: ${JSON.stringify(join(scratch, 'data'))}\n    defaultEngine: fake\n    defaultPhantom: tubes\n    engines:\n`
      + `      fake:\n        launcher: fake\n        fakeDelayMs: 40\n      down:\n        launcher: local\n        command: [${JSON.stringify(join(scratch, 'no-such-engine'))}]\n`
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
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(url)
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 30_000 }).catch(() => undefined)
  }, 240_000)

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page !== undefined) await diagnose(page, `sim-web-${context.task.name.replace(/\W+/g, '-')}`, log)
  })

  afterAll(async () => {
    await browser?.close()
    child?.kill('SIGTERM')
    await llm?.close()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('opens beside the Sequence tab when the model simulates, empty before a build', async () => {
    await say('Simulate the sequence')
    await page.getByText('Build the sequence first.').waitFor({ timeout: 60_000 })
    await panel().locator('[data-pulseos-sim-empty="no-sequence"]').waitFor({ timeout: 30_000 })
    await expect.poll(() => page.getByRole('tab', { name: /Simulation/ }).count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await shot('1-empty')
  }, 90_000)

  it('shows progress while running, then the simulated image and tissue means', async () => {
    await say('Build the 2D GRE')
    await page.getByText('Built r1.').waitFor({ timeout: 60_000 })
    await page.getByRole('tab', { name: /Simulation/ }).first().click()
    await panel().locator('[data-pulseos-sim-empty="no-run"]').waitFor({ timeout: 30_000 })
    await say('Simulate it on the tubes')
    await panel().getByRole('status', { name: 'Simulation progress' }).waitFor({ timeout: 30_000 })
    await expect.poll(async () => (await panel().getByRole('status', { name: 'Simulation progress' }).textContent().catch(() => '')) ?? '', { timeout: 15_000 }).toMatch(/\d+\/64 repetitions/)
    await shot('2-running')
    const image = panel().locator('canvas[role="img"]')
    await expect.poll(() => image.getAttribute('data-loaded'), { timeout: 30_000 }).toBe('true')
    expect(await image.getAttribute('aria-label')).toBe('Simulated image magnitude, r1, tubes')
    await expect.poll(() => panel().getByRole('table', { name: 'Mean signal per tissue' }).locator('tr').count(), { timeout: 10_000 }).toBe(6)
    // Non-black pixels: the vials are drawn.
    const lit = await page.evaluate(`(() => {
      const c = document.querySelector('[data-pulseos-sim] canvas[role="img"]'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 60) n++; return n
    })()`)
    expect(lit).toBeGreaterThan(100)
    await shot('3-image')
  }, 120_000)

  it('switches to k-space and to the signal, naming the hovered ADC event', async () => {
    await panel().getByRole('tab', { name: 'k-space' }).click()
    await expect.poll(() => panel().locator('canvas[role="img"]').getAttribute('aria-label')).toBe('Simulated k-space (log magnitude), r1, tubes')
    await shot('4-kspace')
    await panel().getByRole('tab', { name: 'Signal' }).click()
    const canvas = panel().locator('canvas[role="img"]')
    await expect.poll(() => canvas.getAttribute('data-loaded'), { timeout: 15_000 }).toBe('true')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width * (32.5 / 64), box.y + box.height / 2)
    const tip = panel().locator('[data-pulseos-sim-adc]')
    await expect.poll(() => tip.getAttribute('data-pulseos-sim-adc'), { timeout: 10_000 }).toBe('gre2d:readout.adc@slice=0,line=32')
    expect(await tip.textContent()).toContain('k-space centre')
    await shot('5-signal')
    await panel().getByRole('tab', { name: 'Image' }).click()
  }, 60_000)

  it('references the run in chat; the model receives the run summary', async () => {
    await panel().getByRole('button', { name: /Reference in chat/ }).click()
    await page.keyboard.type(' which vial is brightest?')
    await page.keyboard.press('Enter')
    const chip = page.locator('[data-pulseos-sim-chip="r1/tubes"]').first()
    await chip.waitFor({ timeout: 30_000 })
    expect(await chip.getAttribute('aria-label')).toBe('Simulation: r1 on tubes')
    const sent = () => JSON.stringify(llm.requests.find(r => JSON.stringify(r.messages).includes('which vial is brightest'))?.messages ?? '')
    await expect.poll(sent, { timeout: 30_000 }).toContain('[[sim:r1/tubes]]')
    expect(sent()).toContain('<simulation-references>')
    expect(sent()).toContain('Mean signal per tissue')
    await page.getByText('The short-T1 vial is brightest.').waitFor({ timeout: 30_000 })
    await shot('6-chip')
  }, 90_000)

  it('marks the run stale after a new revision and simulates the new one from the page', async () => {
    await say('Raise the flip angle to 30 degrees')
    await page.getByText('Raised the flip angle.').waitFor({ timeout: 60_000 })
    const stale = panel().locator('[data-pulseos-sim-stale]')
    await stale.waitFor({ timeout: 30_000 })
    expect(await stale.textContent()).toContain('r1 → r2')
    await shot('7-stale')
    await stale.getByRole('button', { name: 'Simulate r2' }).click()
    await expect.poll(() => panel().locator('canvas[role="img"]').getAttribute('aria-label'), { timeout: 30_000 }).toBe('Simulated image magnitude, r2, tubes')
    expect(await stale.count()).toBe(0)
  }, 120_000)

  it('shows a failed simulation with Retry', async () => {
    await say('Simulate the broken phantom')
    await page.getByText('That simulation failed.').waitFor({ timeout: 60_000 })
    const failed = panel().locator('[data-pulseos-sim-failed]')
    await failed.waitFor({ timeout: 30_000 })
    expect(await failed.textContent()).toContain('the fake engine failed on purpose')
    expect(await failed.getByRole('button', { name: 'Retry' }).count()).toBe(1)
    await shot('8-failed')
  }, 90_000)

  it('shows an engine that cannot start as unavailable', async () => {
    await panel().getByRole('combobox', { name: 'Engine' }).selectOption('down')
    await panel().getByRole('button', { name: /Simulate/ }).first().click()
    const banner = panel().locator('[data-pulseos-sim-unavailable]')
    await banner.waitFor({ timeout: 30_000 })
    expect(await banner.textContent()).toContain('could not start the down engine')
    expect(await banner.textContent()).toContain('The down engine is unavailable.')
    await shot('9-unavailable')
    await panel().getByRole('combobox', { name: 'Engine' }).selectOption('fake')
  }, 60_000)

  it('follows DSH switching to light mode', async () => {
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => panel().getAttribute('data-theme'), { timeout: 10_000 }).toBe('light')
    await shot('10-light')
  })
})
