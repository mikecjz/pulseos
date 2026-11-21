/**
 * Viewer navigation as data: which element to select and which time window to show. The model asks
 * for a place in the sequence by element ID, by loop indices or by k-space line (`ky`/`kz`), the
 * host resolves it here against a sequence model, records the answer as a `plugin:pulseos/navigate`
 * record, and the browser viewer applies it. Nothing parses chat text.
 */

import { ElementIdError } from './ids.ts'
import type { SequenceEvent, SequenceModel } from './model.ts'
import { resolve } from './resolve.ts'

export const NAVIGATE_RECORD = 'plugin:pulseos/navigate'

/** Time window in seconds. */
export interface TimeWindow { t0: number; t1: number }

/** What the viewer should do: show revision `rev`, select `select` and frame `view`. */
export interface NavigateRecord {
  rev: number
  select: string
  view: TimeWindow
  /** One line saying what is shown, e.g. "ky = 0 (slice=0, line=32)". */
  label: string
}

/** How much to show around the target. */
export type NavigationFrame = 'tr' | 'block'

/** A place in the sequence. Give `element`, or any combination of `loop`, `ky` and `kz`. */
export interface NavigationRequest {
  /** An element ID; role-level IDs go to the first instance. */
  element?: string
  /** Loop indices, e.g. `{ slice: 0, line: 12 }`; loops not named match any index. */
  loop?: Record<string, number>
  /** Phase-encode k-space line in units of Δky, 0 = k-space centre. */
  ky?: number
  /** Partition/slice-encode k-space line in units of Δkz, 0 = k-space centre. */
  kz?: number
  /** Role to select inside the matched repetition; default: the role that holds the ADC. */
  role?: string
  /** `tr` (default) shows the whole repetition, `block` only the selected block. */
  frame?: NavigationFrame
}

export type NavigationResult =
  | { ok: true; select: string; view: TimeWindow; label: string; matches: number }
  | { ok: false; reason: string }

/** One repetition (blocks sharing loop indices) with the k-space line its ADC samples. */
export interface KspaceRepetition {
  loop: Record<string, number>
  start: number
  end: number
  /** Role of the block holding the first ADC, or null for a repetition without ADC. */
  adcRole: string | null
  /** Integer k-space line index, or null when there is no ADC or no line spacing could be derived. */
  ky: number | null
  kz: number | null
}

function loopKey(loop: Record<string, number>): string {
  return Object.entries(loop).map(([name, index]) => `${name}=${index}`).join(',')
}

/** Area (1/m) of a gradient event played after time `from`. Trapezoids exactly, other shapes by time fraction. */
function areaAfter(event: SequenceEvent, from: number): number {
  if (event.kind !== 'trap' && event.kind !== 'grad') return 0
  const end = event.t0 + event.duration
  if (from <= event.t0) return event.area
  if (from >= end) return 0
  if (event.kind === 'grad') return event.area * (end - from) / event.duration
  // Trapezoid: integrate amplitude from `from` to the end; amplitude is mT/m, scale by area / full integral.
  const { rise, flat, fall } = event
  const full = rise / 2 + flat + fall / 2
  if (full <= 0) return 0
  const tail = (t: number): number => { // integral of the unit-amplitude shape from t to the end
    if (t <= rise) return (rise - t * t / rise) / 2 + flat + fall / 2
    if (t <= rise + flat) return rise + flat - t + fall / 2
    const s = rise + flat + fall - t
    return fall <= 0 ? 0 : s * s / (2 * fall)
  }
  return event.area * tail(from - event.t0) / full
}

function lineIndices(areas: (number | null)[]): (number | null)[] {
  const known = areas.filter((a): a is number => a !== null)
  const scale = Math.max(1, ...known.map(Math.abs))
  const tolerance = scale * 1e-6
  const sorted = [...new Set(known)].toSorted((a, b) => a - b)
  let step = Infinity
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!
    if (gap > tolerance) step = Math.min(step, gap)
  }
  return areas.map((area) => {
    if (area === null) return null
    if (Math.abs(area) <= tolerance) return 0
    return Number.isFinite(step) ? Math.round(area / step) : null
  })
}

/**
 * The k-space line each repetition samples: the phase-encode (y) and partition (z) gradient area from
 * the centre of the latest excitation pulse to the centre of the repetition's first ADC, divided by
 * the smallest spacing between distinct areas. Line 0 is the k-space centre.
 * @param model - the sequence model.
 * @returns repetitions in time order.
 */
export function kspaceRepetitions(model: SequenceModel): KspaceRepetition[] {
  const blocks = model.blocks.toSorted((a, b) => a.t0 - b.t0)
  const reps: KspaceRepetition[] = []
  let key = ''
  for (const block of blocks) {
    const k = loopKey(block.loop)
    if (reps.length === 0 || k !== key) {
      key = k
      reps.push({ loop: block.loop, start: block.t0, end: block.t0 + block.duration, adcRole: null, ky: null, kz: null })
    } else {
      reps.at(-1)!.end = block.t0 + block.duration
    }
  }

  const events = model.events.toSorted((a, b) => a.t0 - b.t0)
  const adcs = events.filter(e => e.kind === 'adc')
  const pulses = events.filter(e => e.kind === 'rf')
  const excitations = pulses.some(e => e.kind === 'rf' && e.use === 'excitation') ? pulses.filter(e => e.kind === 'rf' && e.use === 'excitation') : pulses
  const areaY: (number | null)[] = reps.map(() => null)
  const areaZ: (number | null)[] = reps.map(() => null)
  let r = 0
  for (const adc of adcs) {
    while (r < reps.length - 1 && adc.t0 >= reps[r]!.end) r++
    const rep = reps[r]!
    if (rep.adcRole !== null || adc.t0 < rep.start) continue
    rep.adcRole = adc.role
    const centre = adc.t0 + adc.duration / 2
    const excitation = excitations.findLast(e => e.t0 + e.duration / 2 <= centre)
    const from = excitation === undefined ? 0 : excitation.t0 + excitation.duration / 2
    let y = 0
    let z = 0
    for (const e of events) {
      if (e.t0 >= centre) break
      if (e.t0 + e.duration <= from || e.t0 + e.duration > centre) continue
      if (e.channel === 'gy') y += areaAfter(e, from)
      else if (e.channel === 'gz') z += areaAfter(e, from)
    }
    areaY[r] = y
    areaZ[r] = z
  }
  const ky = lineIndices(areaY)
  const kz = lineIndices(areaZ)
  reps.forEach((rep, i) => { rep.ky = ky[i]!; rep.kz = kz[i]! })
  return reps
}

