/**
 * Browser half of the PulseOS sequence viewer:
 * - a right-sidebar page type (`pulseos-sequence`) rendering the waveform viewer for the session.
 *   It opens by default whenever a session comes on screen without one (empty state included),
 *   and again when a revision arrives; a user who closes the tab keeps it closed for that session
 *   (remembered in localStorage);
 * - `[[element id]]` chips in sent user messages (a user-text rule plus a keyed renderer);
 * - an `@` trigger source ("Sequence") that inserts reference chips into the composer, which the
 *   viewer's "Reference in chat" also uses;
 * - highlighting and click/hover handling for `[[...]]` tokens in assistant text.
 *
 * The viewer and chips follow DSH's active theme (`ctx.theme`); there is no separate switch.
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
import { findReferences, formatReference, NAVIGATE_RECORD, type NavigateRecord } from '@pulseos/seq-protocol'
import { Chip, chipLabel } from './Chip.tsx'
import { startHighlights } from './highlights.ts'
import { ViewerStore } from './store.ts'
import { followHostTheme } from './theme.ts'
import { Viewer, type ViewerActions } from './Viewer.tsx'
import './global.css'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** An `[[element id]]` or `[[element id|rN]]` reference. */
    'pulseos-ref': { readonly id: string; readonly rev: number | null }
  }
}

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'uiConversation', 'conversation', 'inputTriggers', 'theme']

const ID = '@pulseos/seq-viewer'
const KIND = 'pulseos-sequence'
const SOURCE = 'Sequence'
const DISMISSED_KEY = 'pulseos.viewer.dismissed.'

function dismissed(sessionId: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY + sessionId) === '1'
  } catch {
    // Storage unavailable (privacy mode): nothing was remembered.
    return false
  }
}

function setDismissed(sessionId: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY + sessionId, '1')
  } catch {
    // Storage unavailable: the choice lasts for this page only (autoOpened below).
  }
}

const referenceRule: UserTextRule<'pulseos-ref'> = {
  id: 'pulseos-ref',
  order: 25,
  match(text, from) {
    const token = findReferences(text.slice(from))[0]
    if (token === undefined) return undefined
    return { id: 'pulseos-ref', start: from + token.start, end: from + token.end, data: { id: token.id, rev: token.rev } }
  },
}

interface SessionInputLike {
  canInsertReferences(): boolean
  addReferences(references: readonly { source: string; ref: string; label: string; clipboardText: string }[]): boolean
  focus(): void
  insertQuote?(text: string): boolean | void
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const stores = new Map<string, ViewerStore>()
  const scheme = followHostTheme(ctx)
  const watched = new Map<string, () => void>()
  const autoOpened = new Set<string>()
  ctx.effect(() => () => {
    for (const stop of watched.values()) stop()
    for (const store of stores.values()) store.dispose()
    stores.clear()
    watched.clear()
  }, 'pulseos-viewer: stores')

  const storeFor = (sessionId: string): ViewerStore => {
    let store = stores.get(sessionId)
    if (store === undefined) {
      store = new ViewerStore(sessionId)
      stores.set(sessionId, store)
    }
    watch(sessionId, store)
    return store
  }

  const tabOpen = (sessionId: string) => ctx.sidebarRight.tabsIn(sessionId as SessionId).some(tab => tab.kind === KIND)
  const openViewer = (sessionId: string, id?: string, rev: number | null = null) => {
    ctx.sidebarRight.openTabIn(sessionId as SessionId, KIND)
    if (id !== undefined) void storeFor(sessionId).reveal(id, rev)
  }

