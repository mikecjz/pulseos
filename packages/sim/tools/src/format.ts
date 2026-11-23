/** Plain-text renderings of simulation runs for tool results and reference context. */
import { formatSimReference, type SimReferenceToken, type SimRunRecord } from '@pulseos/sim-protocol'

function round(value: number, digits = 3): string {
  return Number(value.toPrecision(digits)).toString()
}

function ms(value: number | undefined): string {
  if (value === undefined) return '?'
  return value >= 1000 ? `${round(value / 1000)} s` : `${Math.round(value)} ms`
}

/** Parameters worth quoting next to a contrast, when the revision has them. */
const CONTRAST_PARAMS: [string, (v: number) => string][] = [
  ['TE', v => `${round(v * 1e3)} ms`], ['TR', v => `${round(v * 1e3)} ms`], ['TI', v => `${round(v * 1e3)} ms`],
  ['flip_angle', v => `${round(v)} deg`], ['Ny', v => String(v)], ['Nx', v => String(v)],
]

/**
 * The reference token of a run (engine omitted for the default engine).
 * @param run - the run.
 * @param defaultEngine - the configured default engine.
 * @returns `[[sim:r<rev>/<phantom>]]`.
 */
export function runReference(run: SimRunRecord, defaultEngine: string): string {
  return formatSimReference(run.rev, run.phantom, run.engine === defaultEngine ? null : run.engine)
}

/**
 * Compact summary of one run: identity, grid, signal, per-tissue image means and contrast ratios,
 * and the change from a previous run on the same phantom. No arrays.
 * @param run - the run.
 * @param options - default engine, the revision's parameters, and an earlier run to compare with.
 * @returns lines of text.
 */
export function summarize(run: SimRunRecord, options: { defaultEngine: string; params?: Record<string, number>; previous?: SimRunRecord }): string {
  const lines: string[] = []
  const total = run.timing.totalMs ?? Object.values(run.timing).reduce((a, b) => a + b, 0)
  lines.push(`Simulation ${runReference(run, options.defaultEngine)}: r${run.rev} (${run.seq}) on phantom ${run.phantom} with ${run.engine} ${run.engineVersion}, ${run.device}, ${run.cached ? 'from cache' : ms(total)}.`)
  const { grid, stats } = run
  lines.push(`Acquisition: ${grid.nx} x ${grid.ny} samples, FOV ${round(grid.fov[0] * 1e3)} x ${round(grid.fov[1] * 1e3)} mm${grid.cartesian ? '' : ' (not exactly Cartesian)'}; ${stats.repetitions} repetitions simulated on a ${stats.simResolution}^2 grid.`)
  if (options.params !== undefined) {
    const quoted = CONTRAST_PARAMS.filter(([name]) => options.params![name] !== undefined).map(([name, f]) => `${name} ${f(options.params![name]!)}`)
    if (quoted.length > 0) lines.push(`Sequence at r${run.rev}: ${quoted.join(', ')}.`)
  }
  lines.push(`Signal: peak ${round(stats.signalPeak)}; k-space centre line is ADC ${stats.centreLine} (acquisition order), its peak ${round(stats.echoPeak)}.`)
  lines.push(`Image magnitude: max ${round(stats.imageMax)}, mean ${round(stats.imageMean)}${stats.noiseStd > 0 ? `, noise std ${round(stats.noiseStd)} in k-space` : ', no noise added'}.`)
  const tissues = Object.entries(stats.tissueMeans).toSorted(([, a], [, b]) => b - a)
  if (tissues.length > 0) {
    const top = tissues[0]![1]
    lines.push(`Mean signal per tissue (brightest first, relative to the brightest): ${tissues.map(([name, value]) => `${name} ${round(value)} (${round(value / top, 2)})`).join(', ')}.`)
    if (tissues.length >= 2) {
      const [bright, dark] = [tissues[0]!, tissues.at(-1)!]
      lines.push(`Largest contrast: ${bright[0]}/${dark[0]} = ${round(bright[1] / Math.max(dark[1], 1e-12))}.`)
    }
  }
  if (options.previous !== undefined) {
    const before = options.previous.stats.tissueMeans
    const changes = tissues.filter(([name]) => before[name] !== undefined && before[name] > 0)
      .map(([name, value]) => `${name} ${round(before[name]!)} -> ${round(value)} (${value >= before[name]! ? '+' : ''}${round((value / before[name]! - 1) * 100, 2)}%)`)
    if (changes.length > 0) lines.push(`Compared with r${options.previous.rev} on the same phantom: ${changes.join(', ')}.`)
  }
  if (run.warnings.length > 0) lines.push(`Warnings: ${run.warnings.join('; ')}.`)
  return lines.join('\n')
}

/**
 * The run a reference token names: the latest run of that revision and phantom (and engine, when given).
 * @param runs - the session's runs in order.
 * @param token - the parsed token.
 * @returns the run, or undefined.
 */
export function findRun(runs: readonly SimRunRecord[], token: Pick<SimReferenceToken, 'rev' | 'phantom' | 'engine'>): SimRunRecord | undefined {
  return runs.findLast(r => r.rev === token.rev && r.phantom === token.phantom && (token.engine === null || r.engine === token.engine))
}

/**
 * The previous run on the same phantom and engine at another revision, for comparisons.
 * @param runs - the session's runs.
 * @param run - the run.
 * @returns the earlier run, or undefined.
 */
export function previousRun(runs: readonly SimRunRecord[], run: SimRunRecord): SimRunRecord | undefined {
  const index = runs.indexOf(run)
  return runs.slice(0, index < 0 ? runs.length : index).findLast(r => r.phantom === run.phantom && r.engine === run.engine && r.rev !== run.rev)
}
