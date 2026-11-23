/**
 * Session records of the simulation service (DSH plugin records) and the `[[sim:...]]` reference.
 */
import type { SimGrid, SimSettings, SimStats } from './contract.ts'

export const SIM_RUN_RECORD = 'plugin:pulseos/sim-run'
export const SIM_FAILED_RECORD = 'plugin:pulseos/sim-failed'

/** Who asked for a simulation. */
export type SimAuthor = 'model' | 'user'

/** One finished simulation; its arrays are stored under `dataDir/sim/<hex of resultKey>/`. */
export interface SimRunRecord {
  /** Run ID, unique in the session. */
  id: string
  rev: number
  seq: string
  engine: string
  engineVersion: string
  phantom: string
  settings: SimSettings
  /** `sha256:<hex>` over seq, engine, phantom and settings. */
  resultKey: string
  seqHash: string
  device: string
  /** True when the result came from the cache without running the engine. */
  cached: boolean
  grid: SimGrid
  stats: SimStats
  timing: Record<string, number>
  warnings: string[]
  author: SimAuthor
  cause: string
}

/** Failure kinds: engine `unavailable`, `input` (the engine rejected the sequence or settings), `engine`, `timeout`, `cancelled`, `superseded`. */
export type SimFailureKind = 'unavailable' | 'input' | 'engine' | 'timeout' | 'cancelled' | 'superseded'

/** A simulation that produced no result. */
export interface SimFailedRecord {
  id: string
  rev: number
  engine: string
  phantom: string
  settings: SimSettings
  author: SimAuthor
  cause: string
  error: { kind: SimFailureKind; message: string }
}

/** One `[[sim:r<rev>/<phantom>]]` or `[[sim:r<rev>/<phantom>@<engine>]]` token. */
export interface SimReferenceToken {
  raw: string
  start: number
  end: number
  rev: number
  phantom: string
  engine: string | null
}

const SIM_TOKEN_RE = /\[\[sim:r(\d+)\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:@([A-Za-z0-9][A-Za-z0-9_-]*))?\]\]/g

/**
 * Find simulation reference tokens.
 * @param text - chat text.
 * @returns tokens in order of appearance.
 */
export function findSimReferences(text: string): SimReferenceToken[] {
  return [...text.matchAll(SIM_TOKEN_RE)].map(m => ({
    raw: m[0], start: m.index, end: m.index + m[0].length, rev: Number(m[1]), phantom: m[2]!, engine: m[3] ?? null,
  }))
}

/**
 * Format a simulation reference.
 * @param rev - revision.
 * @param phantom - phantom ID.
 * @param engine - engine ID; omitted for the default engine.
 * @returns the token.
 */
export function formatSimReference(rev: number, phantom: string, engine?: string | null): string {
  return `[[sim:r${rev}/${phantom}${engine ? `@${engine}` : ''}]]`
}
