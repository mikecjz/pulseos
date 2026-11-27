/** Per-session state of the Simulation page, shared by the page and the `[[sim:...]]` chips. */
import type { SequenceModel } from '@pulseos/seq-protocol'
import { decodePart, type SimPart, type SimRunRecord } from '@pulseos/sim-protocol'
import { SIM_CANCEL_PATH, SIM_CONNECT_PATH, SIM_RESULT_PATH, SIM_RUN_PATH, SIM_STATE_PATH, SHAPE_HEADER, type SimPanelState } from '../routes.ts'

/** The sequence viewer's model route (`@pulseos/seq-viewer`); used to name ADC events. */
const MODEL_PATH = '/api/pulseos.model'

export type SimView = 'image' | 'kspace' | 'signal'

/** A decoded complex array: interleaved re/im, row-major `[rows, cols]`. */
export interface ComplexArray { rows: number; cols: number; data: Float32Array }

export interface SimSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly error: string | null
  readonly state: SimPanelState | null
  /** Run shown; null follows the latest run. */
  readonly pinnedRun: string | null
  readonly view: SimView
  readonly phase: boolean
  /** Picker values; null means "latest" / the configured default. */
  readonly pick: { rev: number | null; phantom: string | null; engine: string | null }
  readonly toast: string | null
  /** Bumped whenever a part or ADC name list finishes loading. */
  readonly loaded: number
}

const INITIAL: SimSnapshot = {
  status: 'loading', error: null, state: null, pinnedRun: null, view: 'image', phase: false,
  pick: { rev: null, phantom: null, engine: null }, toast: null, loaded: 0,
}

function api(path: string, params: Record<string, string | number>): string {
  const url = new URL(path.slice(1), document.baseURI)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  return url.toString()
}

async function failure(response: Response): Promise<Error> {
  let message = `HTTP ${response.status}`
  try {
    message = ((await response.json()) as { error?: string }).error ?? message
  } catch {
    // The body was not JSON; keep the status line.
  }
  return new Error(message)
}

/**
 * The run a snapshot shows: the pinned run, else the latest run.
 * @param snap - the snapshot.
 * @returns the run, or null before the first run.
 */
export function shownRun(snap: SimSnapshot): SimRunRecord | null {
  const runs = snap.state?.runs ?? []
  return (snap.pinnedRun === null ? runs.at(-1) : runs.find(r => r.id === snap.pinnedRun)) ?? null
}

/**
 * Phantom choices for an engine: its listed phantoms once it has started, else the default and
 * every phantom used so far.
 * @param state - panel state.
 * @param engine - engine ID.
 * @returns phantom IDs and titles.
 */
export function phantomChoices(state: SimPanelState, engine: string): { id: string; title: string }[] {
  const listed = state.engines.find(e => e.id === engine)?.phantoms
  if (listed !== null && listed !== undefined) return listed.filter(p => p.id !== 'broken').map(p => ({ id: p.id, title: p.title }))
  const ids = [...new Set([state.defaults.phantom, ...state.runs.filter(r => r.engine === engine).map(r => r.phantom)])]
  return ids.map(id => ({ id, title: id }))
}

export class SimStore {
  private snapshot: SimSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private readonly parts = new Map<string, Promise<ComplexArray>>()
  private readonly settled = new Map<string, ComplexArray>()
  private readonly adcNames = new Map<number, string[]>()
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private inflight: Promise<void> | undefined
  private expectUntil = 0
  private disposed = false

  constructor(readonly sessionId: string) {}

