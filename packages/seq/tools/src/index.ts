/**
 * Model-facing PulseOS sequence tools. Every tool works on the calling agent's session; builds
 * go through `ctx.pulseSeq` and are recorded as revisions in the session log.
 * @module @pulseos/seq-tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { createTwoFilesPatch } from 'diff'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, ToolArgsError, ToolContextUnavailableError, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import {
  ElementIdError, findNavigation, NAVIGATE_RECORD, paramChanges, resolve, roleDiff,
  type NavigateRecord, type NavigationFrame, type SequenceModel,
} from '@pulseos/seq-protocol'
import type { BuildOutcome, PulseSeqService } from '@pulseos/seq-service'
import { describeElement, numbered, overview, revisionLine, time, timingReport } from './format.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** The model moved the viewer: select an element and show a time window. */
    'plugin:pulseos/navigate': NavigateRecord
  }
}

export const name = 'pulseos-seq-tools'
export const inject = ['tools', 'pulseSeq']

/** A build requested by a tool failed; the current revision is unchanged. */
export class SequenceBuildError extends HarnessError {
  constructor(message: string) {
    super(message, 'PULSEOS_BUILD_FAILED')
    this.name = 'SequenceBuildError'
  }
}

/** The tool needs a built sequence or an existing revision. */
export class SequenceStateError extends HarnessError {
  constructor(message: string) {
    super(message, 'PULSEOS_NO_SEQUENCE')
    this.name = 'SequenceStateError'
  }
}

const CITE = 'Cite sequence elements in replies as [[<element id>]], e.g. [[gre2d:excitation.rf]], so the user can click them.'
const CAUSE = { type: 'string', required: true, description: 'One short line saying why, e.g. "shorten TE to 3.5 ms". Shown in the revision list.' } as const
const REV = { type: 'integer', description: 'Revision number; omit for the latest revision.' } as const
const TEXT = { type: 'string' } as const

function sessionOf(exec: ToolRunContext, tool: string): Session {
  if (exec.agent === undefined) throw new ToolContextUnavailableError(`${tool} requires an owning agent session`)
  return exec.agent.session
}

async function modelAt(seq: PulseSeqService, session: Session, rev: number | undefined, signal: AbortSignal) {
  const revision = rev === undefined ? seq.current(session) : seq.revision(session, rev)
  if (revision === undefined) {
    throw new SequenceStateError(rev === undefined
      ? 'No sequence has been built in this session yet. Call seq_build first.'
      : `There is no revision r${rev}.`)
  }
  return { revision, model: await seq.modelOf(session, revision, signal) }
}

function buildResult(outcome: BuildOutcome, previous: SequenceModel | null): string {
  if (!outcome.ok) {
    const { error } = outcome
    throw new SequenceBuildError(`Build failed (${error.kind}${error.line === null ? '' : `, recipe line ${error.line}`}): ${error.message}. The current revision is unchanged.`)
  }
  const { revision, model } = outcome
  const lines = [`Built ${revisionLine(revision)}. Duration ${time(model.duration)}, ${model.blocks.length} blocks.`]
  if (previous !== null) {
    const changes = paramChanges(previous, model)
    if (changes.length > 0) lines.push(`Parameter changes: ${changes.map(c => `${c.id} ${c.before} -> ${c.after}${c.unit ? ` ${c.unit}` : ''}`).join(', ')}.`)
    const roles = roleDiff(previous, model)
    const changed = [...roles.changed.map(r => `${model.seq}:${r} changed`), ...roles.added.map(r => `${model.seq}:${r} added`),
      ...roles.removed.map(r => `${model.seq}:${r} removed`), ...roles.renamed.map(r => `renamed ${r}`)]
    lines.push(changed.length === 0 ? 'No role changed content.' : `Roles: ${changed.join(', ')}.`)
  }
  lines.push(timingReport(model, 10))
  if (model.warnings?.length) lines.push(`Warnings: ${model.warnings.join('; ')}`)
  return lines.join('\n')
}

/**
 * Register the sequence tools.
 * @param ctx - plugin context with `tools` and `pulseSeq`.
 */
