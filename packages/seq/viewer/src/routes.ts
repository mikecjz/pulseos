/** HTTP paths served by the viewer's host face; all take `sessionId`, most take `rev`. */
export const STATE_PATH = '/api/pulseos.state'
export const MODEL_PATH = '/api/pulseos.model'
export const RECIPE_PATH = '/api/pulseos.recipe'
export const SEQ_PATH = '/api/pulseos.seq'
export const BUILD_PATH = '/api/pulseos.build'

/** Response of {@link STATE_PATH}. */
export interface ViewerState {
  revisions: import('@pulseos/seq-protocol').RevisionRecord[]
  lastFailure: (import('@pulseos/seq-protocol').BuildFailedRecord & { afterRev: number | null }) | null
  building: boolean
  profile: { id: string; title: string; limits: Record<string, number> }
}
