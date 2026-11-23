/**
 * The sequence model (schema `pulseos.sequence/1`) produced by `pulseos_seq.model`.
 * Units: time s, gradient mT/m, RF magnitude uT, phase rad, flip angle deg.
 */

export const SEQUENCE_MODEL_SCHEMA = 'pulseos.sequence/1'

/** Recipe source lines that emitted a role. */
export interface SourceSpan { startLine: number; endLine: number }

export type Channel = 'rf' | 'gx' | 'gy' | 'gz' | 'adc'

export interface ParamElement {
  id: string
  value: number
  default: number
  unit: string
  description: string
  min: number | null
  max: number | null
  integer: boolean
  fingerprint: string
}

export interface RoleEvent { name: string; channel: Channel; id: string; fingerprint: string; instances: number }

export interface RoleElement {
  role: string
  id: string
  events: RoleEvent[]
  sourceSpan: SourceSpan | null
  formerly: string | null
  instances: number
  fingerprint: string
}

export interface BlockElement {
  id: string
  index: number
  role: string
  loop: Record<string, number>
  t0: number
  duration: number
  fingerprint: string
}

interface EventBase {
  id: string
  block: number
  role: string
  name: string
  channel: Channel
  loop: Record<string, number>
  t0: number
  delay: number
  duration: number
  fingerprint: string
}

export interface RfEvent extends EventBase {
  kind: 'rf'
  shape: string
  peak: number
  peakUnit: 'uT'
  flipAngle: number
  freqOffset: number
  phaseOffset: number
  use: string
}

export interface TrapEvent extends EventBase {
  kind: 'trap'
  amplitude: number
  amplitudeUnit: 'mT/m'
  rise: number
  flat: number
  fall: number
  area: number
  areaUnit: '1/m'
}

export interface GradEvent extends EventBase {
  kind: 'grad'
  shape: string
  peak: number
  peakUnit: 'mT/m'
  area: number
  areaUnit: '1/m'
}

export interface AdcEvent extends EventBase {
  kind: 'adc'
  numSamples: number
  dwell: number
  freqOffset: number
  phaseOffset: number
}

export type SequenceEvent = RfEvent | TrapEvent | GradEvent | AdcEvent

export interface Shape { t: number[]; value: number[]; phase?: number[] }

/** A timing marker; its fingerprint covers the marked interval, not its position. */
export interface MarkerElement { id: string; name: string; t: number; start: number | null; loop: Record<string, number>; fingerprint: string }

export interface TimingError {
  block: number
  ids: string[]
  errorType: string
  event: string
  field: string
  message: string
}

export interface ScannerProfileSummary { id: string; title: string; limits: Record<string, number> }

export interface SequenceModel {
  schema: typeof SEQUENCE_MODEL_SCHEMA
  seq: string
  recipe: { hash: string; file: string | null }
  pypulseqVersion: string
  profile: ScannerProfileSummary
  params: Record<string, ParamElement>
  duration: number
  loops: { name: string; size: number }[]
  roles: RoleElement[]
  blocks: BlockElement[]
  events: SequenceEvent[]
  markers: MarkerElement[]
  shapes: Record<string, Shape>
  timing: { ok: boolean; errors: TimingError[] }
  warnings?: string[]
  /** How the build was sandboxed; null when it ran unconfined. Models built before macOS support lack `mechanism`. */
  confinement?: { mechanism?: 'landlock' | 'seatbelt'; landlockAbi?: number } | null
}
