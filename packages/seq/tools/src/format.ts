/** Plain-text renderings of sequence state for tool results. */
import {
  resolve, type ParamElement, type ResolvedElement, type RevisionRecord, type SequenceEvent, type SequenceModel,
} from '@pulseos/seq-protocol'

/**
 * Format a duration in seconds with an adaptive unit.
 * @param seconds - value in s.
 * @returns e.g. `4.2 ms`, `210 us`.
 */
export function time(seconds: number): string {
  const abs = Math.abs(seconds)
  if (abs === 0) return '0 ms'
  if (abs < 1e-3) return `${round(seconds * 1e6)} us`
  if (abs < 1) return `${round(seconds * 1e3)} ms`
  return `${round(seconds)} s`
}

function round(value: number): string {
  return Number(value.toPrecision(4)).toString()
}

/**
 * Format a parameter value with a display unit and its SI value.
 * @param p - parameter element.
 * @returns e.g. `4.2 ms (0.0042 s)`.
 */
export function paramValue(p: Pick<ParamElement, 'value' | 'unit'>): string {
  if (p.unit === 's') return `${time(p.value)} (${p.value} s)`
  if (p.unit === 'm') return `${round(p.value * 1e3)} mm (${p.value} m)`
  return p.unit === '' ? String(p.value) : `${p.value} ${p.unit}`
}

/**
 * Recipe lines with line numbers.
 * @param source - recipe source.
 * @param from - first line (1-based), default 1.
 * @param to - last line, default end.
 * @returns numbered lines.
 */
export function numbered(source: string, from = 1, to?: number): string {
  const lines = source.split('\n')
  const last = Math.min(to ?? lines.length, lines.length)
  const width = String(last).length
  return lines.slice(from - 1, last).map((line, i) => `${String(from + i).padStart(width)} | ${line}`).join('\n')
}

/**
 * One-line revision summary.
 * @param r - revision record.
 * @returns e.g. `r3 (param, model): TE 4.2 → 5 ms; timing OK`.
 */
export function revisionLine(r: RevisionRecord): string {
  const timing = r.timing.ok ? 'timing OK' : `${r.timing.errors} timing error(s)`
  return `r${r.rev} (${r.kind}, ${r.author}): ${r.cause}; ${timing}`
}

function eventProperties(e: SequenceEvent): string {
  const common = `starts ${time(e.t0)} (delay ${time(e.delay)} in its block), duration ${time(e.duration)}`
  switch (e.kind) {
    case 'rf': return `${common}, flip angle ${round(e.flipAngle)} deg, peak ${round(e.peak)} uT, phase offset ${round(e.phaseOffset)} rad, frequency offset ${round(e.freqOffset)} Hz`
    case 'trap': return `${common}, trapezoid amplitude ${round(e.amplitude)} mT/m, rise ${time(e.rise)}, flat ${time(e.flat)}, fall ${time(e.fall)}, area ${round(e.area)} 1/m`
    case 'grad': return `${common}, arbitrary gradient, peak ${round(e.peak)} mT/m, area ${round(e.area)} 1/m`
    case 'adc': return `${common}, ${e.numSamples} samples, dwell ${time(e.dwell)}, phase offset ${round(e.phaseOffset)} rad`
  }
}

const VARYING_KEYS = ['amplitude', 'area', 'phaseOffset', 'freqOffset', 'flipAngle', 'duration', 'delay', 'numSamples'] as const

function varying(events: SequenceEvent[]): string[] {
  const notes: string[] = []
  for (const key of VARYING_KEYS) {
    const values = events.map(e => (e as unknown as Record<string, unknown>)[key]).filter((v): v is number => typeof v === 'number')
    if (values.length < 2) continue
    const min = Math.min(...values)
    const max = Math.max(...values)
    if (max - min > 1e-12 * Math.max(1, Math.abs(max))) notes.push(`${key} varies from ${round(min)} to ${round(max)}`)
  }
  return notes
}

/**
 * Describe a resolved element for the model.
 * @param model - the model it was resolved in.
 * @param resolved - the resolved element.
 * @param recipeSource - recipe source, for the emitting lines.
 * @returns multi-line description.
 */
