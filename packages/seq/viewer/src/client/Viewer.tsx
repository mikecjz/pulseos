/** The sequence viewer tab body. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  resolve, resolveBetween, type Channel, type ResolvedElement, type RevisionRecord, type SequenceEvent, type SequenceModel,
} from '@pulseos/seq-protocol'
import { CHANNELS, clampView, formatDuration, formatTime, type Viewport } from './geometry.ts'
import { DARK, drawOverview, drawTracks, hitTest, layoutRows, LIGHT, type DrawInput, type Palette, type Row } from './draw.ts'
import type { ViewerSnapshot, ViewerStore } from './store.ts'
import styles from './viewer.module.css'

/** Actions the viewer needs from the host page. */
export interface ViewerActions {
  /** Insert a reference chip into this session's composer. */
  reference(id: string, rev: number | null): boolean
  /** Insert text into this session's composer. */
  quote(text: string): boolean
}

export interface ViewerProps {
  sessionId: string
  store: ViewerStore
  actions: ViewerActions
}

const TRACK_LABELS: Record<string, [string, string]> = {
  rf: ['RF', '|B1| µT'], rfPhase: ['∠ RF', 'phase'], gz: ['Gz', 'slice'], gy: ['Gy', 'phase'], gx: ['Gx', 'read'], adc: ['ADC', 'samples'],
}
const THEME_KEY = 'pulseos.viewer.theme'

function useSnapshot(store: ViewerStore): ViewerSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

function useSize<T extends HTMLElement>(): [React.RefObject<T>, { width: number; height: number }] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry!.contentRect
      setSize(s => (s.width === box.width && s.height === box.height ? s : { width: box.width, height: box.height }))
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])
  return [ref, size]
}

function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
  }
  const g = canvas.getContext('2d')
  g?.setTransform(dpr, 0, 0, dpr, 0, 0)
  return g
}

const words = (s: string) => s.replace(/_/g, ' ')

function humanRole(id: string): string {
  const name = id.replace(/^[^:]+:/, '').replace(/@.*$/, '')
  const [role, event] = name.split('.')
  if (role === 'param') return `Parameter ${event}`
  return event === undefined ? `${words(role!)} block` : `${words(role!)} · ${event}`
}

export function Viewer({ sessionId, store, actions }: ViewerProps) {
  const snap = useSnapshot(store)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'))
  const palette = theme === 'dark' ? DARK : LIGHT
  useEffect(() => { localStorage.setItem(THEME_KEY, theme) }, [theme])
  useEffect(() => {
    if (snap.toast === null) return
    const timer = setTimeout(() => { store.dismissToast() }, 4500)
    return () => { clearTimeout(timer) }
  }, [snap.toast, store])

  const latest = snap.state?.revisions.at(-1) ?? null
  const shown = snap.state?.revisions.find(r => r.rev === snap.shownRev) ?? null
  const failure = snap.state?.lastFailure !== null && snap.state?.lastFailure !== undefined && snap.state.lastFailure.afterRev === (latest?.rev ?? null)
    ? snap.state.lastFailure : null

  return (
    <div className={styles.root} data-pulseos-viewer={sessionId} data-theme={theme} tabIndex={-1}>
      <Toolbar snap={snap} store={store} shown={shown} latest={latest} theme={theme} onTheme={() => { setTheme(t => (t === 'dark' ? 'light' : 'dark')) }} />
      {snap.status === 'unavailable' && (
        <div className={styles.bannerBad} role="alert">
          Sequence backend unavailable — {snap.error}
          <button type="button" className={styles.linkButton} onClick={() => { void store.refresh() }}>Retry</button>
        </div>
      )}
      {failure !== null && <FailureBanner failure={failure} actions={actions} />}
      {snap.pinnedRev !== null && latest !== null && snap.pinnedRev !== latest.rev && (
        <div className={styles.bannerInfo}>
          Viewing r{snap.pinnedRev} (read-only) ·
          <button type="button" className={styles.linkButton} onClick={() => { store.pin(null) }}>Back to latest r{latest.rev}</button>
        </div>
      )}
      {snap.model === null || snap.index === null || snap.view === null
        ? <EmptyState snap={snap} store={store} />
        : <Workspace snap={snap} store={store} actions={actions} palette={palette} model={snap.model} view={snap.view} shown={shown} />}
      {snap.toast !== null && <div className={styles.toast} role="status">{snap.toast}</div>}
    </div>
  )
}

