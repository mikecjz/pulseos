/** Per-session viewer state shared by the viewer tab and the reference chips. */
import {
  parseElementId, resolve, resolveBetween, ElementIdError, formatElementId,
  type Channel, type SequenceModel,
} from '@pulseos/seq-protocol'
import { BUILD_PATH, MODEL_PATH, RECIPE_PATH, SEQ_PATH, STATE_PATH, type ViewerState } from '../routes.ts'
import { clampView, SequenceIndex, type Viewport } from './geometry.ts'

/** Chip presentation state for one `[[id|rN]]`. */
export type ChipStatus = 'current' | 'changed' | 'gone' | 'unresolved' | 'loading'
export interface ChipState { status: ChipStatus; channel: Channel | 'param' | 'block' | null; rev: number | null; latest: number | null; detail: string }

export interface ViewerSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly error: string | null
  readonly state: ViewerState | null
  /** Revision shown; null follows the latest. */
  readonly pinnedRev: number | null
  readonly shownRev: number | null
  readonly model: SequenceModel | null
  readonly index: SequenceIndex | null
  readonly view: Viewport | null
  readonly selection: string | null
  readonly hover: { id: string; rev: number | null } | null
  readonly pulse: number
  readonly recipe: { rev: number; source: string } | null
  readonly phaseOpen: boolean
  readonly hidden: readonly Channel[]
  readonly toast: string | null
  readonly flash: { ids: ReadonlySet<string>; at: number } | null
  readonly chips: number
}

const INITIAL: ViewerSnapshot = {
  status: 'loading', error: null, state: null, pinnedRev: null, shownRev: null, model: null, index: null, view: null,
  selection: null, hover: null, pulse: 0, recipe: null, phaseOpen: false, hidden: [], toast: null, flash: null, chips: 0,
}

function api(path: string, params: Record<string, string | number>): string {
  const url = new URL(path.slice(1), document.baseURI)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  return url.toString()
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal: signal ?? null, credentials: 'same-origin' })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      message = ((await response.json()) as { error?: string }).error ?? message
    } catch {
      // The body was not JSON; keep the status line.
    }
    throw new Error(message)
  }
  return await response.json() as T
}

/**
 * Role-level IDs to flash after a live update: events whose content changed, and roles without
 * events (delay blocks) whose duration changed. A role with changed events flashes only those events.
 * @param older - model shown before.
 * @param newer - model shown now.
 * @returns role-level element IDs.
 */
export function changedIds(older: SequenceModel, newer: SequenceModel): Set<string> {
  const ids = new Set<string>()
  const before = new Map(older.roles.flatMap(r => [[r.id, r.fingerprint] as const, ...r.events.map(e => [e.id, e.fingerprint] as const)]))
  for (const role of newer.roles) {
    const events = role.events.filter(e => before.get(e.id) !== e.fingerprint)
    for (const event of events) ids.add(event.id)
    if (role.events.length === 0 && before.get(role.id) !== role.fingerprint) ids.add(role.id)
  }
  return ids
}

export class ViewerStore {
  private snapshot: ViewerSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private readonly models = new Map<number, Promise<SequenceModel>>()
  private readonly settled = new Map<number, SequenceModel>()
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private inflight: Promise<void> | undefined
  private disposed = false

  constructor(readonly sessionId: string) {}

