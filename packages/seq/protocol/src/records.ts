/**
 * Durable session records written by the sequence service (DSH plugin records, `ignorable`), and
 * the `[[<element id>]]` / `[[<element id>|r<rev>]]` reference token used in chat.
 */

import { ElementIdError, parseElementId } from './ids.ts'
import type { ParamChange, RoleDiff } from './resolve.ts'

export const RECIPE_RECORD = 'plugin:pulseos/recipe'
export const REVISION_RECORD = 'plugin:pulseos/revision'
export const BUILD_FAILED_RECORD = 'plugin:pulseos/build-failed'

/** Who asked for a build. */
export type Author = 'model' | 'user'

/** A recipe version. Its full source is in the session log, so a session can be rebuilt from it. */
export interface RecipeRecord {
  recipeHash: string
  seq: string
  source: string
  origin: 'bundled' | 'edit'
  bundled: string | null
  parentHash: string | null
  /** Unified diff from the parent recipe; null for a bundled start. */
  diff: string | null
  cause: string
  author: Author
}

/**
 * `init`: first build in the session. `param`: parameters changed. `code`: the recipe changed.
 * `restore`: an older revision's recipe and parameters were built again.
 */
export type RevisionKind = 'init' | 'param' | 'code' | 'restore'

/** One successful build. Revisions are numbered 1, 2, ... per session and never rewritten. */
export interface RevisionRecord {
  rev: number
  parent: number | null
  kind: RevisionKind
  cause: string
  author: Author
  seq: string
  recipeHash: string
  params: Record<string, number>
  paramsHash: string
  profile: { id: string; hash: string }
  pypulseqVersion: string
  /** Content address of the stored sequence model JSON. */
  modelHash: string
  timing: { ok: boolean; errors: number }
  duration: number
  paramDelta: ParamChange[]
  roleDiff: RoleDiff | null
  /** Unified recipe diff from the parent revision; set for `code` revisions. */
  recipeDiff: string | null
}

/** A build that produced no revision; the current revision is unchanged. */
export interface BuildFailedRecord {
  cause: string
  kind: RevisionKind
  author: Author
  recipeHash: string
  params: Record<string, number>
  error: BuildError
}

/** Error categories: recipe `check`, `params`, `build`, `runtime`, `profile`, `io`, `sandbox`, or the runner process (`process`, `timeout`). */
export interface BuildError { kind: string; message: string; line: number | null; traceback?: string | null }

/** One `[[...]]` reference found in text. */
export interface ReferenceToken {
  raw: string
  start: number
  end: number
  id: string
  rev: number | null
  /** False when `id` is not a well-formed element ID. */
  valid: boolean
}

/** Sequence name reserved for simulation references; never an element ID prefix. */
export const SIM_PREFIX = 'sim'

const TOKEN_RE = /\[\[([A-Za-z][A-Za-z0-9_]*:[^\]|\s]+)(?:\|r(\d+))?\]\]/g

/**
 * Find reference tokens in text.
 * @param text - chat text.
 * @returns tokens in order of appearance.
 */
export function findReferences(text: string): ReferenceToken[] {
  const tokens: ReferenceToken[] = []
  for (const match of text.matchAll(TOKEN_RE)) {
    const id = match[1]!
    // `sim:` is reserved for simulation references (`[[sim:r3/tubes]]`, @pulseos/sim-protocol).
    if (id.startsWith(`${SIM_PREFIX}:`)) continue
    let valid = true
    try {
      parseElementId(id)
    } catch (error) {
      if (!(error instanceof ElementIdError)) throw error
      valid = false
    }
    tokens.push({ raw: match[0], start: match.index, end: match.index + match[0].length, id, rev: match[2] === undefined ? null : Number(match[2]), valid })
  }
  return tokens
}

/**
 * Format a reference token.
 * @param id - element ID.
 * @param rev - revision the reference points at; omitted for "latest".
 * @returns `[[id]]` or `[[id|r<rev>]]`.
 */
export function formatReference(id: string, rev?: number | null): string {
  return rev === undefined || rev === null ? `[[${id}]]` : `[[${id}|r${rev}]]`
}
