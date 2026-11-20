/** Scanner profiles load from JSON and invalid profiles fail the plugin load. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import ScannerProfileService, { BUNDLED_PROFILE_DIRECTORY, loadScannerProfile } from '../src/index.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function profileDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pulseos-scanner-'))
  dirs.push(dir)
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value))
  return dir
}

const generic = loadScannerProfile(BUNDLED_PROFILE_DIRECTORY, 'generic')

describe('bundled generic profile', () => {
  it('has the documented generic limits', () => {
    expect(generic.id).toBe('generic')
    expect(generic.limits.max_grad_mT_per_m).toBe(40)
    expect(generic.limits.max_slew_T_per_m_per_s).toBe(150)
    expect(generic.limits.b0_T).toBe(3)
  })
})

describe('ScannerProfileService', () => {
  it('registers ctx.scannerProfile with the generic profile by default', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(ScannerProfileService, {})
    expect(ctx.scannerProfile.profile.id).toBe('generic')
    expect(ctx.scannerProfile.limits()).toEqual(generic.limits)
  })

  it('swaps to another profile from config', async () => {
    const custom = { ...generic, id: 'strong', title: 'Strong gradients', limits: { ...generic.limits, max_grad_mT_per_m: 80, max_slew_T_per_m_per_s: 200 } }
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(ScannerProfileService, { profile: 'strong', directory: profileDir({ strong: custom }) })
    expect(ctx.scannerProfile.limits().max_grad_mT_per_m).toBe(80)
  })
})

describe('loadScannerProfile rejects invalid profiles', () => {
  const { max_slew_T_per_m_per_s: _slew, ...withoutSlew } = generic.limits
  it.each([
    ['a missing file', {}, 'absent'],
    ['an id mismatch', { other: { ...generic, id: 'generic' } }, 'other'],
    ['an unknown top-level field', { x: { ...generic, id: 'x', vendor: 'acme' } }, 'x'],
    ['an unknown limit', { x: { ...generic, id: 'x', limits: { ...generic.limits, max_grad: 40 } } }, 'x'],
    ['a missing limit', { x: { ...generic, id: 'x', limits: withoutSlew } }, 'x'],
    ['a zero gradient limit', { x: { ...generic, id: 'x', limits: { ...generic.limits, max_grad_mT_per_m: 0 } } }, 'x'],
    ['a negative dead time', { x: { ...generic, id: 'x', limits: { ...generic.limits, rf_dead_time_s: -1 } } }, 'x'],
    ['an id with a path separator', {}, '../generic'],
  ])('%s', (_label, files, id) => {
    expect(() => loadScannerProfile(profileDir(files), id)).toThrow()
  })
})
