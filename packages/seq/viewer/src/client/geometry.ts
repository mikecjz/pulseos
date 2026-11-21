/** Pure geometry over a sequence model: per-channel event index, waveform points, ticks. */
import type { BlockElement, Channel, SequenceEvent, SequenceModel } from '@pulseos/seq-protocol'

export const CHANNELS: readonly Channel[] = ['rf', 'gz', 'gy', 'gx', 'adc']
export const GRADIENTS: readonly Channel[] = ['gz', 'gy', 'gx']

/** Time window in seconds. */
export interface Viewport { t0: number; t1: number }

/** One repetition: the blocks sharing one combination of loop indices. */
export interface Repetition { start: number; end: number; loop: Record<string, number>; label: string }

function upperBound<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (key(items[mid]!) <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Event end time (end of the active part). */
export function eventEnd(event: SequenceEvent): number {
  return event.t0 + event.duration
}

/** Index of one model for fast viewport queries. */
export class SequenceIndex {
  readonly byChannel: Record<Channel, SequenceEvent[]>
  readonly blocks: BlockElement[]
  readonly repetitions: Repetition[]
  readonly gradMax: number
  readonly rfMax: number
  readonly duration: number
  private readonly maxSpan: Record<Channel, number>

  constructor(readonly model: SequenceModel) {
    this.byChannel = { rf: [], gx: [], gy: [], gz: [], adc: [] }
    for (const event of model.events) this.byChannel[event.channel].push(event)
    this.maxSpan = { rf: 0, gx: 0, gy: 0, gz: 0, adc: 0 }
    for (const channel of CHANNELS) {
      this.byChannel[channel] = this.byChannel[channel].toSorted((a, b) => a.t0 - b.t0)
      this.maxSpan[channel] = Math.max(0, ...this.byChannel[channel].map(e => e.duration))
    }
    this.blocks = model.blocks.toSorted((a, b) => a.t0 - b.t0)
    this.duration = model.duration
    let grad = 0
    let rf = 0
    for (const event of model.events) {
      if (event.kind === 'trap') grad = Math.max(grad, Math.abs(event.amplitude))
      else if (event.kind === 'grad') grad = Math.max(grad, Math.abs(event.peak))
      else if (event.kind === 'rf') rf = Math.max(rf, event.peak)
    }
    this.gradMax = grad
    this.rfMax = rf
    this.repetitions = repetitions(this.blocks)
  }

  /**
   * Events of one channel overlapping a window.
   * @param channel - channel.
   * @param t0 - window start.
   * @param t1 - window end.
   * @returns events in time order.
   */
  eventsIn(channel: Channel, t0: number, t1: number): SequenceEvent[] {
    const list = this.byChannel[channel]
    const start = upperBound(list, t0 - this.maxSpan[channel], e => e.t0)
    const out: SequenceEvent[] = []
    for (let i = Math.max(0, start - 1); i < list.length && list[i]!.t0 <= t1; i++) {
      if (eventEnd(list[i]!) >= t0) out.push(list[i]!)
    }
    return out
  }

  /**
   * Blocks overlapping a window.
   * @param t0 - window start.
   * @param t1 - window end.
   * @returns blocks in time order.
   */
  blocksIn(t0: number, t1: number): BlockElement[] {
    const start = Math.max(0, upperBound(this.blocks, t0, b => b.t0) - 1)
    const out: BlockElement[] = []
    for (let i = start; i < this.blocks.length && this.blocks[i]!.t0 <= t1; i++) {
      const block = this.blocks[i]!
      if (block.t0 + block.duration >= t0) out.push(block)
    }
    return out
  }

  /**
   * Repetition containing a time.
   * @param t - time.
   * @returns the repetition index, clamped to the sequence.
   */
  repetitionAt(t: number): number {
    return Math.min(this.repetitions.length - 1, Math.max(0, upperBound(this.repetitions, t, r => r.start) - 1))
  }

  /**
   * Waveform value of a channel at a time (RF in uT, gradients in mT/m, ADC 1 when sampling).
   * @param channel - channel.
   * @param t - time.
   * @returns the value, 0 between events.
   */
  valueAt(channel: Channel, t: number): number {
    for (const event of this.eventsIn(channel, t, t)) {
      const points = waveform(event, this.model)
      if (points === null) return channel === 'adc' && t >= event.t0 && t <= eventEnd(event) ? 1 : 0
      return interpolate(points.t, points.v, t)
    }
    return 0
  }
}

function repetitions(blocks: readonly BlockElement[]): Repetition[] {
  const out: Repetition[] = []
  let key = ''
  for (const block of blocks) {
    const k = JSON.stringify(block.loop)
    if (k !== key || out.length === 0) {
      key = k
      const label = Object.entries(block.loop).map(([n, i]) => `${n}=${i}`).join(',')
      out.push({ start: block.t0, end: block.t0 + block.duration, loop: block.loop, label })
    } else {
      out.at(-1)!.end = block.t0 + block.duration
    }
  }
  return out
}

/** Absolute-time waveform points of one event, or null for ADC (drawn as a bar). */
export interface Points { t: number[]; v: number[] }

/**
 * Waveform of an event in absolute time.
 * @param event - the event.
 * @param model - model holding the shapes.
 * @returns points (RF magnitude uT, gradient mT/m), or null for ADC.
 */
export function waveform(event: SequenceEvent, model: SequenceModel): Points | null {
  switch (event.kind) {
    case 'trap': {
      const a = event.t0
      return { t: [a, a + event.rise, a + event.rise + event.flat, a + event.rise + event.flat + event.fall], v: [0, event.amplitude, event.amplitude, 0] }
    }
    case 'grad':
    case 'rf': {
      const shape = model.shapes[event.shape]
      if (shape === undefined) return { t: [event.t0, eventEnd(event)], v: [0, 0] }
      return { t: shape.t.map(x => event.t0 + x), v: shape.value }
    }
    case 'adc':
      return null
  }
}

const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x))

