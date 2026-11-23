/**
 * Browser half of the PulseOS simulation panel:
 * - a right-sidebar page type (`pulseos-simulation`, "Simulation") showing the session's simulated
 *   image, k-space and ADC signal. It opens as a tab beside the Sequence tab when a simulation
 *   starts or lands (live, not on replayed history); a user who closes it keeps it closed for that
 *   session until they reopen it from the sidebar's "+" or click a `[[sim:...]]` chip;
 * - `[[sim:r<rev>/<phantom>]]` chips in sent user messages, and a "Simulation" `@` source that
 *   inserts them (the page's "Reference in chat" uses the same codec).
 *
 * The page follows DSH's active theme (`ctx.theme`), like the sequence viewer.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { createElement } from 'react'
import { findSimReferences, formatSimReference, SIM_FAILED_RECORD, SIM_RUN_RECORD, type SimRunRecord } from '@pulseos/sim-protocol'
import { SimChip } from './Chip.tsx'
import { Panel, type PanelActions } from './Panel.tsx'
import { SimStore } from './store.ts'
import { followHostTheme } from './theme.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** A `[[sim:r<rev>/<phantom>]]` reference. */
    'pulseos-sim-ref': { readonly rev: number; readonly phantom: string; readonly engine: string | null }
  }
}

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'uiConversation', 'conversation', 'inputTriggers', 'theme']

const ID = '@pulseos/sim-viewer'
const KIND = 'pulseos-simulation'
const SOURCE = 'Simulation'
const DISMISSED_KEY = 'pulseos.sim.dismissed.'

function dismissed(sessionId: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY + sessionId) === '1'
  } catch {
    // Storage unavailable: nothing was remembered.
    return false
  }
}

