/**
 * The `pulseos.sim/1` MCP tool contract. Every simulation engine is an MCP server with these three
 * tools; `ctx.pulseSim` is its only client. Large arrays never travel in MCP messages: `simulate`
 * writes them to `<result directory>/<resultKey>/` (shared with the host) and returns metadata.
 */

export const SIM_PROTOCOL = 'pulseos.sim/1'

/** Tool names of the contract. */
export const SIM_TOOLS = { info: 'engine_info', phantoms: 'list_phantoms', simulate: 'simulate' } as const

/** `engine_info` result. */
export interface EngineInfo {
  protocol: string
  /** Engine ID, e.g. `mrzero`. */
  engine: string
  title: string
  /** Version of the MCP server. */
  version: string
  /** Version of the simulator library; part of the result cache key. */
  engineVersion: string
  /** `cuda:N` or `cpu`. */
  device: string
  gpu: string | null
  license: string
  source?: string
}

/** One phantom from `list_phantoms`. */
export interface PhantomInfo {
  id: string
  title: string
  description: string
  /** Voxels in x, y, z. */
  dims: [number, number, number]
  /** Extent in metres. */
  fov: [number, number, number]
  tissues: string[]
  /** Content hash of the maps; part of the result cache key. */
  hash: string
}

/** Simulation settings; every field is optional and engines document their defaults. */
export interface SimSettings {
  /** Simulation grid (voxels per side); default the sequence matrix. */
  resolution?: number
  /** PDG state budget. */
  maxStates?: number
  minStateMag?: number
  minEmitted?: number
  minLatent?: number
  /** Complex Gaussian noise, as a fraction of the peak signal. */
  noise?: number
  /** Use the phantom's B0 / B1 maps. */
  b0?: boolean
  b1?: boolean
}

/** `simulate` arguments. */
export interface SimulateArgs {
  seqText: string
  seqHash: string
  phantom: string
  /** 64 lowercase hex digits: the result directory name. */
  resultKey: string
  settings?: SimSettings
}

/** Names of the stored arrays. */
export type SimPart = 'signal' | 'kspace' | 'image'
export const SIM_PARTS: readonly SimPart[] = ['image', 'kspace', 'signal']

/** One stored array: interleaved little-endian complex64, row-major. */
export interface PartInfo { file: string; shape: number[]; dtype: 'complex64' }

/** Acquisition grid the engine inferred from the ADC trajectory. */
export interface SimGrid {
  nx: number
  ny: number
  /** Field of view in metres (x, y), from the k-space step. */
  fov: [number, number]
  cartesian: boolean
  samplesPerAdc: number
  adcCount: number
}

/** Summary numbers of one result. */
export interface SimStats {
  signalPeak: number
  /** Peak magnitude of the k-space centre line. */
  echoPeak: number
  /** ADC index (acquisition order) of the k-space centre line. */
  centreLine: number
  imageMax: number
  imageMean: number
  noiseStd: number
  /** Mean image magnitude inside each tissue of the phantom. */
  tissueMeans: Record<string, number>
  simResolution: number
  repetitions: number
}

/** `simulate` structured result. */
export interface SimulateReply {
  resultKey: string
  parts: Record<SimPart, PartInfo>
  stats: SimStats
  timing: Record<string, number>
  grid: SimGrid
  warnings: string[]
  device: string
  phantomHash: string
}

const HEX64 = /^[0-9a-f]{64}$/

/**
 * Whether a string is a result key (64 lowercase hex digits).
 * @param key - candidate.
 * @returns true for a well-formed key.
 */
export function isResultKey(key: string): boolean {
  return HEX64.test(key)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Check a `simulate` reply from an engine. Engines run out of process, so their replies are input.
 * @param value - `structuredContent` of the tool result.
 * @returns the reply.
 * @throws Error naming the first problem.
 */
export function parseSimulateReply(value: unknown): SimulateReply {
  if (!isObject(value)) throw new Error('simulate returned no structured content')
  const { resultKey, parts, stats, grid } = value
  if (typeof resultKey !== 'string' || !isResultKey(resultKey)) throw new Error('simulate returned no valid resultKey')
  if (!isObject(parts)) throw new Error('simulate returned no parts')
  for (const name of SIM_PARTS) {
    const part = parts[name]
    if (!isObject(part) || typeof part.file !== 'string' || !/^[a-z]+\.c64$/.test(part.file) || !Array.isArray(part.shape)) {
      throw new Error(`simulate returned no valid "${name}" part`)
    }
  }
  if (!isObject(stats) || typeof stats.signalPeak !== 'number' || !isObject(stats.tissueMeans)) throw new Error('simulate returned no valid stats')
  if (!isObject(grid) || typeof grid.nx !== 'number' || typeof grid.ny !== 'number') throw new Error('simulate returned no valid grid')
  return {
    warnings: [], timing: {}, device: 'unknown', phantomHash: '',
    ...value,
  } as unknown as SimulateReply
}

/**
 * Check an `engine_info` reply.
 * @param value - `structuredContent`.
 * @returns the engine info.
 */
export function parseEngineInfo(value: unknown): EngineInfo {
  if (!isObject(value) || typeof value.engine !== 'string' || typeof value.engineVersion !== 'string') throw new Error('engine_info returned no engine and engineVersion')
  if (value.protocol !== SIM_PROTOCOL) throw new Error(`the engine speaks ${String(value.protocol)}, expected ${SIM_PROTOCOL}`)
  return value as unknown as EngineInfo
}

/**
 * Check a `list_phantoms` reply.
 * @param value - `structuredContent`.
 * @returns the phantoms.
 */
export function parsePhantoms(value: unknown): PhantomInfo[] {
  if (!isObject(value) || !Array.isArray(value.phantoms)) throw new Error('list_phantoms returned no phantoms')
  for (const p of value.phantoms) if (!isObject(p) || typeof p.id !== 'string' || typeof p.hash !== 'string') throw new Error('list_phantoms returned a phantom without id or hash')
  return value.phantoms as PhantomInfo[]
}

/**
 * Decode a stored part into interleaved float pairs.
 * @param bytes - file content.
 * @param part - its shape.
 * @returns re/im interleaved values.
 */
export function decodePart(bytes: ArrayBuffer, part: Pick<PartInfo, 'shape'>): Float32Array {
  const count = part.shape.reduce((a, b) => a * b, 1)
  if (bytes.byteLength !== count * 8) throw new Error(`part has ${bytes.byteLength} bytes, expected ${count * 8}`)
  return new Float32Array(bytes)
}