export function describeElement(model: SequenceModel, resolved: ResolvedElement & { id: string }, recipeSource: string): string {
  const lines: string[] = []
  const roleSource = (roleName: string): void => {
    const role = model.roles.find(r => r.role === roleName)
    if (role?.sourceSpan) {
      lines.push(`Emitted by recipe lines ${role.sourceSpan.startLine}-${role.sourceSpan.endLine}:`, numbered(recipeSource, role.sourceSpan.startLine, role.sourceSpan.endLine))
    }
  }
  switch (resolved.kind) {
    case 'param': {
      const p = resolved.element
      lines.push(`Parameter ${resolved.id} = ${paramValue(p)} — ${p.description}. Default ${paramValue({ value: p.default, unit: p.unit })}; range ${p.min ?? '-inf'} to ${p.max ?? 'inf'}${p.integer ? ', integer' : ''}.`)
      const marker = model.markers.find(m => m.id === resolved.id)
      if (marker) lines.push(`Marker in the first repetition: ${marker.start === null ? '' : `from ${time(marker.start)} `}to ${time(marker.t)}.`)
      break
    }
    case 'marker':
      lines.push(`Marker ${resolved.id}: ${resolved.element.start === null ? '' : `from ${time(resolved.element.start)} `}to ${time(resolved.element.t)}.`)
      break
    case 'role': {
      const r = resolved.element
      lines.push(`Role ${resolved.id}: ${r.instances} block(s). Events: ${r.events.map(e => `${e.name} (${e.channel}) ${e.id}`).join(', ') || 'none (delay only)'}.`)
      const blocks = model.blocks.filter(b => b.role === r.role)
      lines.push(`First block starts ${time(blocks[0]!.t0)}, duration ${time(blocks[0]!.duration)}.`)
      if (r.formerly) lines.push(`Renamed from "${r.formerly}".`)
      roleSource(r.role)
      break
    }
    case 'role-event': {
      const e = resolved.element
      const instances = model.events.filter(x => x.role === e.role && x.name === e.name)
      lines.push(`Event ${resolved.id} on channel ${e.channel}: ${e.instances} instance(s).`)
      lines.push(`First instance (${instances[0]!.id}): ${eventProperties(instances[0]!)}.`)
      const notes = varying(instances)
      lines.push(notes.length === 0 ? 'All instances have the same content.' : `Across instances: ${notes.join('; ')}.`)
      roleSource(e.role)
      break
    }
    case 'block': {
      const b = resolved.element
      lines.push(`Block ${resolved.id} (pulseq block ${b.index}): starts ${time(b.t0)}, duration ${time(b.duration)}.`)
      for (const e of model.events.filter(x => x.block === b.index)) lines.push(`  ${e.id}: ${eventProperties(e)}`)
      roleSource(b.role)
      break
    }
    case 'event':
      lines.push(`Event ${resolved.id} on channel ${resolved.element.channel}: ${eventProperties(resolved.element)}.`)
      roleSource(resolved.element.role)
      break
  }
  const errors = model.timing.errors.filter(err => err.ids.some(id => id === resolved.id || id.startsWith(`${resolved.id}@`) || id.startsWith(`${resolved.id}.`)))
  if (errors.length > 0) lines.push(`Timing errors: ${errors.slice(0, 5).map(err => `${err.ids[0]}: ${err.message}`).join('; ')}`)
  return lines.join('\n')
}

/**
 * Overview of a model for `seq_status`.
 * @param model - the model.
 * @param revision - its revision.
 * @param count - number of revisions in the session.
 * @returns multi-line overview.
 */
export function overview(model: SequenceModel, revision: RevisionRecord, count: number): string {
  const lines = [
    `Sequence ${model.seq} at r${revision.rev} of ${count} (${revisionLine(revision)}).`,
    `Scanner profile ${model.profile.id}; total duration ${time(model.duration)}; ${model.blocks.length} blocks; loops: ${model.loops.map(l => `${l.name} x${l.size}`).join(', ') || 'none'}.`,
    'Parameters (set them in SI units, e.g. seconds and metres):',
    ...Object.entries(model.params).map(([name, p]) => `  ${p.id}: ${name} = ${paramValue(p)} — ${p.description}`),
    'Roles in time order within one repetition:',
    ...model.roles.map(r => `  ${r.id} x${r.instances}${r.sourceSpan ? ` (recipe line ${r.sourceSpan.startLine})` : ''}: ${r.events.map(e => `${e.id} [${e.channel}]`).join(', ') || 'delay only'}`),
    `Markers: ${model.markers.map(m => `${m.id} ${m.start === null ? '' : `${time(m.start)} -> `}${time(m.t)}`).join('; ') || 'none'}.`,
    model.timing.ok ? 'Timing check: OK.' : `Timing check: ${model.timing.errors.length} error(s); call seq_check_timing for details.`,
    'Instance IDs append loop indices, e.g. <role>.<event>@slice=0,line=12.',
  ]
  return lines.join('\n')
}

/**
 * Timing report.
 * @param model - the model.
 * @param limit - maximum errors listed.
 * @returns multi-line report.
 */
export function timingReport(model: SequenceModel, limit = 20): string {
  if (model.timing.ok) return 'Timing check: OK (pypulseq check_timing found no errors).'
  const lines = [`Timing check: ${model.timing.errors.length} error(s).`]
  for (const error of model.timing.errors.slice(0, limit)) lines.push(`  ${error.ids[0] ?? `block ${error.block}`}: ${error.errorType} ${error.event}.${error.field} — ${error.message}`)
  if (model.timing.errors.length > limit) lines.push(`  ... ${model.timing.errors.length - limit} more`)
  return lines.join('\n')
}

/**
 * Resolve-or-throw helper.
 * @param model - model.
 * @param id - element ID.
 * @returns the resolution.
 */
export function resolveIn(model: SequenceModel, id: string) {
  return resolve(model, id)
}
