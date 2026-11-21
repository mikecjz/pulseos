/** The viewer's color scheme follows DSH's theme service and its `theme/change` event. */
import { Context } from '@deepseek-ai/cordis'
import type { ThemeDefinition, ThemeRuntime, ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { describe, expect, it } from 'vitest'
import { DARK, LIGHT } from '../src/client/draw.ts'
import { followHostTheme, schemeOf } from '../src/client/theme.ts'

const theme = (id: string, colorScheme: 'light' | 'dark'): ThemeDefinition => ({ id, colorScheme, tokens: {} })
const snapshot = (active: ThemeDefinition): ThemeSnapshot => ({
  preference: 'system', fontSizes: { text: 14, code: 13, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' },
  active, themes: [active], revision: 0,
})

function host(initial: ThemeDefinition): { ctx: Context; switchTo(active: ThemeDefinition): void } {
  const ctx = new Context()
  let current = snapshot(initial)
  ctx.provide('theme', { getTheme: () => current } as Pick<ThemeRuntime, 'getTheme'> as ThemeRuntime)
  return { ctx, switchTo(active) { current = snapshot(active); ctx.emit('theme/change', current) } }
}

describe('host theme', () => {
  it('maps the active theme to its base palette, including registered themes', () => {
    expect(schemeOf(snapshot(theme('light', 'light')))).toBe('light')
    expect(schemeOf(snapshot(theme('dark', 'dark')))).toBe('dark')
    expect(schemeOf(snapshot(theme('acme-midnight', 'dark')))).toBe('dark')
  })

  it.each([['light', 'dark'], ['dark', 'light']] as const)('starts in DSH %s mode and follows a live switch to %s', (from, to) => {
    const { ctx, switchTo } = host(theme(from, from))
    const source = followHostTheme(ctx)
    expect(source.getSnapshot()).toBe(from)
    const seen: string[] = []
    source.subscribe(() => { seen.push(source.getSnapshot()) })
    switchTo(theme(to, to))
    expect(source.getSnapshot()).toBe(to)
    expect(seen).toEqual([to])
    // A theme change that keeps the scheme (e.g. a token override) does not re-render the viewer.
    switchTo(theme(`${to}-custom`, to))
    expect(seen).toEqual([to])
  })

  it('stops notifying after unsubscribe and after the plugin context is disposed', async () => {
    const { ctx, switchTo } = host(theme('dark', 'dark'))
    let source!: ReturnType<typeof followHostTheme>
    const fiber = ctx.plugin({ name: 'viewer', apply: (plugin: Context) => { source = followHostTheme(plugin) } })
    await fiber.await()
    let calls = 0
    const stop = source.subscribe(() => { calls++ })
    switchTo(theme('light', 'light'))
    stop()
    switchTo(theme('dark', 'dark'))
    expect(calls).toBe(1)
    source.subscribe(() => { calls++ })
    await fiber.dispose()
    switchTo(theme('light', 'light'))
    expect(calls).toBe(1)
  })

  it('has a palette for each scheme with the same channels', () => {
    expect(Object.keys(LIGHT).toSorted()).toEqual(Object.keys(DARK).toSorted())
    expect(LIGHT.bg).not.toBe(DARK.bg)
  })
})
