/** The Simulation page body. */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SimRunRecord } from '@pulseos/sim-protocol'
import type { SimPanelState } from '../routes.ts'
import { DARK, LIGHT, linePeak, num, pixels, signalEnvelope, type Palette, type PixelMode } from './draw.ts'
import { phantomChoices, shownRun, type ComplexArray, type SimSnapshot, type SimStore, type SimView } from './store.ts'
import type { SchemeSource } from './theme.ts'
import styles from './panel.module.css'

/** Actions the page needs from the host page. */
export interface PanelActions {
  /** Insert a `[[sim:...]]` chip for a run into this session's composer. */
  reference(run: SimRunRecord): boolean
}

export interface PanelProps {
  sessionId: string
  store: SimStore
  actions: PanelActions
  scheme: SchemeSource
}

const VIEWS: [SimView, string][] = [['image', 'Image'], ['kspace', 'k-space'], ['signal', 'Signal']]

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

const seconds = (ms: number | undefined) => (ms === undefined ? '?' : ms >= 1000 ? `${num(ms / 1000)} s` : `${Math.round(ms)} ms`)

/** Total time and the phases the engine reported, e.g. `0.85 s (graph 24 ms · simulate 601 ms · recon 1 ms)`. */
function timingText(timing: Record<string, number>): string {
  const phases = ([['graphMs', 'graph'], ['simulateMs', 'simulate'], ['recoMs', 'recon']] as const)
    .filter(([key]) => timing[key] !== undefined).map(([key, label]) => `${label} ${seconds(timing[key])}`)
  const total = timing.totalMs ?? Object.values(timing).reduce((a, b) => a + b, 0)
  return phases.length > 0 ? `${seconds(total)} (${phases.join(' · ')})` : seconds(total)
}

function runLabel(run: SimRunRecord, state: SimPanelState): string {
  return `r${run.rev} · ${run.phantom}${run.engine === state.defaults.engine ? '' : ` · ${run.engine}`}`
}

export function Panel({ sessionId, store, actions, scheme }: PanelProps) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const theme = useSyncExternalStore(scheme.subscribe, scheme.getSnapshot, scheme.getSnapshot)
  const palette = theme === 'dark' ? DARK : LIGHT
  useEffect(() => {
    if (snap.toast === null) return
    const timer = setTimeout(() => { store.dismissToast() }, 4500)
    return () => { clearTimeout(timer) }
  }, [snap.toast, store])

  const state = snap.state
  const run = shownRun(snap)
  const latestRev = state?.revisions.at(-1)?.rev ?? null
  const job = state?.jobs.find(j => j.state === 'running') ?? state?.jobs[0] ?? null
  const engineId = snap.pick.engine ?? state?.defaults.engine ?? ''
  const engine = state?.engines.find(e => e.id === engineId) ?? null
  const failure = state?.lastFailure !== null && state?.lastFailure !== undefined && state.lastFailure.afterRuns === state.runs.length && job === null
    ? state.lastFailure : null

  return (
    <div className={styles.root} data-pulseos-sim={sessionId} data-theme={theme} tabIndex={-1}>
      {state !== null && <Toolbar snap={snap} state={state} store={store} busy={job !== null} />}
      {snap.status === 'unavailable' && (
        <div className={styles.bannerBad} role="alert">
          Simulation service unavailable — {snap.error}
          <button type="button" className={styles.linkButton} onClick={() => { void store.refresh() }}>Retry</button>
        </div>
      )}
      {job !== null && (
        <div className={styles.progress} role="status" aria-label="Simulation progress">
          <span className={styles.spinner} aria-hidden="true" />
          <span>
            {job.state === 'queued' ? 'Queued' : engine?.status === 'starting' && job.progress === null ? `Starting ${job.engine}` : 'Simulating'} r{job.rev} · {job.phantom}
            {job.progress !== null && job.progress.total !== null ? ` · ${job.progress.done}/${job.progress.total} repetitions` : ''}
            {state!.jobs.length > 1 ? ` (+${state!.jobs.length - 1} queued)` : ''}
          </span>
          <span className={styles.bar}><span style={{ width: `${job.progress?.total ? Math.round(100 * job.progress.done / job.progress.total) : 0}%` }} /></span>
          <button type="button" className={styles.plain} onClick={() => { void store.cancel() }}>Cancel</button>
        </div>
      )}
      {engine?.status === 'unavailable' && (
        <div className={styles.bannerBad} role="alert" data-pulseos-sim-unavailable="">
          <b>The {engine.id} engine is unavailable.</b>
          <pre className={styles.trace}>{engine.error}</pre>
          <button type="button" className={styles.linkButton} onClick={() => { void store.connect(engine.id) }}>Retry</button>
        </div>
      )}
      {failure !== null && failure.error.kind !== 'unavailable' && (
        <div className={styles.bannerBad} role="alert" data-pulseos-sim-failed="">
          <span>Simulation of r{failure.rev} on {failure.phantom} {failure.error.kind === 'cancelled' ? 'was cancelled' : `failed (${failure.error.kind})`}: {failure.error.message}</span>
          <button type="button" className={styles.linkButton} onClick={() => { void store.simulate({ rev: failure.rev, phantom: failure.phantom, engine: failure.engine }) }}>Retry</button>
        </div>
      )}
      {run !== null && latestRev !== null && run.rev < latestRev && job === null && (
        <div className={styles.bannerInfo} data-pulseos-sim-stale="">
          <span className={styles.badge}>stale</span>
          The sequence changed since this run (r{run.rev} → r{latestRev}).
          <button type="button" className={styles.linkButton} onClick={() => { void store.simulate({ rev: latestRev, phantom: run.phantom, engine: run.engine }) }}>Simulate r{latestRev}</button>
        </div>
      )}
      {state === null || run === null
        ? <EmptyState snap={snap} store={store} running={job !== null} />
        : <Result run={run} state={state} snap={snap} store={store} actions={actions} palette={palette} />}
      {snap.toast !== null && <div className={styles.toast} role="status">{snap.toast}</div>}
    </div>
  )
}

