/** Canvas rendering of the tracks and hit testing against the same layout. */
import type { Channel, SequenceEvent, SequenceModel } from '@pulseos/seq-protocol'
import { eventEnd, formatTime, rfPhase, ticks, waveform, type SequenceIndex, type Viewport } from './geometry.ts'
import { matchesSelection } from './store.ts'

export type RowKey = 'ruler' | 'blocks' | 'rf' | 'rfPhase' | 'gz' | 'gy' | 'gx' | 'adc'
export interface Row { key: RowKey; y: number; h: number }

export interface Palette {
  bg: string; panel: string; line: string; line2: string; text: string; muted: string; faint: string
  accent: string; accentA: string; chg: string; bad: string; ok: string
  rf: string; gz: string; gy: string; gx: string; adc: string
}

export const DARK: Palette = {
  bg: '#0d1015', panel: '#13171e', line: '#242b36', line2: '#2e3643', text: '#e4e8ef', muted: '#8a94a6', faint: '#5b6474',
  accent: '#ff5cc8', accentA: 'rgba(255,92,200,0.10)', chg: '#fb923c', bad: '#ef4444', ok: '#34d399',
  rf: '#f2c14e', gz: '#5fa8ff', gy: '#a78bfa', gx: '#3fd0a0', adc: '#cbd5e1',
}

export const LIGHT: Palette = {
  bg: '#fbfcfd', panel: '#f3f5f8', line: '#e1e5ec', line2: '#cfd5df', text: '#18202b', muted: '#5b6474', faint: '#8a94a6',
  accent: '#d0219c', accentA: 'rgba(208,33,156,0.08)', chg: '#c2560c', bad: '#dc2626', ok: '#059669',
  rf: '#b7791f', gz: '#2563eb', gy: '#7c3aed', gx: '#059669', adc: '#475569',
}

const CHANNEL_OF_ROW: Partial<Record<RowKey, Channel>> = { rf: 'rf', rfPhase: 'rf', gz: 'gz', gy: 'gy', gx: 'gx', adc: 'adc' }

/**
 * Vertical layout of the canvas rows.
 * @param height - canvas CSS height.
 * @param phaseOpen - RF phase lane expanded.
 * @param hidden - hidden channels.
 * @returns rows top to bottom.
 */
export function layoutRows(height: number, phaseOpen: boolean, hidden: readonly Channel[]): Row[] {
  const fixed: [RowKey, number][] = [['ruler', 22], ['blocks', 20]]
  const flex: [RowKey, number][] = []
  if (!hidden.includes('rf')) { flex.push(['rf', 1.3]); fixed.push(['rfPhase', phaseOpen ? 56 : 18]) }
  for (const g of ['gz', 'gy', 'gx'] as const) if (!hidden.includes(g)) flex.push([g, 1])
  if (!hidden.includes('adc')) fixed.push(['adc', 40])
  const fixedTotal = fixed.reduce((s, [, h]) => s + h, 0)
  const flexTotal = flex.reduce((s, [, w]) => s + w, 0)
  const unit = Math.max(0, height - fixedTotal) / Math.max(flexTotal, 1)
  const order: RowKey[] = ['ruler', 'blocks', 'rf', 'rfPhase', 'gz', 'gy', 'gx', 'adc']
  const sizes = new Map<RowKey, number>([...fixed, ...flex.map(([k, w]) => [k, Math.max(40, unit * w)] as [RowKey, number])])
  const rows: Row[] = []
  let y = 0
  for (const key of order) {
    const h = sizes.get(key)
    if (h === undefined) continue
    rows.push({ key, y, h })
    y += h
  }
  return rows
}

export interface DrawInput {
  index: SequenceIndex
  model: SequenceModel
  view: Viewport
  width: number
  rows: Row[]
  palette: Palette
  selection: string | null
  hover: string | null
  chatHighlight: { id: string; strength: number } | null
  flash: { ids: ReadonlySet<string>; strength: number } | null
  cursor: number | null
  gradLimit: number
  errorIds: ReadonlySet<string>
}

