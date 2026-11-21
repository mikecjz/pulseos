/**
 * Browser half of the PulseOS brand: fills the DSH brand slots the shell otherwise fills with
 * the DeepSeek fish.
 * - `sidebar.brand.mark`: the pulse mark (expanded brand row and collapsed rail);
 * - `sidebar.brand.name`: the "pulseos" wordmark beside it;
 * - `conversation.hero.brand.mark`: the full PulseOS banner above the blank-session composer,
 *   which also stands in for DSH's default headline (see `brand.css`).
 * All marks paint in `currentColor`, so they follow the light and dark theme ink.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { HeroBanner, PulseMark, Wordmark } from './marks.tsx'
import './brand.css'

export const inject = ['slots']

/**
 * Register the brand slot occupants.
 * @param ctx - client plugin context with `slots`.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register(
    { name: 'sidebar.brand.mark' },
    PulseMark,
  )), 'pulseos-brand: sidebar mark')
  ctx.effect(() => ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register(
    { name: 'sidebar.brand.name' },
    Wordmark,
  )), 'pulseos-brand: sidebar name')
  ctx.effect(() => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register(
    { name: 'conversation.hero.brand.mark' },
    HeroBanner,
  )), 'pulseos-brand: hero banner')
}