function pad(t0: number, t1: number): TimeWindow {
  const span = Math.max(t1 - t0, 20e-6)
  return { t0: t0 - span * 0.05, t1: t1 + span * 0.05 }
}

function range(values: (number | null)[]): string {
  const known = values.filter((v): v is number => v !== null)
  return known.length === 0 ? 'none' : `${Math.min(...known)}..${Math.max(...known)}`
}

/**
 * Resolve a navigation request against a model.
 * @param model - the sequence model.
 * @param request - where to go.
 * @returns the element to select and the window to show, or why there is no such place.
 */
export function findNavigation(model: SequenceModel, request: NavigationRequest): NavigationResult {
  const frame = request.frame ?? 'tr'
  if (request.element !== undefined) {
    if (request.loop !== undefined || request.ky !== undefined || request.kz !== undefined) {
      return { ok: false, reason: 'give either element or loop/ky/kz, not both' }
    }
    let found
    try {
      found = resolve(model, request.element)
    } catch (error) {
      if (error instanceof ElementIdError) return { ok: false, reason: error.message }
      throw error
    }
    if (found.status === 'gone') return { ok: false, reason: `${request.element} does not exist: ${found.reason}` }
    let t0: number
    let t1: number
    let loop: Record<string, number> | null = null
    switch (found.kind) {
      case 'param':
      case 'marker': {
        const marker = model.markers.find(m => m.id === found.id)
        if (marker === undefined) return { ok: false, reason: `${found.id} has no position in time` }
        t0 = marker.start ?? marker.t; t1 = marker.t
        return { ok: true, select: found.id, view: pad(t0, t1), label: found.id, matches: 1 }
      }
      case 'block': t0 = found.element.t0; t1 = t0 + found.element.duration; loop = found.element.loop; break
      case 'event': t0 = found.element.t0; t1 = t0 + found.element.duration; loop = found.element.loop; break
      case 'role': {
        const block = model.blocks.find(b => b.role === found.element.role)!
        t0 = block.t0; t1 = t0 + block.duration; loop = block.loop; break
      }
      case 'role-event': {
        const event = model.events.find(e => e.role === found.element.role && e.name === found.element.name)!
        t0 = event.t0; t1 = t0 + event.duration; loop = event.loop; break
      }
    }
    if (frame === 'tr' && loop !== null) {
      const rep = kspaceRepetitions(model).find(x => loopKey(x.loop) === loopKey(loop))
      if (rep !== undefined) { t0 = rep.start; t1 = rep.end }
    }
    return { ok: true, select: found.id, view: pad(t0, t1), label: found.id, matches: 1 }
  }

  if (request.loop === undefined && request.ky === undefined && request.kz === undefined) {
    return { ok: false, reason: 'give element, loop, ky or kz' }
  }
  const loopNames = model.loops.map(l => l.name)
  for (const [name, index] of Object.entries(request.loop ?? {})) {
    const loop = model.loops.find(l => l.name === name)
    if (loop === undefined) return { ok: false, reason: `there is no loop "${name}"; loops are ${loopNames.join(', ') || 'none'}` }
    if (!Number.isInteger(index) || index < 0 || index >= loop.size) return { ok: false, reason: `loop ${name} runs 0..${loop.size - 1}, not ${index}` }
  }
  const reps = kspaceRepetitions(model)
  const matches = reps.filter(rep =>
    Object.entries(request.loop ?? {}).every(([name, index]) => rep.loop[name] === index)
    && (request.ky === undefined || rep.ky === request.ky)
    && (request.kz === undefined || rep.kz === request.kz))
  const first = matches[0]
  if (first === undefined) {
    const parts = []
    if (request.ky !== undefined) parts.push(`ky lines are ${range(reps.map(x => x.ky))}`)
    if (request.kz !== undefined) parts.push(`kz lines are ${range(reps.map(x => x.kz))}`)
    return { ok: false, reason: `no repetition matches${parts.length > 0 ? `; ${parts.join(', ')}` : ''}` }
  }
  const role = request.role ?? first.adcRole ?? model.blocks.find(b => loopKey(b.loop) === loopKey(first.loop))?.role
  const block = model.blocks.find(b => b.role === role && loopKey(b.loop) === loopKey(first.loop))
  if (block === undefined) return { ok: false, reason: `role "${role}" has no block at ${loopKey(first.loop)}` }
  const select = block.id
  const k = [first.ky === null ? null : `ky = ${first.ky}`, first.kz === null || request.kz === undefined ? null : `kz = ${first.kz}`].filter(x => x !== null)
  const label = `${k.length > 0 ? `${k.join(', ')} ` : ''}(${loopKey(first.loop) || 'no loop'})`
  const view = frame === 'tr' ? pad(first.start, first.end) : pad(block.t0, block.t0 + block.duration)
  return { ok: true, select, view, label, matches: matches.length }
}
