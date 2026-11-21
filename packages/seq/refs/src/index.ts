/**
 * `[[<element id>]]` references in user messages. Before a model step, every direct user message
 * that contains reference tokens is followed by one context message describing each referenced
 * element at the referenced revision (or the latest), and how it compares with the latest revision.
 * The context message is logged as a `user/message` with source kind `pulseos-reference`, so the
 * model's input can be rebuilt from the session log.
 * @module @pulseos/seq-refs
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@pulseos/seq-service'
import { referenceContext, type ReferenceOutcome } from './context.ts'

export { referenceContext, type ReferenceOutcome, type ReferenceSource } from './context.ts'

/** Source of the injected reference context. */
export interface PulseosReferenceSource {
  kind: 'pulseos-reference'
  form: 'notice'
  summary: string
  version: 1
  references: ReferenceOutcome[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'pulseos-reference': PulseosReferenceSource
  }
}

export const name = 'pulseos-seq-refs'
export const inject = ['pulseSeq']

/** Reference limits. */
export interface Config {
  /** Most references expanded per message; the rest are listed as not expanded. */
  maxReferences: number
  /** Longest description of one element, in characters. */
  maxCharsPerReference: number
}

export const Config: z<Partial<Config>, Config> = z.object({
  maxReferences: z.natural().min(1).max(64).default(8).description('Most references expanded per message.'),
  maxCharsPerReference: z.natural().min(200).default(2000).description('Longest description of one element, in characters.'),
})

/**
 * Register the pre-step listener.
 * @param ctx - plugin context with `pulseSeq`.
 * @param config - limits.
 */
export function apply(ctx: Context, config: Config): void {
  const seq = ctx.pulseSeq
  const sourceFor = (session: Session) => ({
    latest: seq.current(session),
    revision: (rev: number) => seq.revision(session, rev),
    model: (revision: Parameters<typeof seq.modelOf>[1]) => seq.modelOf(session, revision),
    recipe: async (rev: number) => (await seq.recipe(session, rev)).source,
  })

  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const messages: UserMessage[] = []
    for (const message of decision.messages) {
      messages.push(message)
      if (message.source.kind !== 'user') continue
      const text = message.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
      const context = await referenceContext(text, sourceFor(agent.session), config)
      if (context === undefined) continue
      messages.push(createUserMessage({
        source: {
          kind: 'pulseos-reference', form: 'notice', version: 1, references: context.outcomes,
          summary: boundContextSummary(`Sequence references: ${context.outcomes.map(o => o.id).join(', ')}`),
        },
        content: [{ type: 'text', text: context.text }],
      }))
    }
    return { ...decision, messages }
  }, { prepend: true })
}