  getSnapshot = (): ViewerSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1 && this.snapshot.status === 'loading') void this.refresh()
    return () => { this.listeners.delete(listener) }
  }

  private set(patch: Partial<ViewerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.refreshTimer)
    clearInterval(this.pollTimer)
    this.listeners.clear()
  }

  /** Coalesce bursts of session events into one refresh. */
  scheduleRefresh(delayMs = 250): void {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => { void this.refresh() }, delayMs)
  }

  /** Reload the revision list and, when the shown revision changed, its model. */
  refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async load(): Promise<void> {
    let state: ViewerState
    try {
      state = await getJson<ViewerState>(api(STATE_PATH, { sessionId: this.sessionId }))
    } catch (error) {
      if (this.disposed) return
      this.set({ status: 'unavailable', error: (error as Error).message })
      return
    }
    if (this.disposed) return
    const previousLatest = this.snapshot.state?.revisions.at(-1)?.rev ?? null
    this.set({ state, status: 'ready', error: null })
    clearInterval(this.pollTimer)
    if (state.building) this.pollTimer = setInterval(() => { void this.refresh() }, 1000)
    const latest = state.revisions.at(-1)?.rev ?? null
    const target = this.snapshot.pinnedRev ?? latest
    if (target !== null && target !== this.snapshot.shownRev) await this.show(target, previousLatest !== null && latest !== previousLatest && this.snapshot.pinnedRev === null)
    if (latest !== previousLatest) this.set({ chips: this.snapshot.chips + 1 })
  }

  /** Model of one revision, cached; rejects when the host cannot provide it. */
  model(rev: number): Promise<SequenceModel> {
    let pending = this.models.get(rev)
    if (pending === undefined) {
      pending = getJson<SequenceModel>(api(MODEL_PATH, { sessionId: this.sessionId, rev }))
      pending.then(model => { this.settled.set(rev, model); this.set({ chips: this.snapshot.chips + 1 }) }, () => { this.models.delete(rev) })
      this.models.set(rev, pending)
    }
    return pending
  }

  private async show(rev: number, live: boolean): Promise<void> {
    const old = this.snapshot.model
    let model: SequenceModel
    try {
      model = await this.model(rev)
    } catch (error) {
      this.set({ toast: `Could not load r${rev}: ${(error as Error).message}` })
      return
    }
    if (this.disposed) return
    const index = new SequenceIndex(model)
    const firstRep = index.repetitions[0]
    const view = this.snapshot.view === null
      ? clampView({ t0: 0, t1: firstRep === undefined ? model.duration : Math.min(model.duration, (index.repetitions[1]?.end ?? firstRep.end)) }, model.duration)
      : clampView(this.snapshot.view, model.duration)
    let selection = this.snapshot.selection
    let toast = this.snapshot.toast
    if (selection !== null && resolve(model, selection).status === 'gone') {
      toast = `${selection.replace(/^[^:]+:/, '')} no longer exists in r${rev}`
      selection = null
    }
    const flash = live && old !== null ? { ids: changedIds(old, model), at: Date.now() } : this.snapshot.flash
    this.set({ model, index, shownRev: rev, view, selection, toast, flash })
  }

  /** Show a revision; null follows the latest. */
  pin(rev: number | null): void {
    this.set({ pinnedRev: rev })
    const latest = this.snapshot.state?.revisions.at(-1)?.rev ?? null
    const target = rev ?? latest
    if (target !== null) void this.show(target, false)
  }

  setView(view: Viewport): void {
    if (this.snapshot.model === null) return
    this.set({ view: clampView(view, this.snapshot.model.duration) })
  }

  select(id: string | null): void {
    this.set({ selection: id, recipe: id === null ? this.snapshot.recipe : this.snapshot.recipe })
  }

  /** Select and frame an element (from a chip click). Gone elements switch to the chip's revision. */
  async reveal(id: string, rev: number | null): Promise<void> {
    await this.refresh()
    const latest = this.snapshot.state?.revisions.at(-1)?.rev ?? null
    if (latest === null) return
    let target = this.snapshot.shownRev ?? latest
    let model = await this.model(target)
    if (resolve(model, id).status === 'gone' && rev !== null) {
      this.pin(rev)
      target = rev
      model = await this.model(rev)
    }
    this.set({ selection: id, pulse: this.snapshot.pulse + 1 })
    this.frame(id, model)
  }

  /** Frame an element with 10% padding (its first instance for role-level IDs). */
  frame(id: string, model = this.snapshot.model): void {
    if (model === null) return
    let found
    try {
      found = resolve(model, id)
    } catch (error) {
      if (error instanceof ElementIdError) return
      throw error
    }
    if (found.status !== 'ok') return
    let start: number
    let end: number
    switch (found.kind) {
      case 'event': start = found.element.t0; end = found.element.t0 + found.element.duration; break
      case 'block': start = found.element.t0; end = found.element.t0 + found.element.duration; break
      case 'role-event': {
        const e = model.events.find(x => x.role === found.element.role && x.name === found.element.name)!
        start = e.t0; end = e.t0 + e.duration; break
      }
      case 'role': {
        const b = model.blocks.find(x => x.role === found.element.role)!
        start = b.t0; end = b.t0 + b.duration; break
      }
      case 'param':
      case 'marker': {
        const m = model.markers.find(x => x.id === id)
        if (m === undefined) return
        start = m.start ?? m.t; end = m.t; break
      }
    }
    const span = Math.max(end - start, 20e-6)
    this.setView({ t0: start - span * 0.6, t1: end + span * 0.6 })
  }

  highlight(id: string | null, rev: number | null = null): void {
    this.set({ hover: id === null ? null : { id, rev }, pulse: id === null ? this.snapshot.pulse : this.snapshot.pulse + 1 })
  }

  togglePhase(): void { this.set({ phaseOpen: !this.snapshot.phaseOpen }) }
  toggleChannel(channel: Channel): void {
    const hidden = this.snapshot.hidden.includes(channel) ? this.snapshot.hidden.filter(c => c !== channel) : [...this.snapshot.hidden, channel]
    this.set({ hidden })
  }
  dismissToast(): void { this.set({ toast: null }) }

  async loadRecipe(rev: number): Promise<void> {
    if (this.snapshot.recipe?.rev === rev) return
    try {
      const recipe = await getJson<{ rev: number; source: string }>(api(RECIPE_PATH, { sessionId: this.sessionId, rev }))
      this.set({ recipe: { rev, source: recipe.source } })
    } catch (error) {
      this.set({ toast: `Could not load the recipe of r${rev}: ${(error as Error).message}` })
    }
  }

  seqUrl(rev: number): string {
    return api(SEQ_PATH, { sessionId: this.sessionId, rev })
  }

  async buildDefault(): Promise<void> {
    this.set({ state: this.snapshot.state === null ? null : { ...this.snapshot.state, building: true } })
    try {
      const response = await fetch(api(BUILD_PATH, { sessionId: this.sessionId }), { method: 'POST', credentials: 'same-origin' })
      if (!response.ok && response.status !== 422) this.set({ toast: `Build request failed: HTTP ${response.status}` })
    } finally {
      await this.refresh()
    }
  }

  /**
   * Chip state for a reference: resolved against its own revision and compared with the latest.
   * Triggers model loads as needed; subscribers are notified when they settle.
   * @param id - element ID text.
   * @param rev - pinned revision, or null for the latest.
   * @returns the presentation state.
   */
  chipState(id: string, rev: number | null): ChipState {
    let parsed
    try {
      parsed = parseElementId(id)
    } catch (error) {
      if (!(error instanceof ElementIdError)) throw error
      return { status: 'unresolved', channel: null, rev, latest: null, detail: 'not a valid element ID' }
    }
    if (this.snapshot.status === 'loading') { void this.refresh(); return { status: 'loading', channel: null, rev, latest: null, detail: '' } }
    const latest = this.snapshot.state?.revisions.at(-1)?.rev ?? null
    if (latest === null) return { status: 'unresolved', channel: null, rev, latest, detail: 'no sequence has been built yet' }
    const own = rev ?? latest
    if (!this.snapshot.state!.revisions.some(r => r.rev === own)) return { status: 'unresolved', channel: null, rev, latest, detail: `there is no revision r${own}` }
    const ownModel = this.settled.get(own)
    const latestModel = this.settled.get(latest)
    if (ownModel === undefined || latestModel === undefined) {
      if (ownModel === undefined) void this.model(own).catch(() => undefined)
      if (latestModel === undefined) void this.model(latest).catch(() => undefined)
      return { status: 'loading', channel: null, rev, latest, detail: '' }
    }
    const found = resolve(ownModel, parsed)
    if (found.status === 'gone') return { status: 'unresolved', channel: null, rev, latest, detail: found.reason }
    const channel = found.kind === 'event' || found.kind === 'role-event' ? found.element.channel
      : found.kind === 'param' || found.kind === 'marker' ? 'param' : 'block'
    if (own === latest) return { status: 'current', channel, rev, latest, detail: '' }
    const now = resolveBetween(ownModel, latestModel, formatElementId(parsed))
    if (now.status === 'gone') return { status: 'gone', channel, rev, latest, detail: `no longer exists at r${latest}` }
    return { status: now.status === 'same' ? 'current' : 'changed', channel, rev, latest, detail: now.status === 'same' ? '' : `changed since r${own}` }
  }
}

/**
 * Whether two element IDs refer to the same element or one contains the other
 * (a role-level ID matches all of its instances and events).
 * @param selected - selected or highlighted ID.
 * @param candidate - an event or block ID being drawn.
 * @returns true when `candidate` belongs to `selected`.
 */
export function matchesSelection(selected: string, candidate: string): boolean {
  if (selected === candidate) return true
  let a
  let b
  try {
    a = parseElementId(selected)
    b = parseElementId(candidate)
  } catch {
    // Malformed IDs match nothing.
    return false
  }
  if (a.seq !== b.seq || a.role !== b.role) return false
  if (a.event !== undefined && a.event !== b.event) return false
  if (a.loop.length > 0 && JSON.stringify(a.loop) !== JSON.stringify(b.loop)) return false
  return true
}