/**
 * RF phase (rad, wrapped to [-pi, pi]) including the event's phase offset.
 * @param event - RF event.
 * @param model - model holding the shapes.
 * @returns points, or null for non-RF events.
 */
export function rfPhase(event: SequenceEvent, model: SequenceModel): Points | null {
  if (event.kind !== 'rf') return null
  const shape = model.shapes[event.shape]
  if (shape?.phase === undefined) return null
  return { t: shape.t.map(x => event.t0 + x), v: shape.phase.map(p => wrap(p + event.phaseOffset)) }
}

/**
 * Linear interpolation, 0 outside the samples.
 * @param t - sample times (ascending).
 * @param v - sample values.
 * @param x - query time.
 * @returns interpolated value.
 */
export function interpolate(t: readonly number[], v: readonly number[], x: number): number {
  if (t.length === 0 || x < t[0]! || x > t.at(-1)!) return 0
  const i = Math.max(1, upperBound(t, x, y => y))
  if (i >= t.length) return v.at(-1)!
  const t0 = t[i - 1]!
  const t1 = t[i]!
  return t1 === t0 ? v[i]! : v[i - 1]! + (v[i]! - v[i - 1]!) * (x - t0) / (t1 - t0)
}

/**
 * Tick positions for a time window: a 1-2-5 step giving roughly `target` ticks.
 * @param view - window.
 * @param target - wanted tick count.
 * @returns tick times and the step.
 */
export function ticks(view: Viewport, target: number): { values: number[]; step: number } {
  const span = Math.max(view.t1 - view.t0, 1e-9)
  const raw = span / Math.max(1, target)
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map(m => m * power).find(s => s >= raw) ?? 10 * power
  const values: number[] = []
  for (let x = Math.ceil(view.t0 / step) * step; x <= view.t1 + step * 1e-9; x += step) values.push(Number(x.toPrecision(12)))
  return { values, step }
}

/**
 * Format a time for axis labels with a unit chosen from the tick step.
 * @param t - time in s.
 * @param step - tick step in s.
 * @returns e.g. `4.2 ms`.
 */
export function formatTime(t: number, step = Math.abs(t)): string {
  if (step >= 1) return `${Number(t.toFixed(3))} s`
  if (step >= 1e-3) return `${Number((t * 1e3).toFixed(step >= 1e-2 ? 1 : 2))} ms`
  return `${Number((t * 1e6).toFixed(1))} us`
}

/**
 * Format a duration with an adaptive unit and fixed precision.
 * @param seconds - duration.
 * @returns e.g. `1.00 ms`, `210 us`.
 */
export function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds)
  if (abs === 0) return '0'
  if (abs < 1e-3) return `${(seconds * 1e6).toPrecision(3)} us`
  if (abs < 1) return `${(seconds * 1e3).toFixed(2)} ms`
  return `${seconds.toFixed(3)} s`
}

/**
 * Clamp and normalize a viewport to the sequence, keeping at least `minSpan`.
 * @param view - requested window.
 * @param duration - sequence duration.
 * @param minSpan - smallest window.
 * @returns a valid window.
 */
export function clampView(view: Viewport, duration: number, minSpan = 2e-6): Viewport {
  let span = Math.min(Math.max(view.t1 - view.t0, minSpan), duration)
  if (!(span > 0)) span = duration || 1
  let t0 = Math.min(Math.max(view.t0, 0), Math.max(0, duration - span))
  if (!Number.isFinite(t0)) t0 = 0
  return { t0, t1: t0 + span }
}