function Toolbar({ snap, state, store, busy }: { snap: SimSnapshot; state: SimPanelState; store: SimStore; busy: boolean }) {
  const latest = state.revisions.at(-1)
  const engineId = snap.pick.engine ?? state.defaults.engine
  const phantoms = phantomChoices(state, engineId)
  const phantom = snap.pick.phantom ?? state.defaults.phantom
  const engine = state.engines.find(e => e.id === engineId)
  const dot = engine?.status === 'ready' ? styles.ok : engine?.status === 'unavailable' ? styles.bad : engine?.status === 'starting' ? styles.chg : styles.faintDot
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Simulation toolbar">
      <label className={styles.chipBox}>
        rev
        <select className={styles.select} aria-label="Revision" value={snap.pick.rev ?? 'latest'} disabled={latest === undefined}
          onChange={(e) => { store.setPick({ rev: e.target.value === 'latest' ? null : Number(e.target.value) }) }}>
          <option value="latest">{latest === undefined ? 'none' : `latest (r${latest.rev})`}</option>
          {state.revisions.toReversed().map(r => <option key={r.rev} value={r.rev}>r{r.rev} · {r.cause}</option>)}
        </select>
      </label>
      <label className={styles.chipBox}>
        phantom
        <select className={styles.select} aria-label="Phantom" value={phantom} onChange={(e) => { store.setPick({ phantom: e.target.value }) }}>
          {phantoms.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      </label>
      <label className={styles.chipBox} title={engine?.info ? `${engine.info.title} ${engine.info.engineVersion} · ${engine.info.device}${engine.info.gpu ? ` (${engine.info.gpu})` : ''} · ${engine.info.license}` : `${engineId}: ${engine?.status ?? 'unknown'} (starts on the first simulation)`}>
        <span className={`${styles.dot} ${dot}`} aria-label={`engine ${engine?.status ?? 'unknown'}`} />
        <select className={styles.select} aria-label="Engine" value={engineId} onChange={(e) => { store.setPick({ engine: e.target.value, phantom: null }) }}>
          {state.engines.map(e => <option key={e.id} value={e.id}>{e.id}{e.info ? ` ${e.info.device}` : ''}</option>)}
        </select>
      </label>
      <span className={styles.spacer} />
      <button type="button" className={styles.primary} disabled={latest === undefined} onClick={() => { void store.simulate() }}
        title={busy ? 'Queue another simulation' : 'Simulate the chosen revision'}>
        ▶ Simulate
      </button>
    </div>
  )
}

