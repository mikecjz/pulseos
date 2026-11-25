/**
 * Model selection for the PulseOS launcher.
 *
 * DeepSeek (DSH's native `deepseek-official` route) stays the default. Setting
 * `PULSEOS_MODEL=<route>/<model id>` makes the launcher add one more `--patch`
 * layer that points fresh agents at that model and, for any route other than
 * `deepseek-official`, declares it on DSH's pi-ai adapter (`llm-pi-ai`). That
 * one adapter covers every provider: OpenAI-compatible Chat Completions
 * endpoints (OpenAI, OpenRouter, Kimi, GLM, DeepSeek, self-hosted servers) and
 * Anthropic's native Messages API.
 *
 * Without `PULSEOS_MODEL` no layer is added, so the Web Models page stays the
 * place to add providers: a command-line patch takes precedence over Models
 * page writes to the same entries.
 */

/** pi-ai catalog routes PulseOS documents, with the key each one reads. */
export const KNOWN_ROUTES = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY',
  zai: 'ZAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}

/** DSH's native DeepSeek route, served by `llm-deepseek` rather than pi-ai. */
export const NATIVE_ROUTE = 'deepseek-official'

/** Wire protocols a custom route may declare. */
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']

const ROUTE_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * Resolve the model selection from the environment.
 * @param env - process environment.
 * @returns the patch entries to layer over the profile, or `null` when
 *   `PULSEOS_MODEL` is unset and the DeepSeek default applies.
 * @throws Error naming the variable when the selection is malformed.
 */
export function modelPatch(env) {
  const selection = env.PULSEOS_MODEL?.trim()
  if (!selection) {
    for (const name of ['PULSEOS_LLM_BASE_URL', 'PULSEOS_LLM_API', 'PULSEOS_LLM_API_KEY']) {
      if (env[name]) throw new Error(`${name} is set but PULSEOS_MODEL is not; set PULSEOS_MODEL=<route>/<model id>`)
    }
    return null
  }
  const slash = selection.indexOf('/')
  const route = slash > 0 ? selection.slice(0, slash) : ''
  const model = slash > 0 ? selection.slice(slash + 1) : ''
  if (!ROUTE_PATTERN.test(route) || model === '') {
    throw new Error(`PULSEOS_MODEL must be <route>/<model id>, e.g. anthropic/claude-sonnet-4-5; got "${selection}"`)
  }
  const baseURL = env.PULSEOS_LLM_BASE_URL?.trim() || undefined
  const api = env.PULSEOS_LLM_API?.trim() || undefined
  if (api !== undefined && !APIS.includes(api)) {
    throw new Error(`PULSEOS_LLM_API must be one of ${APIS.join(', ')}; got "${api}"`)
  }
  const defaultModel = { id: 'agent-default-model', config: { provider: route, model } }
  if (route === NATIVE_ROUTE) {
    if (baseURL !== undefined || api !== undefined || env.PULSEOS_LLM_API_KEY) {
      throw new Error(`${NATIVE_ROUTE} takes its key and endpoint from DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL, not PULSEOS_LLM_*`)
    }
    return [defaultModel]
  }
  const known = Object.hasOwn(KNOWN_ROUTES, route)
  if (!known && baseURL === undefined) {
    throw new Error(`PULSEOS_MODEL route "${route}" is not one of ${[NATIVE_ROUTE, ...Object.keys(KNOWN_ROUTES)].join(', ')}; a custom route needs PULSEOS_LLM_BASE_URL`)
  }
  const profile = {
    apiKeyEnv: known ? KNOWN_ROUTES[route] : 'PULSEOS_LLM_API_KEY',
    // A listed route takes its protocol from the catalog unless overridden,
    // which a multi-protocol route such as OpenRouter needs for a model the
    // catalog does not describe.
    ...(known && api === undefined ? {} : { api: api ?? 'openai-completions' }),
    ...(baseURL === undefined ? {} : { baseURL }),
    // Naming the model keeps an id newer than the installed catalog usable;
    // a catalog model keeps its catalog metadata.
    models: [{ id: model }],
  }
  return [{ id: 'llm-pi-ai', config: { providers: { [route]: profile } } }, defaultModel]
}