function setDismissed(sessionId: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(DISMISSED_KEY + sessionId, '1')
    else localStorage.removeItem(DISMISSED_KEY + sessionId)
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

const referenceRule: UserTextRule<'pulseos-sim-ref'> = {
  id: 'pulseos-sim-ref',
  order: 24,
  match(text, from) {
    const token = findSimReferences(text.slice(from))[0]
    if (token === undefined) return undefined
    return { id: 'pulseos-sim-ref', start: from + token.start, end: from + token.end, data: { rev: token.rev, phantom: token.phantom, engine: token.engine } }
  },
}

interface SessionInputLike {
  canInsertReferences(): boolean
  addReferences(references: readonly { source: string; ref: string; label: string; clipboardText: string }[]): boolean
  focus(): void
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const stores = new Map<string, SimStore>()
  const watched = new Map<string, () => void>()
  const scheme = followHostTheme(ctx)
  ctx.effect(() => () => {
    for (const stop of watched.values()) stop()
    for (const store of stores.values()) store.dispose()
    stores.clear()
    watched.clear()
  }, 'pulseos-sim: stores')

  const storeFor = (sessionId: string): SimStore => {
    let store = stores.get(sessionId)
    if (store === undefined) {
      store = new SimStore(sessionId)
      stores.set(sessionId, store)
    }
    watch(sessionId, store)
    return store
  }

  const tabOpen = (sessionId: string) => ctx.sidebarRight.tabsIn(sessionId as SessionId).some(tab => tab.kind === KIND)
  const openPanel = (sessionId: string) => {
    if (!tabOpen(sessionId)) ctx.sidebarRight.openTabIn(sessionId as SessionId, KIND)
  }
  const openPanelSafely = (sessionId: string) => {
    try {
      openPanel(sessionId)
    } catch {
      // The session's sidebar store is not minted yet (session not on screen); nothing to open.
    }
  }
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, (sessionId) => { setDismissed(sessionId, true) }), 'pulseos-sim: remember close')
  // Watch the on-screen session from the start, so a simulation can open the page before it exists.
  ctx.effect(() => {
    const follow = () => {
      const sessionId = ctx.sidebarRight.mounted.getSnapshot()
      if (sessionId !== undefined) storeFor(sessionId)
    }
    const stop = ctx.sidebarRight.mounted.subscribe(follow)
    follow()
    return stop
  }, 'pulseos-sim: follow the on-screen session')

  // Follow the session's event stream: simulation records and sim_* tool activity refresh the page.
  function watch(sessionId: string, store: SimStore): void {
    if (watched.has(sessionId)) return
    const binding = ctx.sessions.binding(sessionId as SessionId)
    if (binding === undefined) return
    let first = true
    const onChange = () => {
      const change = binding.eventSource.getSnapshot().change
      if (change.kind === 'settle-assistant') {
        // A settled assistant message that calls sim_run: the job starts now; poll its progress.
        if (change.entry !== undefined && JSON.stringify(change.entry).includes('"sim_run"')) {
          store.expectJob()
          if (!first && !dismissed(sessionId)) openPanelSafely(sessionId)
        }
        return
      }
      let relevant = change.kind === 'replace'
      let simulation = false
      for (const entry of change.entries) {
        if (entry.type !== 'event') continue
        const type = String(entry.event.type)
        if (type === SIM_RUN_RECORD || type === SIM_FAILED_RECORD) { relevant = true; simulation = true }
        else if (type === 'plugin:pulseos/revision') relevant = true
        else if (type.startsWith('tool/') && JSON.stringify(entry.event.data).includes('"sim_')) {
          relevant = true
          simulation = true
          // A sim_run call queues its job just after this event; poll until it shows up.
          if (type === 'tool/call') store.expectJob()
        }
      }
      const live = change.kind === 'append' && !first
      first = false
      if (relevant) store.scheduleRefresh()
      if (simulation && live && !dismissed(sessionId)) openPanelSafely(sessionId)
    }
    watched.set(sessionId, binding.eventSource.subscribe(onChange))
  }

  const insert = (sessionId: string, references: { source: string; ref: string; label: string; clipboardText: string }[]): boolean => {
    const binding = ctx.sessions.binding(sessionId as SessionId)
    const input = binding === undefined ? undefined : ctx.conversation.input.for(binding.ctx) as unknown as SessionInputLike
    if (input === undefined || !input.canInsertReferences()) return false
    const ok = input.addReferences(references)
    if (ok) input.focus()
    return ok
  }
  const chipFor = (run: Pick<SimRunRecord, 'rev' | 'phantom' | 'engine'>, defaultEngine: string | undefined) => {
    const ref = formatSimReference(run.rev, run.phantom, run.engine === defaultEngine ? null : run.engine)
    return { source: SOURCE, ref, label: `sim ${run.phantom} · r${run.rev}`, clipboardText: ref }
  }
  const actionsFor = (sessionId: string): PanelActions => ({
    reference(run) {
      return insert(sessionId, [chipFor(run, storeFor(sessionId).getSnapshot().state?.defaults.engine)])
    },
  })
  const reveal = (sessionId: string, rev: number, phantom: string, engine: string | null) => {
    setDismissed(sessionId, false)
    openPanel(sessionId)
    void storeFor(sessionId).reveal(rev, phantom, engine)
  }

  // Right-sidebar page type and body.
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID, kind: KIND, priority: 'extension', keepMounted: true, title: () => 'Simulation',
    guide: [{ id: 'open', order: 2, title: () => 'Sequence simulator', description: () => 'Simulated image, k-space and ADC signal of the sequence on a phantom' }],
  }), 'pulseos-sim: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: ID, inject: (sessionId: string) => ({ store: storeFor(sessionId), actions: actionsFor(sessionId) }) },
    (props: { sessionId: string; store: SimStore; actions: PanelActions }) => {
      // Opening the tab by hand (the sidebar's "+") undoes an earlier close.
      setDismissed(props.sessionId, false)
      return createElement(Panel, { sessionId: props.sessionId, store: props.store, actions: props.actions, scheme })
    },
  )), 'pulseos-sim: tab body')

  // Chips in sent user messages.
  ctx.effect(() => ctx.uiConversation.userText.register(referenceRule), 'pulseos-sim: user text rule')
  ctx.effect(() => ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register(
    {
      name: 'conversation.user.text.node', key: 'pulseos-sim-ref', priority: 100,
      inject: (sessionId: string) => ({ store: storeFor(sessionId), open: (rev: number, phantom: string, engine: string | null) => { reveal(sessionId, rev, phantom, engine) } }),
    },
    (props: { node: { data: { rev: number; phantom: string; engine: string | null } }; raw: string; interactive: boolean; store: SimStore; open: (rev: number, phantom: string, engine: string | null) => void }) =>
      createElement(SimChip, { ...props.node.data, raw: props.raw, interactive: props.interactive, store: props.store, open: props.open }),
  )), 'pulseos-sim: user text chip')

  // "@" source: pick a recorded run; also the codec of chips the page inserts.
  const source: InputTriggerSource = {
    trigger: '@',
    name: SOURCE,
    order: 31,
    async candidates(session, request) {
      const store = storeFor(session.sessionId)
      await store.refresh()
      const state = store.getSnapshot().state
      if (state === null) return []
      const query = request.query.toLowerCase()
      const seen = new Set<string>()
      return state.runs.toReversed()
        .map(run => ({ run, chip: chipFor(run, state.defaults.engine) }))
        .filter(({ chip }) => !seen.has(chip.ref) && seen.add(chip.ref) && chip.ref.toLowerCase().includes(query))
        .slice(0, 20)
        .map(({ run, chip }) => ({ name: chip.ref, label: chip.label, description: `${run.engine} · ${run.cause}`, value: chip.ref }))
    },
    onPick({ candidate }) {
      const ref = candidate.value ?? candidate.name
      const token = findSimReferences(ref)[0]!
      return { insert: { source: SOURCE, ref, label: `sim ${token.phantom} · r${token.rev}`, clipboardText: ref } }
    },
    openReference(session, reference) {
      const token = findSimReferences(reference.ref)[0]
      if (token === undefined) return false
      reveal(session.sessionId, token.rev, token.phantom, token.engine)
      return true
    },
    codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
  }
  ctx.effect(() => ctx.inputTriggers.registerSource(source), 'pulseos-sim: @ source')
}
