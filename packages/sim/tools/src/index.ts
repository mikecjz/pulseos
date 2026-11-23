/**
 * Model-facing simulation tools, and `[[sim:r<rev>/<phantom>]]` references in user messages.
 * - `sim_run` simulates a revision on a phantom through `ctx.pulseSim` and returns a compact summary.
 * - `sim_summary` summarizes a recorded run, compared with the previous run on the same phantom.
 * - Before a model step, a user message containing `[[sim:...]]` tokens is followed by one context
 *   message (source kind `pulseos-sim-reference`) with each referenced run's summary.
 * @module @pulseos/sim-tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage, HarnessError, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool, ToolContextUnavailableError, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@pulseos/seq-service'
import { findSimReferences } from '@pulseos/sim-protocol'
import { SimRequestError, type PulseSimService } from '@pulseos/sim-service'
import { findRun, previousRun, summarize } from './format.ts'

export { findRun, previousRun, runReference, summarize } from './format.ts'

/** Source of the injected simulation reference context. */
export interface PulseosSimReferenceSource {
  kind: 'pulseos-sim-reference'
  form: 'notice'
  summary: string
  version: 1
  references: { raw: string; resolved: boolean }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'pulseos-sim-reference': PulseosSimReferenceSource
  }
}

export const name = 'pulseos-sim-tools'
export const inject = ['tools', 'pulseSim', 'pulseSeq']

/** A simulation requested by a tool failed. */
export class SimulationFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'PULSEOS_SIM_FAILED')
    this.name = 'SimulationFailedError'
  }
}

/** The tool needs a built sequence, a recorded run or a known engine. */
export class SimulationStateError extends HarnessError {
  constructor(message: string) {
    super(message, 'PULSEOS_SIM_STATE')
    this.name = 'SimulationStateError'
  }
}

const CITE = 'Cite runs in replies as [[sim:r<rev>/<phantom>]] so the user can open them in the Simulation panel.'
const REV = { type: 'integer', description: 'Revision number; omit for the latest revision.' } as const

function sessionOf(exec: ToolRunContext, tool: string): Session {
  if (exec.agent === undefined) throw new ToolContextUnavailableError(`${tool} requires an owning agent session`)
  return exec.agent.session
}

function summaryOf(ctx: Context, sim: PulseSimService, session: Session, run: Parameters<typeof summarize>[0]): string {
  const runs = sim.state(session).runs
  const params = ctx.pulseSeq.revision(session, run.rev)?.params
  const previous = previousRun(runs, run)
  return summarize(run, { defaultEngine: sim.defaults.engine, ...(params === undefined ? {} : { params }), ...(previous === undefined ? {} : { previous }) })
}

/**
 * Register the tools and the reference listener.
 * @param ctx - plugin context with `tools`, `pulseSim` and `pulseSeq`.
 */
export function apply(ctx: Context): void {
  const sim = ctx.pulseSim
  const text = { schema: { type: 'string' } as const, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }

  ctx.tools.register(defineTool({
    name: 'sim_run',
    description: 'Simulate the pulse sequence on a digital phantom (MR physics simulation of the built .seq file) and get the image contrast: mean signal per tissue, contrast ratios and the change from the previous simulation. '
      + 'Phantoms: brainweb-axial (brain slice: gm, wm, csf, fat) and tubes (six vials with distinct T1/T2). The result also opens in the user\'s Simulation panel. '
      + `Build the sequence first (seq_build). ${CITE}`,
    parameters: {
      rev: REV,
      phantom: { type: 'string', description: 'Phantom ID; default brainweb-axial.' },
      engine: { type: 'string', description: 'Engine ID; default mrzero.' },
      noise: { type: 'number', description: 'Complex Gaussian noise as a fraction of the peak signal (0-1); default 0.' },
      resolution: { type: 'integer', description: 'Simulation grid per side (8-256); default the sequence matrix.' },
      cause: { type: 'string', required: true, description: 'One short line saying why, e.g. "check GM/WM contrast at flip 30".' },
    },
    output: text,
    async execute(args, exec) {
      const session = sessionOf(exec, 'sim_run')
      const settings = { ...(args.noise === undefined ? {} : { noise: args.noise }), ...(args.resolution === undefined ? {} : { resolution: args.resolution }) }
      let job
      try {
        job = sim.run(session, {
          ...(args.rev === undefined ? {} : { rev: args.rev }),
          ...(args.phantom === undefined ? {} : { phantom: args.phantom }),
          ...(args.engine === undefined ? {} : { engine: args.engine }),
          settings, author: 'model', cause: args.cause,
        }, exec.signal)
      } catch (error) {
        if (error instanceof SimRequestError) throw new SimulationStateError(`${error.message}.`)
        throw error
      }
      const outcome = await job.done
      if (!outcome.ok) {
        const { error } = outcome.failure
        throw new SimulationFailedError(`Simulation failed (${error.kind}): ${error.message}`)
      }
      return summaryOf(ctx, sim, session, outcome.run)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sim_summary',
    description: `Summarize a recorded simulation (no new run): per-tissue signal, contrast ratios and the change from the previous run on the same phantom. Without arguments, the latest run. ${CITE}`,
    parameters: {
      rev: REV,
      phantom: { type: 'string', description: 'Phantom ID; default any.' },
    },
    output: text,
    async execute(args, exec) {
      const session = sessionOf(exec, 'sim_summary')
      const runs = sim.state(session).runs
      const run = runs.findLast(r => (args.rev === undefined || r.rev === args.rev) && (args.phantom === undefined || r.phantom === args.phantom))
      if (run === undefined) {
        throw new SimulationStateError(runs.length === 0 ? 'No simulation has run in this session yet. Call sim_run.' : 'No recorded simulation matches; call sim_run for that revision and phantom.')
      }
      const failure = sim.state(session).lastFailure
      const note = failure !== null && failure.afterRuns === runs.length ? `\nThe latest simulation attempt (r${failure.rev}, ${failure.phantom}) failed: ${failure.error.message}` : ''
      return summaryOf(ctx, sim, session, run) + note
    },
  }))

  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const messages: UserMessage[] = []
    for (const message of decision.messages) {
      messages.push(message)
      if (message.source.kind !== 'user') continue
      const content = message.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
      const seen = new Set<string>()
      const tokens = findSimReferences(content).filter(t => !seen.has(t.raw) && seen.add(t.raw)).slice(0, 8)
      if (tokens.length === 0) continue
      const runs = sim.state(agent.session).runs
      const parts = tokens.map((token) => {
        const run = findRun(runs, token)
        return { raw: token.raw, run, text: run === undefined ? `${token.raw} — unresolved: no recorded simulation of r${token.rev} on ${token.phantom}${token.engine ? ` with ${token.engine}` : ''}.` : `${token.raw} —\n${summaryOf(ctx, sim, agent.session, run)}` }
      })
      messages.push(createUserMessage({
        source: {
          kind: 'pulseos-sim-reference', form: 'notice', version: 1, references: parts.map(p => ({ raw: p.raw, resolved: p.run !== undefined })),
          summary: boundContextSummary(`Simulation references: ${parts.map(p => p.raw).join(', ')}`),
        },
        content: [{ type: 'text', text: ['<simulation-references>', 'The user\'s message refers to these simulation results; each [[sim:...]] token means the run described here.', ...parts.map(p => p.text), '</simulation-references>'].join('\n\n') }],
      }))
    }
    return { ...decision, messages }
  }, { prepend: true })

}