function Toolbar({ snap, store, shown, latest, theme, onTheme }: { snap: ViewerSnapshot; store: ViewerStore; shown: RevisionRecord | null; latest: RevisionRecord | null; theme: string; onTheme: () => void }) {
  const index = snap.index
  const errors = snap.model?.timing.errors ?? []
  const [errorCursor, setErrorCursor] = useState(0)
  const repetitionSpan = (n: number) => {
    if (index === null || snap.view === null) return
    const i = index.repetitionAt((snap.view.t0 + snap.view.t1) / 2)
    const first = index.repetitions[i]!
    const last = index.repetitions[Math.min(index.repetitions.length - 1, i + n - 1)]!
    store.setView({ t0: first.start, t1: last.end })
  }
  const step = (delta: number) => {
    if (index === null || snap.view === null) return
    const i = index.repetitionAt(snap.view.t0 + 1e-9)
    const target = index.repetitions[Math.min(index.repetitions.length - 1, Math.max(0, i + delta))]!
    store.setView({ t0: target.start - (snap.view.t0 - index.repetitions[i]!.start), t1: target.start - (snap.view.t0 - index.repetitions[i]!.start) + (snap.view.t1 - snap.view.t0) })
  }
  const limits = snap.state?.profile.limits ?? {}
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Sequence viewer toolbar">
      <span className={styles.chipBox}>seq <b>{snap.model?.seq ?? '—'}</b></span>
      <label className={styles.chipBox}>
        rev
        <select
          className={styles.select}
          aria-label="Revision"
          value={snap.pinnedRev ?? 'latest'}
          disabled={(snap.state?.revisions.length ?? 0) === 0}
          onChange={(event) => { store.pin(event.target.value === 'latest' ? null : Number(event.target.value)) }}
        >
          <option value="latest">{latest === null ? 'none' : `latest (r${latest.rev})`}</option>
          {(snap.state?.revisions ?? []).toReversed().map(r => (
            <option key={r.rev} value={r.rev}>{`r${r.rev} · ${r.kind} · ${r.cause} · ${r.timing.ok ? 'timing ✓' : `${r.timing.errors} timing errors`}`}</option>
          ))}
        </select>
        {shown !== null && <span className={styles.kindTag}>{shown.kind}</span>}
        {snap.state?.building === true && <span className={styles.spinner} aria-label="Building" />}
      </label>
      <div className={styles.segmented}>
        <button type="button" onClick={() => { if (snap.model) store.setView({ t0: 0, t1: snap.model.duration }) }}>Fit all</button>
        <button type="button" onClick={() => { repetitionSpan(1) }}>1 TR</button>
        <button type="button" onClick={() => { repetitionSpan(2) }}>2 TR</button>
        <button type="button" disabled={snap.selection === null} onClick={() => { if (snap.selection) store.frame(snap.selection) }}>Selected</button>
      </div>
      <button type="button" className={styles.plain} aria-label="Previous TR" title="Previous repetition ( [ )" onClick={() => { step(-1) }}>‹ TR</button>
      <button type="button" className={styles.plain} aria-label="Next TR" title="Next repetition ( ] )" onClick={() => { step(1) }}>TR ›</button>
      <span className={styles.spacer} />
      {snap.state !== null && (
        <span className={styles.chipBox} title={Object.entries(limits).map(([k, v]) => `${k} = ${v}`).join('\n')}>
          {snap.state.profile.id} · {limits.b0_T ?? '?'} T
        </span>
      )}
      <button
        type="button"
        className={`${styles.chipBox} ${errors.length > 0 ? styles.bad : ''}`}
        title={errors.length > 0 ? 'Cycle through timing violations' : 'pypulseq check_timing found no errors'}
        onClick={() => {
          if (errors.length === 0) return
          const error = errors[errorCursor % errors.length]!
          setErrorCursor(errorCursor + 1)
          const id = error.ids[0]
          if (id !== undefined) { store.select(id); store.frame(id) }
        }}
      >
        <span className={styles.dot} style={{ background: errors.length > 0 ? 'var(--bad)' : 'var(--ok)' }} /> timing {errors.length}
      </button>
      <button type="button" className={styles.plain} aria-label="Toggle light or dark theme" onClick={onTheme}>{theme === 'dark' ? '☀' : '☾'}</button>
      {shown !== null && <a className={styles.chipBox} href={store.seqUrl(shown.rev)} download>⤓ .seq</a>}
    </div>
  )
}

