import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOGO_TRANSFORM, PULSE_PATH, PULSE_STROKE_WIDTH, WORD_PATH, WORD_TRANSFORM } from '../src/client/paths.ts'

const asset = (file: string) => readFileSync(new URL(`../../../../assets/logo/${file}`, import.meta.url), 'utf8')

describe('brand geometry', () => {
  it('matches the canonical artwork in assets/logo', () => {
    for (const theme of ['light', 'dark']) {
      const mark = asset(`pulseos-mark-${theme}.svg`)
      const logo = asset(`pulseos-logo-${theme}.svg`)
      expect(mark).toContain(`d="${PULSE_PATH}"`)
      expect(mark).toContain(`stroke-width="${PULSE_STROKE_WIDTH.toFixed(1)}"`)
      expect(logo).toContain(`d="${PULSE_PATH}"`)
      expect(logo).toContain(`d="${WORD_PATH}"`)
      expect(logo).toContain(`<g transform="${LOGO_TRANSFORM}">`)
      expect(logo).toContain(`<g transform="${WORD_TRANSFORM}">`)
    }
  })
})
