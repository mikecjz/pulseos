/** HTTP paths served by the simulation panel's host face. */
import type { SimFailedRecord, SimRunRecord } from '@pulseos/sim-protocol'
import type { EngineState, SimJob } from '@pulseos/sim-service'

/** `GET ?sessionId=`: runs, jobs, engines and revisions. */
export const SIM_STATE_PATH = '/api/pulseos.sim.state'
/** `GET ?key=&part=image|kspace|signal|meta`: a stored array (complex64 bytes) or the result metadata. */
export const SIM_RESULT_PATH = '/api/pulseos.sim.result'
/** `POST ?sessionId=&rev=&engine=&phantom=`: queue a simulation; replies `{ id }` at once. */
export const SIM_RUN_PATH = '/api/pulseos.sim.run'
/** `POST ?sessionId=&id=`: cancel a job (all of the session's jobs without `id`). */
export const SIM_CANCEL_PATH = '/api/pulseos.sim.cancel'
/** `POST ?engine=`: start an engine and list its phantoms. */
export const SIM_CONNECT_PATH = '/api/pulseos.sim.connect'

/** Response header carrying a part's shape, e.g. `64,64`. */
export const SHAPE_HEADER = 'x-pulseos-shape'

/** Response of {@link SIM_STATE_PATH}. */
export interface SimPanelState {
  runs: SimRunRecord[]
  lastFailure: (SimFailedRecord & { afterRuns: number }) | null
  jobs: SimJob[]
  engines: EngineState[]
  defaults: { engine: string; phantom: string }
  revisions: { rev: number; seq: string; cause: string }[]
}