function EmptyState({ snap, store }: { snap: ViewerSnapshot; store: ViewerStore }) {
  if (snap.status === 'loading') return <div className={styles.empty}>Loading…</div>
  if ((snap.state?.revisions.length ?? 0) > 0) return <div className={styles.empty}>Loading r{snap.state!.revisions.at(-1)!.rev}…</div>
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>No sequence built yet</div>
      <div className={styles.muted}>Ask in chat, for example “Build the 2D GRE and show me the excitation pulse”, or start from the bundled recipe.</div>
      <button type="button" className={styles.primary} disabled={snap.state?.building === true || snap.status !== 'ready'} onClick={() => { void store.buildDefault() }}>
        {snap.state?.building === true ? 'Building…' : 'Build gre2d with defaults'}
      </button>
    </div>
  )
}

function FailureBanner({ failure, actions }: { failure: NonNullable<ViewerSnapshot['state']>['lastFailure'] & object; actions: ViewerActions }) {
  const [open, setOpen] = useState(false)
  const summary = `Build failed (${failure.error.kind}${failure.error.line === null ? '' : `, recipe line ${failure.error.line}`}): ${failure.error.message}`
  return (
    <div className={styles.bannerBad} role="alert">
      <span>{summary} — the last good revision stays shown.</span>
      {failure.error.traceback ? <button type="button" className={styles.linkButton} onClick={() => { setOpen(!open) }}>{open ? 'Hide' : 'Show'} traceback</button> : null}
      <button type="button" className={styles.linkButton} onClick={() => { actions.quote(summary) }}>Reference error in chat</button>
      {open && <pre className={styles.trace}>{failure.error.traceback}</pre>}
    </div>
  )
}

interface WorkspaceProps { snap: ViewerSnapshot; store: ViewerStore; actions: ViewerActions; palette: Palette; model: SequenceModel; view: Viewport; shown: RevisionRecord | null }

