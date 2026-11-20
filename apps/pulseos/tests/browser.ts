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