  /**
   * Open the viewer by default, once per session and page: skipped when the user closed it for this
   * session, or when a Sequence tab already exists (a collapsed sidebar stays collapsed). The
   * sidebar mints a session's store while rendering it, so the open retries over a few frames.
   */
  const autoOpen = (sessionId: string, attempt = 0) => {
    if (autoOpened.has(sessionId) || dismissed(sessionId)) return
    if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return
    try {
      autoOpened.add(sessionId)
      if (!tabOpen(sessionId)) ctx.sidebarRight.openTabIn(sessionId as SessionId, KIND)
    } catch (error) {
      // The session's sidebar store is not minted yet; try again after it renders.
      autoOpened.delete(sessionId)
      if (attempt < 20) setTimeout(() => { autoOpen(sessionId, attempt + 1) }, 100)
      else console.warn('pulseos-viewer: could not open the viewer by default', error)
    }
  }
  ctx.effect(() => {
    const follow = () => {
      const sessionId = ctx.sidebarRight.mounted.getSnapshot()
      if (sessionId !== undefined) setTimeout(() => { autoOpen(sessionId) }, 0)
    }
    const stop = ctx.sidebarRight.mounted.subscribe(follow)
    follow()
    return stop
  }, 'pulseos-viewer: open by default')
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, (sessionId) => {
    setDismissed(sessionId)
    autoOpened.add(sessionId)
  }), 'pulseos-viewer: remember close')

  // Follow the session's event stream: PulseOS records and seq_* tool activity refresh the viewer.
  function watch(sessionId: string, store: ViewerStore): void {
    if (watched.has(sessionId)) return
    const binding = ctx.sessions.binding(sessionId as SessionId)
    if (binding === undefined) return
    let first = true
    const onChange = () => {
      const window = binding.eventSource.getSnapshot()
      const change = window.change
      if (change.kind === 'settle-assistant') return
      let relevant = change.kind === 'replace'
      let revision = false
      let navigate: NavigateRecord | undefined
      for (const entry of change.entries) {
        if (entry.type !== 'event') continue
        const type = String(entry.event.type)
        if (type === NAVIGATE_RECORD) navigate = entry.event.data as NavigateRecord
        else if (type.startsWith('plugin:pulseos/')) { relevant = true; if (type === 'plugin:pulseos/revision') revision = true }
        else if (type.startsWith('tool/') && JSON.stringify(entry.event.data).includes('"seq_')) relevant = true
      }
      const live = change.kind === 'append' && !first
      first = false
      // A navigation is an explicit request, so it reopens a closed viewer; replayed history does not move it.
      if (navigate !== undefined && live) {
        if (!tabOpen(sessionId)) ctx.sidebarRight.openTabIn(sessionId as SessionId, KIND)
        void store.navigate(navigate)
      }
      if (relevant) store.scheduleRefresh()
      if (revision && live && !dismissed(sessionId) && !tabOpen(sessionId)) openViewer(sessionId)
    }
    watched.set(sessionId, binding.eventSource.subscribe(onChange))
  }

  const actionsFor = (sessionId: string): ViewerActions => {
    const input = (): SessionInputLike | undefined => {
      const binding = ctx.sessions.binding(sessionId as SessionId)
      return binding === undefined ? undefined : ctx.conversation.input.for(binding.ctx) as unknown as SessionInputLike
    }
    return {
      reference(id, rev) {
        const target = input()
        if (target === undefined || !target.canInsertReferences()) return false
        const effective = rev ?? storeFor(sessionId).getSnapshot().state?.revisions.at(-1)?.rev ?? null
        const ref = formatReference(id, effective)
        const ok = target.addReferences([{ source: SOURCE, ref, label: `${chipLabel(id)}${effective === null ? '' : ` · r${effective}`}`, clipboardText: ref }])
        if (ok) target.focus()
        return ok
      },
      quote(text) {
        const target = input()
        if (target?.insertQuote === undefined) return false
        target.insertQuote(text)
        target.focus()
        return true
      },
    }
  }

  // Right-sidebar page type and body.
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID, kind: KIND, priority: 'extension', keepMounted: true, title: () => 'Sequence',
    guide: [{ id: 'open', order: 1, title: () => 'Sequence viewer', description: () => 'Pulse sequence waveforms, revisions and element inspector' }],
  }), 'pulseos-viewer: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: ID, inject: (sessionId: string) => ({ store: storeFor(sessionId), actions: actionsFor(sessionId) }) },
    (props: { sessionId: string; store: ViewerStore; actions: ViewerActions }) => createElement(Viewer, { sessionId: props.sessionId, store: props.store, actions: props.actions, scheme }),
  )), 'pulseos-viewer: tab body')

  // Chips in sent user messages.
  ctx.effect(() => ctx.uiConversation.userText.register(referenceRule), 'pulseos-viewer: user text rule')
  ctx.effect(() => ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register(
    {
      name: 'conversation.user.text.node', key: 'pulseos-ref', priority: 100,
      inject: (sessionId: string) => ({ store: storeFor(sessionId), open: (id: string, rev: number | null) => { openViewer(sessionId, id, rev) } }),
    },
    (props: { node: { data: { id: string; rev: number | null } }; raw: string; interactive: boolean; store: ViewerStore; open: (id: string, rev: number | null) => void }) =>
      createElement(Chip, { id: props.node.data.id, rev: props.node.data.rev, raw: props.raw, interactive: props.interactive, store: props.store, open: props.open }),
  )), 'pulseos-viewer: user text chip')

  // "@" source: pick sequence elements; also the codec for chips the viewer inserts.
  const source: InputTriggerSource = {
    trigger: '@',
    name: SOURCE,
    order: 30,
    async candidates(session, request) {
      const store = storeFor(session.sessionId)
      await store.refresh()
      const latest = store.getSnapshot().state?.revisions.at(-1)
      if (latest === undefined) return []
      const model = await store.model(latest.rev)
      const query = request.query.toLowerCase()
      const items = [
        ...Object.values(model.params).map(p => ({ id: p.id, description: `${p.value} ${p.unit} · ${p.description}` })),
        ...model.roles.flatMap(r => [{ id: r.id, description: `${r.instances} blocks` }, ...r.events.map(e => ({ id: e.id, description: `${e.channel} · ${e.instances} instances` }))]),
      ]
      return items.filter(item => item.id.toLowerCase().includes(query)).slice(0, 40)
        .map(item => ({ name: item.id, label: chipLabel(item.id), description: item.description, value: item.id }))
    },
    onPick({ candidate, session }) {
      const rev = storeFor(session.sessionId).getSnapshot().state?.revisions.at(-1)?.rev ?? null
      const id = candidate.value ?? candidate.name
      const ref = formatReference(id, rev)
      return { insert: { source: SOURCE, ref, label: `${chipLabel(id)}${rev === null ? '' : ` · r${rev}`}`, clipboardText: ref } }
    },
    openReference(session, reference) {
      const token = findReferences(reference.ref)[0]
      if (token === undefined) return false
      openViewer(session.sessionId, token.id, token.rev)
      return true
    },
    codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
  }
  ctx.effect(() => ctx.inputTriggers.registerSource(source), 'pulseos-viewer: @ source')

  // Assistant text tokens on the on-screen session.
  ctx.effect(() => {
    const mounted = () => ctx.sidebarRight.mounted.getSnapshot()
    const highlights = startHighlights({
      isValid: (id, rev) => {
        const sessionId = mounted()
        if (sessionId === undefined) return true
        const status = storeFor(sessionId).chipState(id, rev).status
        return status !== 'unresolved'
      },
      open: (id, rev) => { const sessionId = mounted(); if (sessionId !== undefined) openViewer(sessionId, id, rev) },
      hover: (id, rev) => { const sessionId = mounted(); if (sessionId !== undefined) storeFor(sessionId).highlight(id, rev) },
    })
    const unsubscribers: (() => void)[] = []
    const follow = () => {
      for (const stop of unsubscribers.splice(0)) stop()
      const sessionId = mounted()
      if (sessionId !== undefined) unsubscribers.push(storeFor(sessionId).subscribe(highlights.rescan))
      highlights.rescan()
    }
    const stopMounted = ctx.sidebarRight.mounted.subscribe(follow)
    follow()
    return () => { stopMounted(); for (const stop of unsubscribers) stop(); highlights.dispose() }
  }, 'pulseos-viewer: assistant references')
}
