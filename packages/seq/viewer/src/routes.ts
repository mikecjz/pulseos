/** HTTP paths served by the viewer's host face; session routes take `sessionId`, most take `rev`. */
export const STATE_PATH = '/api/pulseos.state'
export const MODEL_PATH = '/api/pulseos.model'
export const RECIPE_PATH = '/api/pulseos.recipe'
export const SEQ_PATH = '/api/pulseos.seq'
export const BUILD_PATH = '/api/pulseos.build'
/** GET: the template catalogue (`SequenceTemplate[]`); takes no `sessionId`. */
export const TEMPLATES_PATH = '/api/pulseos.templates'
/** POST a `.seq` file as the body with `name=<file name>`: returns {@link ReadResult}; takes no `sessionId`. */
export const READ_PATH = '/api/pulseos.read'
/** Largest `.seq` file the viewer reads. */
export const MAX_SEQ_FILE_BYTES = 64 * 1024 * 1024

/** Response of {@link READ_PATH}. */
export type ReadResult =
  | { ok: true; name: string; model: import('@pulseos/seq-protocol').SequenceModel }
  | { ok: false; error: import('@pulseos/seq-protocol').BuildError }

/** Response of {@link STATE_PATH}. */
export interface ViewerState {
  revisions: import('@pulseos/seq-protocol').RevisionRecord[]
  lastFailure: (import('@pulseos/seq-protocol').BuildFailedRecord & { afterRev: number | null }) | null
  building: boolean
  profile: { id: string; title: string; limits: Record<string, number> }
}
