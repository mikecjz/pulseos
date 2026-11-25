/** Types for scripts/models.mjs. */

/** One entry of a DSH patch list. */
export interface PatchEntry {
  id: string
  config: Record<string, unknown>
}

/** pi-ai catalog routes PulseOS documents, with the key each one reads. */
export declare const KNOWN_ROUTES: Readonly<Record<string, string>>

/** DSH's native DeepSeek route, served by `llm-deepseek` rather than pi-ai. */
export declare const NATIVE_ROUTE: 'deepseek-official'

/**
 * Resolve the model selection from the environment.
 * @param env - process environment.
 * @returns the patch entries to layer over the profile, or `null` for the DeepSeek default.
 */
export declare function modelPatch(env: Record<string, string | undefined>): PatchEntry[] | null
