/** Pixel and trace computations for the Simulation page (pure, so they are unit-tested). */
import type { ComplexArray } from './store.ts'

/** Colors the canvases draw with. */
export interface Palette { bg: string; line: string; text: string; muted: string; trace: string; accent: string; centre: string }

export const DARK: Palette = { bg: '#0d1015', line: '#242b36', text: '#e4e8ef', muted: '#8a94a6', trace: '#cbd5e1', accent: '#ff5cc8', centre: '#f2c14e' }
export const LIGHT: Palette = { bg: '#fbfcfd', line: '#e1e5ec', text: '#18202b', muted: '#5b6474', trace: '#475569', accent: '#d0219c', centre: '#b7791f' }

export type PixelMode = 'magnitude' | 'phase' | 'log'

/**
 * RGBA pixels of a complex array: magnitude (linear, scaled to the maximum), log magnitude
 * (k-space), or phase (grey from -pi to pi, masked to black below 5% of the peak magnitude).
 * @param array - decoded complex array.
 * @param mode - mapping.
 * @returns `rows * cols * 4` bytes.
 */
export function pixels(array: ComplexArray, mode: PixelMode): Uint8ClampedArray {
  const n = array.rows * array.cols
  const out = new Uint8ClampedArray(n * 4)
  const mag = new Float32Array(n)
  let peak = 0
  for (let i = 0; i < n; i++) {
    const m = Math.hypot(array.data[2 * i]!, array.data[2 * i + 1]!)
    mag[i] = m
    if (m > peak) peak = m
  }
  const logScale = Math.log1p(1e4)
  for (let i = 0; i < n; i++) {
    let v: number
    if (peak === 0) v = 0
    else if (mode === 'magnitude') v = mag[i]! / peak
    else if (mode === 'log') v = Math.log1p(1e4 * mag[i]! / peak) / logScale
    else v = mag[i]! < 0.05 * peak ? 0 : (Math.atan2(array.data[2 * i + 1]!, array.data[2 * i]!) + Math.PI) / (2 * Math.PI)
    const g = Math.round(v * 255)
    out[4 * i] = g
    out[4 * i + 1] = g
    out[4 * i + 2] = g
    out[4 * i + 3] = 255
  }
  return out
}

/**
 * Per-line magnitude envelope of the ADC signal, decimated to at most `width` columns.
 * @param signal - `[adc, samples]` complex array.
 * @param width - columns available.
 * @returns per column the max magnitude, and the overall peak.
 */
export function signalEnvelope(signal: ComplexArray, width: number): { columns: Float32Array; peak: number } {
  const total = signal.rows * signal.cols
  const count = Math.max(1, Math.min(width, total))
  const columns = new Float32Array(count)
  let peak = 0
  for (let i = 0; i < total; i++) {
    const m = Math.hypot(signal.data[2 * i]!, signal.data[2 * i + 1]!)
    const c = Math.min(count - 1, Math.floor(i * count / total))
    if (m > columns[c]!) columns[c] = m
    if (m > peak) peak = m
  }
  return { columns, peak }
}

/**
 * Peak magnitude of one ADC line.
 * @param signal - `[adc, samples]` complex array.
 * @param line - ADC index.
 * @returns the peak.
 */
export function linePeak(signal: ComplexArray, line: number): number {
  let peak = 0
  for (let s = 0; s < signal.cols; s++) {
    const i = line * signal.cols + s
    peak = Math.max(peak, Math.hypot(signal.data[2 * i]!, signal.data[2 * i + 1]!))
  }
  return peak
}

/**
 * Format a number for labels with 3 significant digits.
 * @param value - number.
 * @returns text.
 */
export function num(value: number): string {
  if (value === 0) return '0'
  return Math.abs(value) >= 1e4 || Math.abs(value) < 1e-2 ? value.toExponential(2) : Number(value.toPrecision(3)).toString()
}