function alpha(color: string, a: number): string {
  const n = parseInt(color.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/**
 * Draw the whole track canvas.
 * @param g - 2D context already scaled to CSS pixels.
 * @param input - what to draw.
 */
export function drawTracks(g: CanvasRenderingContext2D, input: DrawInput): void {
  const { index, model, view, width, rows, palette: p } = input
  const height = rows.reduce((s, r) => Math.max(s, r.y + r.h), 0)
  const span = view.t1 - view.t0
  const x = (t: number) => ((t - view.t0) / span) * width
  const pxPerS = width / span
  const row = (k: RowKey) => rows.find(r => r.key === k)
  g.clearRect(0, 0, width, height)
  g.fillStyle = p.bg
  g.fillRect(0, 0, width, height)
  const selected = (id: string) => input.selection !== null && matchesSelection(input.selection, id)
  const dimmed = (id: string) => input.selection !== null && !selected(id)

  // Repetition shading and timing-error bands.
  const blocks = index.blocksIn(view.t0, view.t1)
  for (const b of blocks) {
    if (input.errorIds.has(b.id)) {
      g.fillStyle = alpha(p.bad, 0.12)
      g.fillRect(x(b.t0), row('blocks')?.y ?? 0, Math.max(1, b.duration * pxPerS), height)
    }
  }
  // Selection band behind selected events.
  for (const channel of ['rf', 'gz', 'gy', 'gx', 'adc'] as const) {
    for (const e of index.eventsIn(channel, view.t0, view.t1)) {
      if (!selected(e.id)) continue
      g.fillStyle = p.accentA
      g.fillRect(x(e.t0), (row('blocks')?.y ?? 0) + (row('blocks')?.h ?? 0), Math.max(2, e.duration * pxPerS), height)
    }
  }

  // Ruler and vertical grid.
  const tk = ticks(view, Math.max(2, Math.floor(width / 90)))
  const ruler = row('ruler')!
  g.font = '11px ui-monospace, "JetBrains Mono", Menlo, monospace'
  g.textBaseline = 'middle'
  for (const t of tk.values) {
    const px = Math.round(x(t)) + 0.5
    g.strokeStyle = p.line
    g.lineWidth = 1
    g.setLineDash([2, 4])
    g.beginPath(); g.moveTo(px, ruler.y + ruler.h); g.lineTo(px, height); g.stroke()
    g.setLineDash([])
    g.strokeStyle = p.line2
    g.beginPath(); g.moveTo(px, ruler.y + ruler.h - 5); g.lineTo(px, ruler.y + ruler.h); g.stroke()
    g.fillStyle = p.muted
    g.fillText(formatTime(t, tk.step), px + 3, ruler.y + ruler.h / 2)
  }
  g.strokeStyle = p.line
  g.beginPath(); g.moveTo(0, ruler.y + ruler.h + 0.5); g.lineTo(width, ruler.y + ruler.h + 0.5); g.stroke()

  // Block lane.
  const lane = row('blocks')!
  for (const b of blocks) {
    const bx = x(b.t0)
    const bw = b.duration * pxPerS
    const sel = selected(b.id)
    g.fillStyle = sel ? p.accentA : alpha(p.text, 0.035)
    g.fillRect(bx + 1, lane.y + 2, Math.max(1, bw - 2), lane.h - 4)
    g.strokeStyle = sel ? p.accent : p.line2
    g.strokeRect(bx + 1.5, lane.y + 2.5, Math.max(1, bw - 3), lane.h - 5)
    if (bw > 28) {
      g.save()
      g.beginPath(); g.rect(bx + 2, lane.y, bw - 4, lane.h); g.clip()
      g.fillStyle = sel ? p.accent : p.muted
      g.fillText(b.role, bx + 6, lane.y + lane.h / 2)
      g.restore()
    }
  }

  // Tracks.
  const gradScale = Math.max(index.gradMax, input.gradLimit) * 1.08 || 1
  const rfScale = index.rfMax * 1.15 || 1
  for (const r of rows) {
    const channel = CHANNEL_OF_ROW[r.key]
    if (channel === undefined) continue
    g.strokeStyle = p.line
    g.beginPath(); g.moveTo(0, r.y + r.h + 0.5); g.lineTo(width, r.y + r.h + 0.5); g.stroke()
    const color = p[channel]
    if (r.key === 'gz' || r.key === 'gy' || r.key === 'gx') {
      const zero = r.y + r.h / 2
      const yOf = (v: number) => zero - (v / gradScale) * (r.h / 2 - 4)
      g.strokeStyle = p.line2
      g.beginPath(); g.moveTo(0, zero + 0.5); g.lineTo(width, zero + 0.5); g.stroke()
      if (input.gradLimit > 0) {
        g.setLineDash([3, 4]); g.strokeStyle = alpha(p.bad, 0.45)
        for (const v of [input.gradLimit, -input.gradLimit]) { g.beginPath(); g.moveTo(0, Math.round(yOf(v)) + 0.5); g.lineTo(width, Math.round(yOf(v)) + 0.5); g.stroke() }
        g.setLineDash([])
      }
      for (const e of index.eventsIn(channel, view.t0, view.t1)) drawShape(g, e, model, x, yOf, zero, color, input, selected(e.id), dimmed(e.id), p)
    } else if (r.key === 'rf') {
      const base = r.y + r.h - 6
      const yOf = (v: number) => base - (v / rfScale) * (r.h - 16)
      for (const e of index.eventsIn('rf', view.t0, view.t1)) {
        drawShape(g, e, model, x, yOf, base, color, input, selected(e.id), dimmed(e.id), p)
        if (e.kind === 'rf' && e.duration * pxPerS > 30) {
          g.fillStyle = selected(e.id) ? p.accent : p.muted
          g.textAlign = 'center'
          g.fillText(e.peak.toFixed(1), x(e.t0 + e.duration / 2), yOf(e.peak) - 8)
          g.textAlign = 'left'
        }
      }
    } else if (r.key === 'rfPhase') {
      for (const e of index.eventsIn('rf', view.t0, view.t1)) {
        if (e.kind !== 'rf') continue
        const col = selected(e.id) ? p.accent : alpha(color, dimmed(e.id) ? 0.35 : 0.9)
        if (r.h < 30) {
          const yy = r.y + r.h / 2
          g.strokeStyle = col; g.lineWidth = 2
          g.beginPath(); g.moveTo(x(e.t0), yy); g.lineTo(x(eventEnd(e)), yy); g.stroke(); g.lineWidth = 1
          if (e.duration * pxPerS > 24) { g.fillStyle = p.muted; g.fillText(`${Math.round(((e.phaseOffset * 180) / Math.PI) % 360)}°`, x(eventEnd(e)) + 4, yy) }
        } else {
          const points = rfPhase(e, model)
          if (points === null) continue
          const mid = r.y + r.h / 2
          g.strokeStyle = col
          g.beginPath()
          points.t.forEach((t, i) => { const yy = mid - (points.v[i]! / Math.PI) * (r.h / 2 - 4); if (i === 0) g.moveTo(x(t), yy); else g.lineTo(x(t), yy) })
          g.stroke()
        }
      }
    } else if (r.key === 'adc') {
      for (const e of index.eventsIn('adc', view.t0, view.t1)) {
        if (e.kind !== 'adc') continue
        const ax = x(e.t0)
        const aw = Math.max(1.5, e.duration * pxPerS)
        const sel = selected(e.id)
        g.fillStyle = sel ? p.accentA : alpha(color, dimmed(e.id) ? 0.04 : 0.1)
        g.fillRect(ax, r.y + 8, aw, r.h - 16)
        g.strokeStyle = sel ? p.accent : alpha(color, dimmed(e.id) ? 0.3 : 0.75)
        g.lineWidth = sel ? 2 : 1
        g.strokeRect(ax + 0.5, r.y + 8.5, aw - 1, r.h - 17)
        g.lineWidth = 1
        const dwellPx = e.dwell * pxPerS
        if (dwellPx > 4) {
          g.strokeStyle = alpha(color, 0.5)
          for (let i = 0; i < e.numSamples; i++) { const sx = Math.round(ax + (i + 0.5) * dwellPx) + 0.5; g.beginPath(); g.moveTo(sx, r.y + r.h - 14); g.lineTo(sx, r.y + r.h - 9); g.stroke() }
        }
        if (aw > 120) {
          const line = Object.entries(e.loop).map(([n, i]) => `${n}=${i}`).at(-1) ?? ''
          g.fillStyle = sel ? p.accent : p.muted
          g.fillText(`@${line} · ${e.numSamples} × ${(e.dwell * 1e6).toFixed(1)} us`, ax + 8, r.y + r.h / 2)
        }
        outlineSpecial(g, e.id, ax, r.y + 6, aw, r.h - 12, input, p)
      }
    }
  }

  // Markers.
  const rfRow = row('rf') ?? row('gz')
  for (const m of model.markers) {
    for (const t of [m.t]) {
      if (t < view.t0 || t > view.t1) continue
      const px = Math.round(x(t)) + 0.5
      const sel = selected(m.id)
      g.strokeStyle = sel ? p.accent : alpha(p.muted, 0.8)
      g.setLineDash([4, 3])
      g.beginPath(); g.moveTo(px, lane.y + lane.h); g.lineTo(px, height); g.stroke()
      g.setLineDash([])
      if (rfRow !== undefined) {
        const label = `${m.name} ${((m.t - (m.start ?? 0)) * 1e3).toFixed(2)}`
        const w = g.measureText(label).width + 10
        g.fillStyle = p.panel
        g.fillRect(px + 2, rfRow.y + 4, w, 16)
        g.strokeStyle = sel ? p.accent : p.line2
        g.strokeRect(px + 2.5, rfRow.y + 4.5, w - 1, 15)
        g.fillStyle = sel ? p.accent : p.muted
        g.fillText(label, px + 7, rfRow.y + 12)
      }
    }
  }

  // Cursor.
  if (input.cursor !== null && input.cursor >= view.t0 && input.cursor <= view.t1) {
    const px = Math.round(x(input.cursor)) + 0.5
    g.strokeStyle = alpha(p.text, 0.45)
    g.beginPath(); g.moveTo(px, ruler.y); g.lineTo(px, height); g.stroke()
  }
}

function drawShape(
  g: CanvasRenderingContext2D, e: SequenceEvent, model: SequenceModel, x: (t: number) => number,
  yOf: (v: number) => number, base: number, color: string, input: DrawInput, sel: boolean, dim: boolean, p: Palette,
): void {
  const points = waveform(e, model)
  if (points === null) return
  const x0 = x(e.t0)
  const x1 = x(eventEnd(e))
  const stroke = sel ? p.accent : alpha(color, dim ? 0.4 : 0.95)
  const fill = sel ? alpha(p.accent, 0.22) : alpha(color, dim ? 0.06 : 0.16)
  if (x1 - x0 < 2) {
    let peak = 0
    for (const v of points.v) if (Math.abs(v) > Math.abs(peak)) peak = v
    g.strokeStyle = stroke
    g.beginPath(); g.moveTo(Math.round(x0) + 0.5, base); g.lineTo(Math.round(x0) + 0.5, yOf(peak)); g.stroke()
  } else {
    g.beginPath()
    g.moveTo(x(points.t[0]!), base)
    for (let i = 0; i < points.t.length; i++) g.lineTo(x(points.t[i]!), yOf(points.v[i]!))
    g.lineTo(x(points.t.at(-1)!), base)
    g.closePath()
    g.fillStyle = fill
    g.fill()
    g.strokeStyle = stroke
    g.lineWidth = sel ? 2 : 1.2
    g.stroke()
    g.lineWidth = 1
  }
  const ys = points.v.map(yOf)
  const top = Math.min(base, ...ys)
  const bottom = Math.max(base, ...ys)
  outlineSpecial(g, e.id, x0 - 2, top - 2, Math.max(4, x1 - x0 + 4), bottom - top + 4, input, p)
}

function outlineSpecial(g: CanvasRenderingContext2D, id: string, x: number, y: number, w: number, h: number, input: DrawInput, p: Palette): void {
  if (input.chatHighlight !== null && matchesSelection(input.chatHighlight.id, id)) {
    g.strokeStyle = alpha(p.accent, 0.45 + 0.55 * input.chatHighlight.strength)
    g.lineWidth = 1.5 + 1.5 * input.chatHighlight.strength
    g.strokeRect(x, y, w, h)
    g.lineWidth = 1
  } else if (input.hover !== null && input.hover === id) {
    g.strokeStyle = alpha(p.text, 0.8)
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  }
  if (input.flash !== null && input.flash.strength > 0) {
    for (const changed of input.flash.ids) {
      if (!matchesSelection(changed, id)) continue
      g.strokeStyle = alpha(p.chg, input.flash.strength)
      g.lineWidth = 2
      g.strokeRect(x, y, w, h)
      g.lineWidth = 1
      break
    }
  }
}

const roleLevelId = (id: string) => id.replace(/@.*$/, '')

/** Hit test result. */
export interface Hit { row: RowKey; id: string | null; t: number }

/**
 * Find the element under a point.
 * @param input - the last draw input.
 * @param px - x in CSS pixels.
 * @param py - y in CSS pixels.
 * @param instance - prefer instance IDs over role-level IDs.
 * @returns row, element ID (role-level unless `instance`) and time.
 */
export function hitTest(input: Pick<DrawInput, 'index' | 'model' | 'view' | 'width' | 'rows'>, px: number, py: number, instance: boolean): Hit | null {
  const r = input.rows.find(row => py >= row.y && py < row.y + row.h)
  if (r === undefined) return null
  const span = input.view.t1 - input.view.t0
  const t = input.view.t0 + (px / input.width) * span
  const slop = (6 / input.width) * span
  if (r.key === 'ruler') {
    const marker = input.model.markers.find(m => Math.abs(m.t - t) <= slop)
    return { row: r.key, id: marker?.id ?? null, t }
  }
  if (r.key === 'blocks') {
    const block = input.index.blocksIn(t, t).find(b => t >= b.t0 && t <= b.t0 + b.duration)
    return { row: r.key, id: block === undefined ? null : instance ? block.id : roleLevelId(block.id), t }
  }
  const channel = CHANNEL_OF_ROW[r.key]!
  const candidates = input.index.eventsIn(channel, t - slop, t + slop)
  let best: SequenceEvent | undefined
  let bestDistance = Infinity
  for (const e of candidates) {
    const distance = t < e.t0 ? e.t0 - t : t > eventEnd(e) ? t - eventEnd(e) : 0
    if (distance < bestDistance) { best = e; bestDistance = distance }
  }
  if (best === undefined) {
    const marker = input.model.markers.find(m => Math.abs(m.t - t) <= slop)
    return { row: r.key, id: marker?.id ?? null, t }
  }
  return { row: r.key, id: instance ? best.id : roleLevelId(best.id), t }
}

/**
 * Draw the overview strip: repetitions, RF positions and the viewport brush.
 * @param g - 2D context in CSS pixels.
 * @param index - model index.
 * @param view - current viewport.
 * @param width - CSS width.
 * @param height - CSS height.
 * @param p - palette.
 */
export function drawOverview(g: CanvasRenderingContext2D, index: SequenceIndex, view: Viewport, width: number, height: number, p: Palette): void {
  const total = index.duration || 1
  const x = (t: number) => (t / total) * width
  g.clearRect(0, 0, width, height)
  g.fillStyle = p.bg
  g.fillRect(0, 0, width, height)
  index.repetitions.forEach((rep, i) => {
    if (i % 2 === 1) { g.fillStyle = alpha(p.text, 0.035); g.fillRect(x(rep.start), 0, Math.max(1, x(rep.end) - x(rep.start)), height) }
  })
  g.strokeStyle = alpha(p.rf, 0.7)
  let last = -10
  for (const e of index.byChannel.rf) {
    const px = Math.round(x(e.t0)) + 0.5
    if (px - last < 2) continue
    last = px
    g.beginPath(); g.moveTo(px, 6); g.lineTo(px, height - 6); g.stroke()
  }
  g.strokeStyle = alpha(p.adc, 0.35)
  for (const e of index.byChannel.adc) {
    g.beginPath(); g.moveTo(x(e.t0), height - 4.5); g.lineTo(x(eventEnd(e)), height - 4.5); g.stroke()
  }
  const bx = x(view.t0)
  const bw = Math.max(4, x(view.t1) - bx)
  g.fillStyle = alpha(p.text, 0.12)
  g.fillRect(bx, 1, bw, height - 2)
  g.strokeStyle = p.text
  g.strokeRect(bx + 0.5, 1.5, bw - 1, height - 3)
}
