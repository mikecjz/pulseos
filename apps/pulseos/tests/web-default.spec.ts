/**
 * Browser test: the sequence viewer opens by default for every session, before any build, and a
 * user who closes it keeps it closed for that session (across new messages and a page reload)
 * while other sessions still open it by default.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { diagnose, findChromium } from './browser.ts'
import { startScriptedLlm, type ScriptedLlm } from './scripted-llm.ts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const executablePath = findChromium()

describe.skipIf(executablePath === undefined)('sequence viewer opens by default', () => {
  let llm: ScriptedLlm
  let scratch: string
  let child: ChildProcess
  let browser: Browser
  let page: Page
  let url: string | undefined
  let log = ''
  const viewer = () => page.locator('[data-pulseos-viewer]')
  const send = async (text: string) => {
    await page.locator('[contenteditable="true"]').last().click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }

  beforeAll(async () => {
    // Text-only replies: nothing is ever built, so only the default open can show the viewer.
    llm = await startScriptedLlm([{ text: 'Hello.' }, { text: 'Still here.' }, { text: 'Again.' }])
    scratch = mkdtempSync(join(tmpdir(), 'pulseos-web-default-'))
    // documentsDirectory: the default Workspace otherwise depends on the host's Documents lookup,
    // which fails on CI runners and leaves the start page without a composer.
    const overlay = join(scratch, 'test.patch.yml')
    writeFileSync(overlay, `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(scratch, 'Documents'))}\n`)
    child = spawn(process.execPath, [join(repo, 'scripts/dsh.mjs'), 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      env: { ...process.env, DSH_HOME: join(scratch, 'home'), DEEPSEEK_BASE_URL: llm.url, DEEPSEEK_API_KEY: 'mock-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', (c: Buffer) => { log += c.toString() })
    child.stderr!.on('data', (c: Buffer) => { log += c.toString() })
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
    if (context.task.result?.state === 'fail' && page !== undefined) await diagnose(page, `web-default-${context.task.name.replace(/\W+/g, '-')}`, log)
  })

  afterAll(async () => {
    await browser?.close()
    child?.kill('SIGTERM')
    await llm?.close()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('shows the empty viewer as soon as a session exists', async () => {
    await send('hello')
    await viewer().waitFor({ timeout: 30_000 })
    await page.getByText('No sequence built yet').waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Build gre2d with defaults' }).waitFor({ timeout: 15_000 })
  }, 60_000)

  it('keeps the viewer closed for that session after the user closes it', async () => {
    await page.getByRole('button', { name: 'Close', exact: true }).first().click()
    await expect.poll(() => viewer().count(), { timeout: 10_000 }).toBe(0)
    await send('are you there?')
    await page.getByText('Still here.').waitFor({ timeout: 30_000 })
    await page.waitForTimeout(1500)
    expect(await viewer().count()).toBe(0)
    await page.reload()
    await page.getByText('Still here.').waitFor({ timeout: 30_000 }).catch(async () => {
      // A reload that lands on the start page: reopen the session from the sidebar list.
      await page.getByRole('link', { name: /PulseOS session/ }).first().click()
    })
    await page.waitForTimeout(2000)
    expect(await viewer().count()).toBe(0)
  }, 120_000)

  it('still opens the viewer by default for a new session', async () => {
    await page.getByText('New Session', { exact: true }).first().click()
    // The start page's composer has its own placeholder; the session exists after the first message.
    await page.getByText('Describe what you want to build', { exact: false }).waitFor({ timeout: 15_000 })
    await send('second session')
    await viewer().waitFor({ timeout: 30_000 })
    await page.getByText('No sequence built yet').waitFor({ timeout: 15_000 })
  }, 60_000)
})
