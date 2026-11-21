/**
 * Scanner profile service: loads one JSON profile of scanner hardware limits
 * and raster times from a profile directory and exposes it as `ctx.scannerProfile`.
 *
 * @module @pulseos/scanner-profile
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Hardware limits of the scanner that sequences are built for. */
    scannerProfile: ScannerProfileService
  }
}

/** Hardware limits and raster times; units are part of each key. */
export interface ScannerLimits {
  b0_T: number
  max_grad_mT_per_m: number
  max_slew_T_per_m_per_s: number
  grad_raster_time_s: number
  rf_raster_time_s: number
  adc_raster_time_s: number
  block_duration_raster_s: number
  rf_dead_time_s: number
  rf_ringdown_time_s: number
  adc_dead_time_s: number
}

/** One scanner profile file: `<directory>/<id>.json`. */
export interface ScannerProfile {
  id: string
  title: string
  description?: string
  limits: ScannerLimits
}

/** Profile directory shipped with the repository. */
export const BUNDLED_PROFILE_DIRECTORY = fileURLToPath(new URL('../../../../profiles/scanner', import.meta.url))

const positive = () => z.number().min(Number.MIN_VALUE).required()
const nonNegative = () => z.number().min(0).required()

const Limits: z<ScannerLimits> = z.object({
  b0_T: positive(),
  max_grad_mT_per_m: positive(),
  max_slew_T_per_m_per_s: positive(),
  grad_raster_time_s: positive(),
  rf_raster_time_s: positive(),
  adc_raster_time_s: positive(),
  block_duration_raster_s: positive(),
  rf_dead_time_s: nonNegative(),
  rf_ringdown_time_s: nonNegative(),
  adc_dead_time_s: nonNegative(),
})

const Profile: z<object, ScannerProfile> = z.object({
  id: z.string().required(),
  title: z.string().required(),
  description: z.string(),
  limits: Limits,
})

const LIMIT_KEYS = Object.keys(Limits.dict!)
const PROFILE_KEYS = Object.keys(Profile.dict!)

function rejectUnknownKeys(value: object, allowed: string[], where: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${where}: unknown field(s) ${unknown.join(', ')}`)
}

/**
 * Read and validate one scanner profile file.
 * @param directory - directory holding `<id>.json` profile files.
 * @param id - profile id; must equal the file's `id` field.
 * @returns the validated profile.
 */
export function loadScannerProfile(directory: string, id: string): ScannerProfile {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`scanner profile id "${id}" must match [a-z0-9][a-z0-9_-]*`)
  const file = join(directory, `${id}.json`)
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file}: expected a JSON object`)
  rejectUnknownKeys(raw, PROFILE_KEYS, file)
  if ('limits' in raw && typeof raw.limits === 'object' && raw.limits !== null) rejectUnknownKeys(raw.limits, LIMIT_KEYS, `${file} limits`)
  let profile: ScannerProfile
  try {
    profile = Profile(raw)
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (profile.id !== id) throw new Error(`${file}: id "${profile.id}" does not match file name "${id}"`)
  return profile
}

/** Selects one scanner profile by id from a profile directory. */
export interface Config {
  /** Profile id: the file name without `.json`. */
  profile: string
  /** Directory holding the profile files. */
  directory: string
}

/** Loads the configured profile at plugin load; a missing or invalid profile fails the load. */
export class ScannerProfileService extends Service {
  static Config: z<Partial<Config>, Config> = z.object({
    profile: z.string().default('generic').description('Scanner profile id: the file name without .json.'),
    directory: z.string().default(BUNDLED_PROFILE_DIRECTORY).description('Directory holding scanner profile JSON files.'),
  })

  /** The loaded profile. */
  readonly profile: ScannerProfile

  constructor(ctx: Context, config: Config) {
    super(ctx, 'scannerProfile')
    this.profile = loadScannerProfile(config.directory, config.profile)
  }

  /**
   * Read the active scanner limits.
   * @returns a copy of the loaded limits.
   */
  limits(): ScannerLimits {
    return { ...this.profile.limits }
  }
}

export default ScannerProfileService