function Workspace({ snap, store, actions, palette, model, view, shown }: WorkspaceProps) {
  const index = snap.index!
  const [plotRef, plotSize] = useSize<HTMLDivElement>()
  const [overviewRef, overviewSize] = useSize<HTMLDivElement>()
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const overview = useRef<HTMLCanvasElement | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; id: string } | null>(null)
  const [now, setNow] = useState(() => performance.now())
  const pulseStart = useRef<{ pulse: number; at: number }>({ pulse: snap.pulse, at: 0 })
  if (pulseStart.current.pulse !== snap.pulse) pulseStart.current = { pulse: snap.pulse, at: performance.now() }
  const rows: Row[] = useMemo(() => layoutRows(plotSize.height, snap.phaseOpen, snap.hidden), [plotSize.height, snap.phaseOpen, snap.hidden])
  const errorIds = useMemo(() => new Set(model.timing.errors.flatMap(e => e.ids)), [model])
  const gradLimit = snap.state?.profile.limits.max_grad_mT_per_m ?? 0
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

  // Animation clock for the chat-highlight pulse and the live-update flash.
  const sincePulse = now - pulseStart.current.at
  const flashAge = snap.flash === null ? Infinity : Date.now() - snap.flash.at
  const animating = sincePulse < 1200 || flashAge < 1500
  useEffect(() => {
    if (!animating) return
    let frame = requestAnimationFrame(function tick() { setNow(performance.now()); frame = requestAnimationFrame(tick) })
    return () => { cancelAnimationFrame(frame) }
  }, [animating])

  const drawInput: DrawInput = {
    index, model, view, width: plotSize.width, rows, palette,
    selection: snap.selection, hover: hoverId,
    chatHighlight: snap.hover === null ? null : { id: snap.hover.id, strength: reduced || sincePulse >= 1200 ? 0.6 : 0.5 + 0.5 * Math.abs(Math.sin((sincePulse / 600) * Math.PI)) },
    flash: snap.flash === null || flashAge >= 1500 ? null : { ids: snap.flash.ids, strength: 1 - flashAge / 1500 },
    cursor, gradLimit, errorIds,
  }
  useEffect(() => {
    if (canvas.current === null || plotSize.width === 0) return
    const g = prepareCanvas(canvas.current, plotSize.width, plotSize.height)
    if (g !== null) drawTracks(g, drawInput)
  })
  useEffect(() => {
    if (overview.current === null || overviewSize.width === 0) return
    const g = prepareCanvas(overview.current, overviewSize.width, 28)
    if (g !== null) drawOverview(g, index, view, overviewSize.width, 28, palette)
  })

  const timeAt = useCallback((clientX: number) => {
    const rect = canvas.current!.getBoundingClientRect()
    return view.t0 + ((clientX - rect.left) / rect.width) * (view.t1 - view.t0)
  }, [view])

  // Wheel: Ctrl/Cmd zooms around the cursor; otherwise pans.
  useEffect(() => {
    const element = canvas.current
    if (element === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const span = view.t1 - view.t0
      if (event.ctrlKey || event.metaKey) {
        const anchor = timeAt(event.clientX)
        const factor = Math.exp(event.deltaY * 0.0025)
        store.setView({ t0: anchor - (anchor - view.t0) * factor, t1: anchor + (view.t1 - anchor) * factor })
      } else {
        const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) / plotSize.width * span
        store.setView({ t0: view.t0 + delta, t1: view.t1 + delta })
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => { element.removeEventListener('wheel', onWheel) }
  }, [view, store, timeAt, plotSize.width])

  const drag = useRef<{ x: number; t0: number; t1: number; moved: boolean; mode: 'pan' | 'zoom'; anchor: number } | null>(null)
  const [band, setBand] = useState<{ a: number; b: number } | null>(null)
  const onPointerDown = (event: React.PointerEvent) => {
    canvas.current!.setPointerCapture(event.pointerId)
    const rect = canvas.current!.getBoundingClientRect()
    const onRuler = event.clientY - rect.top < (rows[0]?.h ?? 22)
    drag.current = { x: event.clientX, t0: view.t0, t1: view.t1, moved: false, mode: onRuler ? 'zoom' : 'pan', anchor: timeAt(event.clientX) }
  }
  const onPointerMove = (event: React.PointerEvent) => {
    const rect = canvas.current!.getBoundingClientRect()
    const t = timeAt(event.clientX)
    setCursor(t)
    const d = drag.current
    if (d !== null) {
      if (Math.abs(event.clientX - d.x) > 3) d.moved = true
      if (d.moved && d.mode === 'pan') {
        const shift = ((event.clientX - d.x) / rect.width) * (d.t1 - d.t0)
        store.setView({ t0: d.t0 - shift, t1: d.t1 - shift })
      } else if (d.moved) setBand({ a: d.anchor, b: t })
      return
    }
    const hit = hitTest(drawInput, event.clientX - rect.left, event.clientY - rect.top, event.shiftKey || event.altKey)
    const id = hit?.id ?? null
    setHoverId(id)
    setTooltip(id === null ? null : { x: event.clientX - rect.left, y: event.clientY - rect.top, id })
  }
  const onPointerUp = (event: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (d === null) return
    if (d.mode === 'zoom' && d.moved && band !== null) {
      store.setView({ t0: Math.min(band.a, band.b), t1: Math.max(band.a, band.b) })
      setBand(null)
      return
    }
    setBand(null)
    if (d.moved) return
    const rect = canvas.current!.getBoundingClientRect()
    const hit = hitTest(drawInput, event.clientX - rect.left, event.clientY - rect.top, event.shiftKey || event.altKey)
    store.select(hit?.id ?? null)
  }
  const onDoubleClick = (event: React.MouseEvent) => {
    const rect = canvas.current!.getBoundingClientRect()
    const hit = hitTest(drawInput, event.clientX - rect.left, event.clientY - rect.top, true)
    if (hit?.id) store.frame(hit.id)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('select, input, textarea, [contenteditable="true"]')) return
    const span = view.t1 - view.t0
    const center = (view.t0 + view.t1) / 2
    switch (event.key) {
      case 'Escape': store.select(null); break
      case 'r': case 'R': if (snap.selection) actions.reference(snap.selection, snap.pinnedRev); break
      case '+': case '=': store.setView({ t0: center - span / 4, t1: center + span / 4 }); break
      case '-': case '_': store.setView({ t0: center - span, t1: center + span }); break
      case 'ArrowLeft': store.setView({ t0: view.t0 - span / 8, t1: view.t1 - span / 8 }); break
      case 'ArrowRight': store.setView({ t0: view.t0 + span / 8, t1: view.t1 + span / 8 }); break
      case '[': case ']': {
        const i = index.repetitionAt(view.t0 + 1e-9)
        const target = index.repetitions[Math.min(index.repetitions.length - 1, Math.max(0, i + (event.key === ']' ? 1 : -1)))]!
        const offset = view.t0 - index.repetitions[i]!.start
        store.setView({ t0: target.start + offset, t1: target.start + offset + span })
        break
      }
      default: return
    }
    event.preventDefault()
  }

  // Overview brush dragging.
  const brush = useRef<{ x: number; t0: number } | null>(null)
  const overviewTime = (clientX: number) => {
    const rect = overview.current!.getBoundingClientRect()
    return ((clientX - rect.left) / rect.width) * index.duration
  }
  const centerAt = (t: number) => { const span = view.t1 - view.t0; store.setView({ t0: t - span / 2, t1: t + span / 2 }) }

  const readout = CHANNELS.map(c => [c, cursor === null ? 0 : index.valueAt(c, cursor)] as const)
  const rep = index.repetitionAt((view.t0 + view.t1) / 2)

  return (
    <div className={styles.workspace} onKeyDown={onKeyDown} tabIndex={0} aria-label="Sequence tracks; click to select, R to reference in chat">
      <div className={styles.overviewHead}>
        <span>Overview · {index.repetitions.length} repetitions · {formatDuration(index.duration)}</span>
        <span className={styles.mono}>viewing {formatTime(view.t0)}–{formatTime(view.t1)} · {index.repetitions[rep]?.label}</span>
      </div>
      <div className={styles.overview} ref={overviewRef}>
        <canvas
          ref={overview}
          aria-label="Sequence overview; drag to move the view"
          onPointerDown={(event) => { overview.current!.setPointerCapture(event.pointerId); brush.current = { x: event.clientX, t0: view.t0 }; centerAt(overviewTime(event.clientX)) }}
          onPointerMove={(event) => { if (brush.current !== null) centerAt(overviewTime(event.clientX)) }}
          onPointerUp={() => { brush.current = null }}
        />
      </div>
      <div className={styles.tracks}>
        <div className={styles.gutter}>
          {rows.map(r => {
            if (r.key === 'ruler') return <div key={r.key} className={styles.gutterCell} style={{ top: r.y, height: r.h }}><span className={styles.faint}>t</span></div>
            if (r.key === 'blocks') return <div key={r.key} className={styles.gutterCell} style={{ top: r.y, height: r.h }}><span className={styles.faint}>blocks</span></div>
            const [name, unit] = TRACK_LABELS[r.key]!
            const channel = (r.key === 'rfPhase' ? 'rf' : r.key) as Channel
            return (
              <div key={r.key} className={styles.gutterCell} style={{ top: r.y, height: r.h }}>
                <span className={styles.trackName} style={{ color: `var(--${channel})` }}>
                  {r.key === 'rfPhase'
                    ? <button type="button" className={styles.plain} onClick={() => { store.togglePhase() }} aria-expanded={snap.phaseOpen}>{name} {snap.phaseOpen ? '▾' : '▸'}</button>
                    : name}
                </span>
                {r.h >= 30 && <span className={styles.faint}>{unit}</span>}
                {r.key !== 'rfPhase' && r.h >= 40 && (
                  <button type="button" className={styles.hide} aria-label={`Hide ${name}`} onClick={() => { store.toggleChannel(channel) }}>hide</button>
                )}
              </div>
            )
          })}
          {snap.hidden.length > 0 && (
            <div className={styles.hiddenList}>
              {snap.hidden.map(c => <button type="button" key={c} className={styles.plain} onClick={() => { store.toggleChannel(c) }}>show {c}</button>)}
            </div>
          )}
        </div>
        <div className={styles.plot} ref={plotRef}>
          <canvas
            ref={canvas}
            role="img"
            aria-label={`Waveforms from ${formatTime(view.t0)} to ${formatTime(view.t1)}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => { setCursor(null); setHoverId(null); setTooltip(null) }}
            onDoubleClick={onDoubleClick}
            style={{ cursor: hoverId !== null ? 'pointer' : 'crosshair' }}
          />
          {band !== null && (() => {
            const left = ((Math.min(band.a, band.b) - view.t0) / (view.t1 - view.t0)) * plotSize.width
            const width = (Math.abs(band.b - band.a) / (view.t1 - view.t0)) * plotSize.width
            return <div className={styles.band} style={{ left, width }} />
          })()}
          {tooltip !== null && <Tooltip model={model} id={tooltip.id} x={tooltip.x} y={tooltip.y} width={plotSize.width} />}
        </div>
      </div>
      <div className={styles.readout}>
        <span>t = {cursor === null ? '—' : formatTime(cursor, 1e-6)}</span>
        {readout.map(([c, v]) => <span key={c}><span style={{ color: `var(--${c})` }}>{c === 'rf' ? 'RF' : c.replace('g', 'G')}</span> {c === 'adc' ? (v > 0 ? 'on' : 'off') : `${v.toFixed(c === 'rf' ? 2 : 1)}${c === 'rf' ? ' µT' : c === 'gx' ? ' mT/m' : ''}`}</span>)}
      </div>
      {snap.selection !== null && <Inspector snap={snap} store={store} actions={actions} model={model} shown={shown} view={view} />}
      <ul className={styles.srOnly} aria-label="Sequence roles">
        {model.roles.map(r => <li key={r.id}><button type="button" onClick={() => { store.select(r.id); store.frame(r.id) }}>{r.id}</button></li>)}
      </ul>
    </div>
  )
}

function Tooltip({ model, id, x, y, width }: { model: SequenceModel; id: string; x: number; y: number; width: number }) {
  const found = resolve(model, id)
  let detail = ''
  if (found.status === 'ok') {
    if (found.kind === 'event') detail = eventSummary(found.element)
    else if (found.kind === 'role-event') detail = `${found.element.instances} instances`
    else if (found.kind === 'block') detail = formatDuration(found.element.duration)
    else if (found.kind === 'role') detail = `${found.element.instances} blocks`
    else if (found.kind === 'param') detail = `${found.element.value} ${found.element.unit}`
  }
  return (
    <div className={styles.tooltip} style={{ left: Math.min(x + 12, width - 260), top: y + 14 }}>
      <div className={styles.mono}>{id}</div>
      {detail && <div className={styles.muted}>{detail}</div>}
    </div>
  )
}

function eventSummary(e: SequenceEvent): string {
  switch (e.kind) {
    case 'rf': return `${formatDuration(e.duration)} · ${e.flipAngle.toFixed(1)}° · peak ${e.peak.toFixed(2)} µT`
    case 'trap': return `${formatDuration(e.duration)} · ${e.amplitude.toFixed(2)} mT/m`
    case 'grad': return `${formatDuration(e.duration)} · peak ${e.peak.toFixed(2)} mT/m`
    case 'adc': return `${e.numSamples} × ${(e.dwell * 1e6).toFixed(2)} µs = ${formatDuration(e.duration)}`
  }
}

function properties(found: ResolvedElement, model: SequenceModel): [string, ReactNode][] {
  switch (found.kind) {
    case 'param': {
      const p = found.element
      return [['Value', `${p.value} ${p.unit}`], ['Default', `${p.default} ${p.unit}`], ['Range', `${p.min ?? '−∞'} … ${p.max ?? '∞'}${p.integer ? ' (integer)' : ''}`], ['Description', p.description]]
    }
    case 'marker': return [['Time', formatTime(found.element.t, 1e-6)], ['From', found.element.start === null ? '—' : formatTime(found.element.start, 1e-6)]]
    case 'role': return [['Blocks', String(found.element.instances)], ['Events', found.element.events.map(e => `${e.name} (${e.channel})`).join(', ') || 'delay only'], ['Formerly', found.element.formerly ?? '—']]
    case 'block': return [['Start', formatTime(found.element.t0, 1e-6)], ['Duration', formatDuration(found.element.duration)], ['pulseq block', String(found.element.index)]]
    case 'role-event': {
      const instances = model.events.filter(e => e.role === found.element.role && e.name === found.element.name)
      return [['Instances', String(instances.length)], ...eventRows(instances[0]!), ...varying(instances)]
    }
    case 'event': return eventRows(found.element)
  }
}

function eventRows(e: SequenceEvent): [string, ReactNode][] {
  const base: [string, ReactNode][] = [['Type', e.kind === 'trap' ? 'trapezoid' : e.kind], ['Start', formatTime(e.t0, 1e-6)], ['Delay in block', formatDuration(e.delay)], ['Duration', formatDuration(e.duration)]]
  switch (e.kind) {
    case 'rf': return [...base, ['Flip angle', `${e.flipAngle.toFixed(2)}°`], ['Peak B1', `${e.peak.toFixed(3)} µT`], ['Phase offset', `${((e.phaseOffset * 180) / Math.PI).toFixed(1)}°`], ['Frequency offset', `${e.freqOffset.toFixed(1)} Hz`], ['Use', e.use]]
    case 'trap': return [...base, ['Amplitude', `${e.amplitude.toFixed(3)} mT/m`], ['Rise / flat / fall', `${formatDuration(e.rise)} / ${formatDuration(e.flat)} / ${formatDuration(e.fall)}`], ['Area', `${e.area.toFixed(2)} 1/m`]]
    case 'grad': return [...base, ['Peak', `${e.peak.toFixed(3)} mT/m`], ['Area', `${e.area.toFixed(2)} 1/m`]]
    case 'adc': return [...base, ['Samples', String(e.numSamples)], ['Dwell', `${(e.dwell * 1e6).toFixed(3)} µs`], ['Phase offset', `${((e.phaseOffset * 180) / Math.PI).toFixed(1)}°`]]
  }
}

function varying(events: SequenceEvent[]): [string, ReactNode][] {
  const keys = ['amplitude', 'phaseOffset', 'area', 'freqOffset'] as const
  const rows: [string, ReactNode][] = []
  for (const key of keys) {
    const values = events.map(e => (e as unknown as Record<string, unknown>)[key]).filter((v): v is number => typeof v === 'number')
    if (values.length < 2) continue
    const min = Math.min(...values)
    const max = Math.max(...values)
    if (max - min > 1e-9 * Math.max(1, Math.abs(max))) rows.push([`Varies: ${key}`, `${min.toPrecision(4)} … ${max.toPrecision(4)}`])
  }
  return rows
}

function Inspector({ snap, store, actions, model, shown, view }: { snap: ViewerSnapshot; store: ViewerStore; actions: ViewerActions; model: SequenceModel; shown: RevisionRecord | null; view: Viewport }) {
  const id = snap.selection!
  const [tab, setTab] = useState<'properties' | 'changes' | 'timing'>('properties')
  const [parent, setParent] = useState<SequenceModel | null>(null)
  const found = resolve(model, id)
  const role = found.status === 'ok' ? model.roles.find(r => r.role === id.replace(/^[^:]+:/, '').replace(/[.@].*$/, '')) : undefined
  useEffect(() => {
    if (shown !== null) void store.loadRecipe(shown.rev)
  }, [shown, store])
  useEffect(() => {
    setParent(null)
    if (shown?.parent === null || shown?.parent === undefined) return
    let live = true
    store.model(shown.parent).then(m => { if (live) setParent(m) }, () => undefined)
    return () => { live = false }
  }, [shown, store])
  const change = parent === null || shown === null ? null : resolveBetween(parent, model, id)
  const inView = found.status === 'ok' && (found.kind === 'role-event' || found.kind === 'role')
    ? model.events.filter(e => (found.kind === 'role' ? e.role === found.element.role : e.role === found.element.role && e.name === (found.element as { name: string }).name) && e.t0 <= view.t1 && e.t0 + e.duration >= view.t0)
    : []
  const lines = snap.recipe !== null && snap.recipe.rev === shown?.rev ? snap.recipe.source.split('\n') : null
  const span = role?.sourceSpan ?? null
  const fingerprint = found.status === 'ok' && 'fingerprint' in found.element ? found.element.fingerprint : ''
  const errors = model.timing.errors.filter(e => e.ids.some(x => x === id || x.startsWith(`${id}@`) || x.startsWith(`${id}.`)))
  const channel = found.status === 'ok' && (found.kind === 'event' || found.kind === 'role-event') ? found.element.channel : null
  return (
    <section className={styles.inspector} aria-label="Inspector">
      <div className={styles.inspectorHead}>
        <span className={styles.dot} style={{ background: channel === null ? 'var(--muted)' : `var(--${channel})` }} />
        <b>{humanRole(id)}</b>
        <span className={styles.mono}>{id}</span>
        <button type="button" className={styles.miniButton} onClick={() => { void navigator.clipboard?.writeText(id) }}>copy</button>
        {shown !== null && <span className={styles.revBadge}>r{shown.rev}</span>}
        {inView.length > 0 && <span className={styles.faint}>{inView.length} instance{inView.length === 1 ? '' : 's'} in view</span>}
        <span className={styles.spacer} />
        <button type="button" className={styles.plain} onClick={() => { store.frame(id) }}>Zoom to</button>
        <button type="button" className={styles.plain} onClick={() => { store.select(id.replace(/@.*$/, '')) }}>All instances</button>
        <button type="button" className={styles.primary} onClick={() => { actions.reference(id, snap.pinnedRev) }}>Reference in chat <kbd>R</kbd></button>
        <button type="button" className={styles.plain} aria-label="Close inspector" onClick={() => { store.select(null) }}>✕</button>
      </div>
      {found.status === 'gone'
        ? <div className={styles.inspectorBody}><span className={styles.muted}>{id} does not exist at r{shown?.rev}: {found.reason}</span></div>
        : (
          <div className={styles.inspectorBody}>
            <div className={styles.inspectorMain}>
              <div className={styles.tabs} role="tablist">
                {(['properties', 'changes', 'timing'] as const).map(t => (
                  <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? styles.tabOn : styles.tab} onClick={() => { setTab(t) }}>
                    {t === 'properties' ? 'Properties' : t === 'changes' ? <>Changes {change?.status === 'changed' && <span className={styles.chgTag}>r{shown?.parent}→r{shown?.rev}</span>}</> : <>Timing {errors.length > 0 && <span className={styles.badTag}>{errors.length}</span>}</>}
                  </button>
                ))}
              </div>
              {tab === 'properties' && (
                <table className={styles.props}>
                  <tbody>{properties(found, model).map(([k, v]) => <tr key={k}><th>{k}</th><td className={styles.mono}>{v}</td></tr>)}</tbody>
                </table>
              )}
              {tab === 'changes' && (
                <div className={styles.changes}>
                  {shown === null || shown.parent === null
                    ? <span className={styles.muted}>r{shown?.rev} is the first revision.</span>
                    : <>
                      <div>r{shown.parent} → r{shown.rev} ({shown.kind}): {shown.cause}</div>
                      {shown.paramDelta.map(c => <div key={c.id} className={styles.mono}>{c.id}: {c.before} → {c.after} {c.unit}</div>)}
                      {shown.roleDiff !== null && <div className={styles.mono}>roles changed: {shown.roleDiff.changed.join(', ') || 'none'}; added: {shown.roleDiff.added.join(', ') || 'none'}; removed: {shown.roleDiff.removed.join(', ') || 'none'}; renamed: {shown.roleDiff.renamed.join(', ') || 'none'}</div>}
                      {shown.recipeDiff !== null && <pre className={styles.diff}>{shown.recipeDiff}</pre>}
                    </>}
                </div>
              )}
              {tab === 'timing' && (
                <div className={styles.changes}>
                  {errors.length === 0 ? <span className={styles.ok}>No timing errors for this element.</span>
                    : errors.map((e, i) => <div key={i} className={styles.mono}>{e.ids[0]}: {e.message}</div>)}
                </div>
              )}
              <div className={styles.fingerprint}>
                {change === null ? null : change.status === 'changed' ? <span className={styles.chg}>● changed in r{shown?.rev}</span> : change.status === 'same' ? <span className={styles.faint}>unchanged since r{shown?.parent}</span> : <span className={styles.faint}>new in r{shown?.rev}</span>}
                {fingerprint && <span className={styles.faint}> · fp {fingerprint.slice(7, 11)}…{fingerprint.slice(-2)}</span>}
              </div>
            </div>
            <div className={styles.source}>
              <div className={styles.sourceHead}>
                <span>Recipe source{span ? ` · ${model.recipe.file ?? 'recipe.py'}:${span.startLine}${span.endLine !== span.startLine ? `–${span.endLine}` : ''}` : ''}</span>
                <span className={styles.faint}>read-only · <button type="button" className={styles.linkButton} onClick={() => { actions.reference(id, snap.pinnedRev) }}>Discuss in chat</button></span>
              </div>
              {lines === null || span === null
                ? <div className={styles.muted}>{span === null ? 'No recipe lines for this element.' : 'Loading…'}</div>
                : (
                  <pre className={styles.code}>
                    {lines.slice(Math.max(0, span.startLine - 4), span.endLine + 3).map((text, i) => {
                      const n = Math.max(0, span.startLine - 4) + i + 1
                      const on = n >= span.startLine && n <= span.endLine
                      return <div key={n} className={on ? styles.codeOn : undefined}><span className={styles.lineNo}>{n}</span>{text}</div>
                    })}
                  </pre>
                )}
            </div>
          </div>
        )}
    </section>
  )
}

export { clampView }