export function apply(ctx: Context): void {
  const seq = ctx.pulseSeq
  const text = { schema: TEXT, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }

  ctx.tools.register(defineTool({
    name: 'seq_status',
    description: `Show the session's current pulse sequence: revision, parameters with units and IDs, roles with their event IDs, timing markers and the timing check. Call it first to learn element IDs. ${CITE}`,
    parameters: {},
    output: text,
    async execute(_args, exec) {
      const session = sessionOf(exec, 'seq_status')
      const state = seq.state(session)
      const current = state.revisions.at(-1)
      if (current === undefined) return 'No sequence has been built in this session yet. Call seq_build to build the default 2D GRE recipe.'
      const lines = [overview(await seq.modelOf(session, current, exec.signal), current, state.revisions.length)]
      if (state.lastFailure !== null && state.lastFailure.afterRev === current.rev) lines.push(`The last build attempt failed: ${state.lastFailure.error.message}`)
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'seq_build',
    description: 'Build a sequence from a bundled recipe as a new revision: the first build of a session, or starting over. Bundled recipes: gre2d (2D spoiled gradient echo).',
    parameters: {
      recipe: { type: 'string', description: 'Bundled recipe name; default gre2d.' },
      params: { type: 'array', description: 'Optional parameter overrides in SI units.', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, value: { type: 'number', required: true } } } },
      cause: CAUSE,
    },
    output: text,
    async execute(args, exec) {
      const session = sessionOf(exec, 'seq_build')
      const current = seq.current(session)
      const previous = current === undefined ? null : await seq.modelOf(session, current, exec.signal)
      const params = Object.fromEntries((args.params ?? []).map(p => [p.name, p.value]))
      return buildResult(await seq.build(session, { cause: args.cause, author: 'model', bundled: args.recipe ?? 'gre2d', params }, exec.signal), previous)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'seq_set_params',
    description: 'Change sequence parameters and rebuild as a new revision. Values are in SI units (seconds, metres, degrees for angles); see seq_status for names, units and ranges.',
    parameters: {
      params: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, value: { type: 'number', required: true } } } },
      cause: CAUSE,
    },
    output: text,
    async execute(args, exec) {
      const session = sessionOf(exec, 'seq_set_params')
      if (args.params.length === 0) throw new ToolArgsError(['params must name at least one parameter'])
      const { model } = await modelAt(seq, session, undefined, exec.signal)
      const params = Object.fromEntries(args.params.map(p => [p.name, p.value]))
      return buildResult(await seq.build(session, { cause: args.cause, author: 'model', params }, exec.signal), model)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'seq_get_element',
    description: `Describe one sequence element by ID: timing, amplitudes, how it varies across repetitions, timing errors and the recipe lines that emit it. IDs look like gre2d:excitation.rf, gre2d:readout.adc@slice=0,line=12 or gre2d:param.TE. ${CITE}`,
    parameters: { id: { type: 'string', required: true, description: 'Element ID.' }, rev: REV },
    output: text,
    async execute(args, exec) {
      const session = sessionOf(exec, 'seq_get_element')
      const { revision, model } = await modelAt(seq, session, args.rev, exec.signal)
      let resolved
      try {
        resolved = resolve(model, args.id)
      } catch (error) {
        if (error instanceof ElementIdError) throw new ToolArgsError([error.message])
        throw error
      }
      if (resolved.status === 'gone') return `${args.id} does not exist at r${revision.rev}: ${resolved.reason}.`
      const { source } = await seq.recipe(session, revision.rev)
      return `At r${revision.rev}:\n${describeElement(model, resolved, source)}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'seq_get_recipe',
    description: 'Show the recipe source (Python, pypulseq) with line numbers. Edit it with seq_edit_recipe.',
    parameters: { rev: REV },
    output: text,
    async execute(args, exec) {
      const session = sessionOf(exec, 'seq_get_recipe')
      const { source, hash, bundled } = await seq.recipe(session, args.rev)
      const label = args.rev === undefined ? (seq.current(session) === undefined ? `bundled recipe ${bundled} (not built yet)` : `r${seq.current(session)!.rev}`) : `r${args.rev}`
      return `Recipe at ${label} (${hash}):\n${numbered(source)}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'seq_edit_recipe',
    description: 'Edit the current recipe and rebuild as a new revision. Give exact text replacements (each old_text must occur exactly once in the current recipe) or a complete new source. Recipes may import only pulseos_seq, pypulseq, numpy and math. Add blocks with b.block("<role>", <event>=<pypulseq event>, ...) inside b.loop(...) for repetitions; to rename a role keep references working with b.block("<new>", formerly="<old>", ...). A failed build leaves the current revision unchanged.',
    parameters: {
      edits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { old_text: { type: 'string', required: true }, new_text: { type: 'string', required: true } } } },
      source: { type: 'string', description: 'Complete new recipe source, instead of edits.' },
      cause: CAUSE,
    },
    output: text,
    async execute(args, exec) {
      const session = sessionOf(exec, 'seq_edit_recipe')
      if ((args.edits === undefined) === (args.source === undefined)) throw new ToolArgsError(['give exactly one of edits or source'])
      const current = seq.current(session)
      const previous = current === undefined ? null : await seq.modelOf(session, current, exec.signal)
      let source = args.source ?? (await seq.recipe(session)).source
      for (const [index, edit] of (args.edits ?? []).entries()) {
        const count = source.split(edit.old_text).length - 1
        if (count !== 1) throw new ToolArgsError([`edits[${index}].old_text occurs ${count} times in the current recipe; it must occur exactly once`])
        source = source.replace(edit.old_text, () => edit.new_text)
      }
      return buildResult(await seq.build(session, { cause: args.cause, author: 'model', recipeSource: source }, exec.signal), previous)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'seq_check_timing',
    description: `Timing check of a revision (pypulseq check_timing) with the element IDs of each error. ${CITE}`,
    parameters: { rev: REV },
    output: text,
    async execute(args, exec) {
      const { revision, model } = await modelAt(seq, sessionOf(exec, 'seq_check_timing'), args.rev, exec.signal)
      return `At r${revision.rev}: ${timingReport(model)}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'seq_diff',
    description: 'Compare two revisions: parameter changes, role changes and the recipe diff.',
    parameters: { from: { type: 'integer', required: true, description: 'Base revision.' }, to: REV },
    output: text,
    async execute(args, exec) {
      const session = sessionOf(exec, 'seq_diff')
      const base = await modelAt(seq, session, args.from, exec.signal)
      const head = await modelAt(seq, session, args.to, exec.signal)
      const changes = paramChanges(base.model, head.model)
      const roles = roleDiff(base.model, head.model)
      const lines = [`r${base.revision.rev} -> r${head.revision.rev}`,
        `Parameters: ${changes.length === 0 ? 'unchanged' : changes.map(c => `${c.id} ${c.before} -> ${c.after}`).join(', ')}`,
        `Roles changed: ${roles.changed.join(', ') || 'none'}; added: ${roles.added.join(', ') || 'none'}; removed: ${roles.removed.join(', ') || 'none'}; renamed: ${roles.renamed.join(', ') || 'none'}`]
      if (base.revision.recipeHash !== head.revision.recipeHash) {
        const [a, b] = await Promise.all([seq.recipe(session, base.revision.rev), seq.recipe(session, head.revision.rev)])
        lines.push('Recipe diff:', createTwoFilesPatch('recipe.py', 'recipe.py', a.source, b.source, `r${base.revision.rev}`, `r${head.revision.rev}`))
      } else {
        lines.push('Recipe: unchanged')
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'seq_restore',
    description: 'Rebuild an earlier revision\'s recipe and parameters as a new revision (history is never rewritten).',
    parameters: { rev: { type: 'integer', required: true, description: 'Revision to restore.' }, cause: CAUSE },
    output: text,
    async execute(args, exec) {
      const session = sessionOf(exec, 'seq_restore')
      const { model } = await modelAt(seq, session, undefined, exec.signal)
      if (seq.revision(session, args.rev) === undefined) throw new SequenceStateError(`There is no revision r${args.rev}.`)
      return buildResult(await seq.build(session, { cause: args.cause, author: 'model', restore: args.rev }, exec.signal), model)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'seq_show',
    description: 'Navigate the user\'s sequence viewer: select an element and show it. Use it when the user asks to go to, show or zoom to part of the sequence. '
      + 'Give element (an element ID), or any of loop, ky and kz. ky/kz are k-space lines counted from the centre in units of the line spacing (ky = 0 is the k-space centre line, negative below it); '
      + 'loop indices are acquisition order (line = 0 is the first line acquired). Without role, the block holding the ADC is selected. '
      + `${CITE}`,
    parameters: {
      element: { type: 'string', description: 'Element ID to show, e.g. gre2d:readout@slice=0,line=12 or gre2d:excitation.rf.' },
      loop: { type: 'array', description: 'Loop indices to match, e.g. [{"name":"line","index":0}]; see seq_status for loop names.', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, index: { type: 'integer', required: true } } } },
      ky: { type: 'integer', description: 'Phase-encode k-space line, 0 = centre.' },
      kz: { type: 'integer', description: 'Partition/slice-encode k-space line, 0 = centre.' },
      role: { type: 'string', description: 'Role to select within the matched repetition, e.g. prephase; default: the ADC block.' },
      frame: { type: 'string', enum: ['tr', 'block'], description: 'tr (default) shows the whole repetition; block only the selected block.' },
      rev: REV,
    },
    output: text,
    async execute(args, exec) {
      const session = sessionOf(exec, 'seq_show')
      const { revision, model } = await modelAt(seq, session, args.rev, exec.signal)
      const result = findNavigation(model, {
        ...(args.element === undefined ? {} : { element: args.element }),
        ...(args.loop === undefined ? {} : { loop: Object.fromEntries(args.loop.map(l => [l.name, l.index])) }),
        ...(args.ky === undefined ? {} : { ky: args.ky }),
        ...(args.kz === undefined ? {} : { kz: args.kz }),
        ...(args.role === undefined ? {} : { role: args.role }),
        ...(args.frame === undefined ? {} : { frame: args.frame as NavigationFrame }),
      })
      if (!result.ok) throw new ToolArgsError([`at r${revision.rev}: ${result.reason}`])
      appendPluginRecord(session, NAVIGATE_RECORD, { rev: revision.rev, select: result.select, view: result.view, label: result.label })
      const more = result.matches > 1 ? ` ${result.matches} repetitions match; this is the first. Narrow it with loop.` : ''
      return `The viewer shows [[${result.select}]] at r${revision.rev}: ${result.label}, ${time(result.view.t0)} to ${time(result.view.t1)}.${more}`
    },
  }))
}