function EmptyState({ snap, store, running }: { snap: SimSnapshot; store: SimStore; running: boolean }) {
  if (snap.status === 'loading') return <div className={styles.empty}><span className={styles.spinner} /> Loading…</div>
  const state = snap.state
  if (state === null) return <div className={styles.empty} />
  if (state.revisions.length === 0) {
    return (
      <div className={styles.empty} data-pulseos-sim-empty="no-sequence">
        <div className={styles.emptyTitle}>No sequence built yet</div>
        <div className={styles.muted}>Build the sequence in chat or in the Sequence tab, then simulate it here.</div>
      </div>
    )
  }
  const latest = state.revisions.at(-1)!
  return (
    <div className={styles.empty} data-pulseos-sim-empty="no-run">
      <div className={styles.emptyTitle}>{running ? 'Simulating…' : 'No simulation yet'}</div>
      <div className={styles.muted}>Simulate the sequence on a digital phantom to see the image, k-space and ADC signal. Ask in chat, or:</div>
      {!running && (
        <button type="button" className={styles.primary} onClick={() => { void store.simulate() }}>
          Simulate r{snap.pick.rev ?? latest.rev} on {snap.pick.phantom ?? state.defaults.phantom}
        </button>
      )}
    </div>
  )
}

function Result({ run, state, snap, store, actions, palette }: { run: SimRunRecord; state: SimPanelState; snap: SimSnapshot; store: SimStore; actions: PanelActions; palette: Palette }) {
  const [referenced, setReferenced] = useState<string | null>(null)
  const tissues = Object.entries(run.stats.tissueMeans).toSorted(([, a], [, b]) => b - a)
  const top = tissues[0]?.[1] ?? 1
  const timing = run.timing
  return (
    <div className={styles.result}>
      <div className={styles.toolbar} role="toolbar" aria-label="Result toolbar">
        <label className={styles.chipBox}>
          run
          <select className={styles.select} aria-label="Run" value={snap.pinnedRun ?? 'latest'} onChange={(e) => { store.pin(e.target.value === 'latest' ? null : e.target.value) }}>
            <option value="latest">latest ({runLabel(state.runs.at(-1)!, state)})</option>
            {state.runs.toReversed().map(r => <option key={r.id} value={r.id}>{runLabel(r, state)} · {r.cause}</option>)}
          </select>
        </label>
        <span className={styles.segmented} role="tablist" aria-label="View">
          {VIEWS.map(([view, label]) => (
            <button key={view} type="button" role="tab" aria-selected={snap.view === view} className={snap.view === view ? styles.on : ''} onClick={() => { store.setView(view) }}>{label}</button>
          ))}
        </span>
        {snap.view === 'image' && (
          <span className={styles.segmented} aria-label="Image component">
            <button type="button" aria-pressed={!snap.phase} className={snap.phase ? '' : styles.on} onClick={() => { if (snap.phase) store.togglePhase() }}>|M|</button>
            <button type="button" aria-pressed={snap.phase} className={snap.phase ? styles.on : ''} onClick={() => { if (!snap.phase) store.togglePhase() }}>∠</button>
          </span>
        )}
        <span className={styles.spacer} />
        <button type="button" className={styles.plain} title="Insert a [[sim:...]] reference to this run into the composer"
          onClick={() => { setReferenced(actions.reference(run) ? run.id : null) }}>
          {referenced === run.id ? 'Referenced ✓' : 'Reference in chat'}
        </button>
      </div>
      {snap.view === 'signal'
        ? <SignalView run={run} store={store} palette={palette} />
        : <ImageView run={run} store={store} palette={palette} mode={snap.view === 'kspace' ? 'log' : snap.phase ? 'phase' : 'magnitude'} />}
      {tissues.length > 0 && (
        <table className={styles.tissues} aria-label="Mean signal per tissue">
          <tbody>
            {tissues.map(([name, value]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td className={styles.mono}>{num(value)}</td>
                <td className={styles.barCell}><span className={styles.tissueBar} style={{ width: `${Math.round(100 * value / top)}%` }} /></td>
                <td className={`${styles.mono} ${styles.muted}`}>{(value / top).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className={styles.footer}>
        <span>{run.engine} {run.engineVersion} · {run.device}</span>
        <span>{run.cached ? 'from cache' : timingText(timing)}</span>
        <span>{run.grid.nx}×{run.grid.ny} · FOV {num(run.grid.fov[0] * 1e3)} mm · {run.stats.repetitions} TRs</span>
        {run.warnings.map(w => <span key={w} className={styles.chg}>⚠ {w}</span>)}
      </div>
    </div>
  )
}

function ImageView({ run, store, palette, mode }: { run: SimRunRecord; store: SimStore; palette: Palette; mode: PixelMode }) {
  useSyncExternalStore(store.subscribe, () => store.getSnapshot().loaded, () => 0)
  const part = mode === 'log' ? 'kspace' : 'image'
  const array = store.loadedPart(run.resultKey, part)
  const [box, size] = useSize<HTMLDivElement>()
  const canvas = useRef<HTMLCanvasElement>(null)
  const side = Math.max(0, Math.floor(Math.min(size.width, size.height) - 8))
  useEffect(() => {
    const element = canvas.current
    if (element === null || side === 0) return
    const g = prepareCanvas(element, side, side)
    if (g === null) return
    g.fillStyle = palette.bg
    g.fillRect(0, 0, side, side)
    if (array === undefined) return
    const bitmap = document.createElement('canvas')
    bitmap.width = array.cols
    bitmap.height = array.rows
    bitmap.getContext('2d')!.putImageData(new ImageData(pixels(array, mode) as Uint8ClampedArray<ArrayBuffer>, array.cols, array.rows), 0, 0)
    g.imageSmoothingEnabled = false
    g.drawImage(bitmap, 0, 0, side, side)
  }, [array, side, mode, palette])
  const what = part === 'kspace' ? 'k-space (log magnitude)' : mode === 'phase' ? 'image phase' : 'image magnitude'
  return (
    <div className={styles.canvasBox} ref={box}>
      <canvas ref={canvas} role="img" aria-label={`Simulated ${what}, r${run.rev}, ${run.phantom}`} data-loaded={array === undefined ? 'false' : 'true'} />
      {array === undefined && <span className={styles.overlay}><span className={styles.spinner} /></span>}
    </div>
  )
}

function SignalView({ run, store, palette }: { run: SimRunRecord; store: SimStore; palette: Palette }) {
  useSyncExternalStore(store.subscribe, () => store.getSnapshot().loaded, () => 0)
  const signal = store.loadedPart(run.resultKey, 'signal')
  const ids = store.adcIds(run.rev)
  const [box, size] = useSize<HTMLDivElement>()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ line: number; x: number } | null>(null)
  const width = Math.max(0, Math.floor(size.width))
  const height = Math.max(0, Math.floor(size.height))
  useEffect(() => {
    const element = canvas.current
    if (element === null || width === 0 || height === 0) return
    const g = prepareCanvas(element, width, height)
    if (g === null) return
    g.fillStyle = palette.bg
    g.fillRect(0, 0, width, height)
    if (signal === undefined) return
    const { columns, peak } = signalEnvelope(signal, width)
    const top = 8
    const plot = height - top - 18
    const lineWidth = width / signal.rows
    // Centre line of k-space, and the hovered line.
    g.fillStyle = palette.centre
    g.globalAlpha = 0.18
    g.fillRect(run.stats.centreLine * lineWidth, top, Math.max(1, lineWidth), plot)
    if (hover !== null) {
      g.fillStyle = palette.accent
      g.fillRect(hover.line * lineWidth, top, Math.max(1, lineWidth), plot)
    }
    g.globalAlpha = 1
    g.strokeStyle = palette.trace
    g.beginPath()
    for (let x = 0; x < columns.length; x++) {
      const y = top + plot - (peak === 0 ? 0 : plot * columns[x]! / peak)
      if (x === 0) g.moveTo(x * width / columns.length, y)
      else g.lineTo(x * width / columns.length, y)
    }
    g.stroke()
    g.fillStyle = palette.muted
    g.font = '11px ui-monospace, monospace'
    g.fillText(`|signal| per ADC, ${signal.rows} lines × ${signal.cols} samples; peak ${num(peak)}`, 4, height - 4)
  }, [signal, width, height, palette, hover, run.stats.centreLine])
  const line = hover?.line ?? null
  return (
    <div className={styles.canvasBox} ref={box}>
      <canvas
        ref={canvas} role="img" aria-label={`Simulated ADC signal, r${run.rev}, ${run.phantom}`} data-loaded={signal === undefined ? 'false' : 'true'}
        onMouseMove={(e) => {
          if (signal === undefined) return
          const rect = e.currentTarget.getBoundingClientRect()
          const at = Math.min(signal.rows - 1, Math.max(0, Math.floor((e.clientX - rect.left) / rect.width * signal.rows)))
          setHover({ line: at, x: e.clientX - rect.left })
        }}
        onMouseLeave={() => { setHover(null) }}
      />
      {signal !== undefined && line !== null && (
        <div className={styles.tooltip} style={{ left: Math.min(hover!.x + 12, Math.max(0, width - 270)), top: 10 }} data-pulseos-sim-adc={ids?.[line] ?? `adc ${line}`}>
          <div className={styles.mono}>{ids?.[line] ?? `ADC ${line}`}</div>
          <div className={styles.muted}>ADC {line} of {signal.rows}{line === run.stats.centreLine ? ' · k-space centre' : ''} · peak {num(linePeak(signal as ComplexArray, line))}</div>
        </div>
      )}
      {signal === undefined && <span className={styles.overlay}><span className={styles.spinner} /></span>}
    </div>
  )
}
