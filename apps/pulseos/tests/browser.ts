/** Locate a Chromium for browser tests: PULSEOS_CHROMIUM, Playwright's own, or any cached Playwright build. */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

export function findChromium(): string | undefined {
  const fromEnv = process.env.PULSEOS_CHROMIUM
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv
  const own = chromium.executablePath()
  if (existsSync(own)) return own
  const cache = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(cache)) return undefined
  for (const dir of readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).toSorted().toReversed()) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(cache, dir, sub)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Record what the page shows when a browser test fails: a screenshot under test-results/ (uploaded
 * by CI) and the page URL and text on stderr.
 * @param page - the page.
 * @param name - file name stem.
 * @param log - server log tail to print alongside.
 */
export async function diagnose(page: import('playwright-core').Page, name: string, log = ''): Promise<void> {
  const { mkdirSync } = await import('node:fs')
  const dir = join(process.cwd(), 'test-results')
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true }).catch(() => undefined)
  const text = await page.locator('body').innerText().catch(() => '(no page text)')
  console.error(`[${name}] url=${page.url().replace(/token=[^&]+/, 'token=…')}\n--- page text ---\n${text.slice(0, 2000)}\n--- dsh log tail ---\n${log.slice(-3000).replace(/token=[A-Za-z0-9_-]+/g, 'token=…')}`)
}
