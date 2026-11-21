/**
 * Browser test of M4 on the real composition: `dsh web` with the PulseOS overlay, a scripted keyless
 * model, and Chromium. Covers: the viewer opens when the first revision lands, click-to-select with
 * the inspector, "Reference in chat" into the composer, the sent chip, chip hover, the live
 * re-render on a new revision (chip turns "changed"), highlighted assistant references,
 * following DSH's light and dark theme live, and chat navigation ("go to ky = 0 block" ->
 * seq_show selects and frames that block).
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
import { startScriptedLlm, toolResults, type ScriptedLlm } from './scripted-llm.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const executablePath = findChromium()
const landlockAbi = Number(spawnSync(join(repo, 'python/.venv/bin/python'), ['-c', 'from pulseos_seq.confine import abi_version; print(abi_version())'], { encoding: 'utf8' }).stdout.trim() || 0)

describe.skipIf(executablePath === undefined)('sequence viewer in dsh web', () => {
  let llm: ScriptedLlm
  let scratch: string
  let child: ChildProcess
  let browser: Browser
  let page: Page
  let log = ''
  const shots = process.env.PULSEOS_SCREENSHOTS
  const shot = async (name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }) }

  beforeAll(async () => {
    if (shots) mkdirSync(shots, { recursive: true })
    llm = await startScriptedLlm([
      { tool: 'seq_build', input: { cause: 'initial 2D GRE build' } },
      { text: 'Built r1. The excitation pulse is [[gre2d:excitation.rf]].' },
      { tool: 'seq_set_params', input: { params: [{ name: 'flip_angle', value: 30 }], cause: 'flip 15 -> 30 deg' } },
      { text: 'Raised [[gre2d:param.flip_angle]] to 30 degrees; [[gre2d:nope.rf]] does not exist.' },
      { tool: 'seq_show', input: { ky: 0 } },
      { text: 'This is the k-space centre line.' },
    ])
    scratch = mkdtempSync(join(tmpdir(), 'pulseos-web-'))
    const overlay = join(scratch, 'test.patch.yml')
    // documentsDirectory: the default Workspace otherwise depends on the host's Documents lookup,
    // which fails on CI runners and leaves the start page without a composer.
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
    if (context.task.result?.state === 'fail' && page !== undefined) await diagnose(page, `web-${context.task.name.replace(/\W+/g, '-')}`, log)
  })

  afterAll(async () => {
    await browser?.close()
    child?.kill('SIGTERM')
    await llm?.close()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('opens the viewer beside the chat when the first revision lands', async () => {
    const composer = page.locator('[contenteditable="true"]').last()
    await composer.click()
    await page.keyboard.type('Build the 2D GRE')
    await page.keyboard.press('Enter')
    const viewer = page.locator('[data-pulseos-viewer] canvas[role="img"]')
    await viewer.waitFor({ timeout: 60_000 })
    await expect.poll(() => page.locator('[data-pulseos-viewer] select').inputValue(), { timeout: 30_000 }).toBe('latest')
    await expect.poll(async () => (await page.locator('[data-pulseos-viewer] select option').first().textContent()) ?? '', { timeout: 30_000 }).toBe('latest (r1)')
    await page.locator('[data-pulseos-viewer]').getByText('timing 0').waitFor({ state: 'visible', timeout: 15_000 })
    await shot('1-viewer')
  }, 120_000)

  it('selects an element on click and shows it in the read-only inspector', async () => {
    const canvas = page.locator('[data-pulseos-viewer] canvas[role="img"]')
    const box = (await canvas.boundingBox())!
    // The first excitation pulse is centred near 0.71 ms of the initial 0-20 ms view, in the RF row.
    await page.mouse.click(box.x + box.width * (0.71 / 20), box.y + 120)
    const inspector = page.getByRole('region', { name: 'Inspector' })
    await inspector.getByText('gre2d:excitation.rf', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await inspector.getByText('b.block("excitation", rf=rf, gz=gz)').waitFor({ state: 'visible', timeout: 15_000 })
    await shot('2-selected')
  })

  it('references the selection in chat and renders the sent chip', async () => {
    await page.getByRole('button', { name: /Reference in chat/ }).click()
    await page.keyboard.type(' raise the flip angle to 30 degrees')
    await shot('3-composer')
    await page.keyboard.press('Enter')
    const chip = page.locator('[data-pulseos-chip="gre2d:excitation.rf"]').first()
    await chip.waitFor({ timeout: 30_000 })
    expect(await chip.getAttribute('aria-label')).toContain('Reference: excitation.rf, revision 1')
    // The chip renders as soon as the message is sent; the model request follows asynchronously.
    const sent = () => JSON.stringify(llm.requests.find(r => JSON.stringify(r.messages).includes('raise the flip angle'))?.messages ?? '')
    await expect.poll(sent, { timeout: 30_000 }).toContain('[[gre2d:excitation.rf|r1]]')
    expect(sent()).toContain('<sequence-references>')
  }, 60_000)

  it('re-renders live on the new revision and marks the chip changed', async () => {
    await expect.poll(async () => (await page.locator('[data-pulseos-viewer] select option').first().textContent()) ?? '', { timeout: 60_000 }).toBe('latest (r2)')
    const chip = page.locator('[data-pulseos-chip="gre2d:excitation.rf"]').first()
    await expect.poll(async () => (await chip.getAttribute('aria-label')) ?? '', { timeout: 30_000 }).toContain('changed since r1')
    await chip.hover()
    await page.waitForTimeout(300)
    await shot('4-chip-hover')
  }, 120_000)

  it('highlights assistant references and flags unknown ones', async () => {
    await page.getByText('does not exist.').waitFor({ timeout: 30_000 })
    await expect.poll(() => page.evaluate(() => {
      // Runs in the page, where CSS.highlights exists; this Node program has no DOM types.
      const registry = (globalThis as unknown as { CSS: { highlights: Map<string, { size: number }> } }).CSS.highlights
      return [registry.get('pulseos-ref')?.size ?? 0, registry.get('pulseos-ref-bad')?.size ?? 0]
    }), { timeout: 20_000 }).toEqual([2, 1])
    await shot('5-assistant-references')
  })

  // Background colors: DARK.bg and LIGHT.bg in packages/seq/viewer/src/client/draw.ts.
  it.each([['dark', '#0d1015'], ['light', '#fbfcfd'], ['dark', '#0d1015']] as const)('follows DSH switching to %s mode live', async (scheme, bg) => {
    // DSH's theme preference defaults to "system", so the OS scheme switches the whole client.
    await page.emulateMedia({ colorScheme: scheme })
    await expect.poll(async () => (await page.locator('body').getAttribute('data-ds-dark-theme')) !== null, { timeout: 10_000 }).toBe(scheme === 'dark')
    const viewer = page.locator('[data-pulseos-viewer]')
    await expect.poll(() => viewer.getAttribute('data-theme'), { timeout: 10_000 }).toBe(scheme)
    expect(await viewer.getByRole('button', { name: /theme/i }).count()).toBe(0)
    // The waveform canvas is repainted with the scheme's background.
    // Evaluated in the page as source text: this Node program has no DOM types.
    const pixel = () => page.evaluate(`(() => {
      const [r, g, b] = document.querySelector('[data-pulseos-viewer] canvas[role="img"]').getContext('2d').getImageData(2, 2, 1, 1).data
      return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
    })()`)
    await expect.poll(pixel, { timeout: 10_000 }).toBe(bg)
    // Chips in the conversation follow the same palette.
    const chip = page.locator('[data-pulseos-chip="gre2d:excitation.rf"]').first()
    const dot = await chip.locator('span').first().evaluate(el => (globalThis as unknown as { getComputedStyle(e: typeof el): { backgroundColor: string } }).getComputedStyle(el).backgroundColor)
    expect(dot).toBe(scheme === 'dark' ? 'rgb(242, 193, 78)' : 'rgb(183, 121, 31)')
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    await shot(`6-theme-${scheme}`)
  })

  it('navigates the viewer from chat: "go to ky = 0 block" selects and shows that block', async () => {
    const composer = page.locator('[contenteditable="true"]').last()
    await composer.click()
    await page.keyboard.type('go to ky = 0 block')
    await page.keyboard.press('Enter')
    await page.getByText('This is the k-space centre line.').waitFor({ timeout: 60_000 })
    // ky = 0 is phase-encode line 32 of 64 (TR 10 ms): its readout block is selected and its TR framed.
    const inspector = page.getByRole('region', { name: 'Inspector' })
    await inspector.getByText('gre2d:readout@slice=0,line=32', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => page.locator('[data-pulseos-viewer] canvas[role="img"]').getAttribute('aria-label'), { timeout: 15_000 })
      .toBe('Waveforms from 319.5 ms to 330.5 ms')
    const result = toolResults(llm.requests.at(-1)!).at(-1)!
    expect(result).toMatchObject({ tool: 'seq_show', isError: false })
    expect(result.text).toContain('The viewer shows [[gre2d:readout@slice=0,line=32]] at r2: ky = 0 (slice=0,line=32)')
    await shot('7-navigate-ky0')
  }, 90_000)
})