  getSnapshot = (): SimSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1 && this.snapshot.status === 'loading') void this.refresh()
    return () => { this.listeners.delete(listener) }
  }

  private set(patch: Partial<SimSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.refreshTimer)
    clearInterval(this.pollTimer)
    this.listeners.clear()
  }

  /**
   * A job is about to start (the model called sim_run): poll until it shows up, for a while.
   * @param ms - how long to keep polling without a job.
   */
  expectJob(ms = 8000): void {
    this.expectUntil = Date.now() + ms
    this.scheduleRefresh(50)
  }

  /** Coalesce bursts of session events into one refresh. */
  scheduleRefresh(delayMs = 200): void {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => { void this.refresh() }, delayMs)
  }

  refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async load(): Promise<void> {
    let state: SimPanelState
    try {
      const response = await fetch(api(SIM_STATE_PATH, { sessionId: this.sessionId }), { credentials: 'same-origin' })
      if (!response.ok) throw await failure(response)
      state = await response.json() as SimPanelState
    } catch (error) {
      if (!this.disposed) this.set({ status: 'unavailable', error: (error as Error).message })
      return
    }
    if (this.disposed) return
    this.set({ state, status: 'ready', error: null })
    // Progress is in memory on the host: poll while a job is queued or running, or an engine is starting.
    clearInterval(this.pollTimer)
    if (state.jobs.length > 0 || state.engines.some(e => e.status === 'starting') || Date.now() < this.expectUntil) this.pollTimer = setInterval(() => { void this.refresh() }, 400)
  }

  /**
   * One stored array of a result, cached by key.
   * @param resultKey - run result key.
   * @param part - array name.
   * @returns the decoded array.
   */
  part(resultKey: string, part: SimPart): Promise<ComplexArray> {
    const id = `${resultKey}/${part}`
    let pending = this.parts.get(id)
    if (pending === undefined) {
      pending = (async () => {
        const response = await fetch(api(SIM_RESULT_PATH, { key: resultKey, part }), { credentials: 'same-origin' })
        if (!response.ok) throw await failure(response)
        const shape = (response.headers.get(SHAPE_HEADER) ?? '').split(',').map(Number)
        const [rows = 0, cols = 1] = shape
        return { rows, cols, data: decodePart(await response.arrayBuffer(), { shape }) }
      })()
      pending.then((array) => { this.settled.set(id, array); this.set({ loaded: this.snapshot.loaded + 1 }) }, (error: Error) => {
        this.parts.delete(id)
        this.set({ toast: `Could not load the ${part}: ${error.message}` })
      })
      this.parts.set(id, pending)
    }
    return pending
  }

  /** A loaded array, or undefined (and a load is started). */
  loadedPart(resultKey: string, part: SimPart): ComplexArray | undefined {
    const found = this.settled.get(`${resultKey}/${part}`)
    if (found === undefined) void this.part(resultKey, part).catch(() => undefined)
    return found
  }

  /**
   * Element IDs of the ADC events of a revision, in acquisition order (index = signal row).
   * @param rev - revision.
   * @returns the IDs, or undefined while loading or when the model is unavailable.
   */
  adcIds(rev: number): string[] | undefined {
    const found = this.adcNames.get(rev)
    if (found !== undefined) return found
    this.adcNames.set(rev, [])
    void (async () => {
      try {
        const response = await fetch(api(MODEL_PATH, { sessionId: this.sessionId, rev }), { credentials: 'same-origin' })
        if (!response.ok) return
        const model = await response.json() as SequenceModel
        this.adcNames.set(rev, model.events.filter(e => e.kind === 'adc').toSorted((a, b) => a.t0 - b.t0).map(e => e.id))
        this.set({ loaded: this.snapshot.loaded + 1 })
      } catch {
        // Without the model the signal view shows ADC indices only.
      }
    })()
    return undefined
  }

  pin(runId: string | null): void { this.set({ pinnedRun: runId }) }
  setView(view: SimView): void { this.set({ view }) }
  togglePhase(): void { this.set({ phase: !this.snapshot.phase }) }
  setPick(patch: Partial<SimSnapshot['pick']>): void { this.set({ pick: { ...this.snapshot.pick, ...patch } }) }
  dismissToast(): void { this.set({ toast: null }) }

  /** Show the latest run of a revision and phantom (a chip click); false when there is none. */
  async reveal(rev: number, phantom: string, engine: string | null): Promise<boolean> {
    await this.refresh()
    const run = this.snapshot.state?.runs.findLast(r => r.rev === rev && r.phantom === phantom && (engine === null || r.engine === engine))
    if (run === undefined) {
      this.set({ toast: `No simulation of r${rev} on ${phantom} in this session` })
      return false
    }
    const latest = this.snapshot.state!.runs.at(-1)
    this.set({ pinnedRun: run.id === latest?.id ? null : run.id })
    return true
  }

  /** Queue a simulation with the picker values (or explicit overrides). */
  async simulate(overrides: Partial<SimSnapshot['pick']> = {}): Promise<void> {
    const pick = { ...this.snapshot.pick, ...overrides }
    const params: Record<string, string | number> = { sessionId: this.sessionId }
    if (pick.rev !== null) params.rev = pick.rev
    if (pick.phantom !== null) params.phantom = pick.phantom
    if (pick.engine !== null) params.engine = pick.engine
    try {
      const response = await fetch(api(SIM_RUN_PATH, params), { method: 'POST', credentials: 'same-origin' })
      if (!response.ok) throw await failure(response)
      // Follow the new run when it lands.
      this.set({ pinnedRun: null })
    } catch (error) {
      this.set({ toast: `Simulation request failed: ${(error as Error).message}` })
    } finally {
      await this.refresh()
    }
  }

  async cancel(id?: string): Promise<void> {
    try {
      const response = await fetch(api(SIM_CANCEL_PATH, { sessionId: this.sessionId, ...(id === undefined ? {} : { id }) }), { method: 'POST', credentials: 'same-origin' })
      if (!response.ok) throw await failure(response)
    } catch (error) {
      this.set({ toast: `Cancel failed: ${(error as Error).message}` })
    } finally {
      await this.refresh()
    }
  }

  /** Start an engine (Retry on an unavailable engine). */
  async connect(engine: string): Promise<void> {
    const request = fetch(api(SIM_CONNECT_PATH, { engine }), { method: 'POST', credentials: 'same-origin' })
    this.scheduleRefresh(50)
    await request.catch(() => undefined)
    await this.refresh()
  }
}
