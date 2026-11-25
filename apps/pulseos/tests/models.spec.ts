/** Unit: PULSEOS_MODEL and PULSEOS_LLM_* resolve to the launcher's model patch. */
import { describe, expect, it } from 'vitest'
import { modelPatch } from '../../../scripts/models.mjs'

describe('modelPatch', () => {
  it('adds nothing without PULSEOS_MODEL, keeping the DeepSeek default', () => {
    expect(modelPatch({})).toBeNull()
    expect(modelPatch({ PULSEOS_MODEL: '  ' })).toBeNull()
  })

  it('declares a catalog route with its standard key and the selected model', () => {
    expect(modelPatch({ PULSEOS_MODEL: 'anthropic/claude-sonnet-4-5' })).toEqual([
      { id: 'llm-pi-ai', config: { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', models: [{ id: 'claude-sonnet-4-5' }] } } } },
      { id: 'agent-default-model', config: { provider: 'anthropic', model: 'claude-sonnet-4-5' } },
    ])
  })

  it('keeps slashes in model ids and applies a base URL override', () => {
    const [piAi, selection] = modelPatch({ PULSEOS_MODEL: 'openrouter/moonshotai/kimi-k2', PULSEOS_LLM_BASE_URL: 'https://proxy.example/api/v1' })!
    expect(piAi!.config).toEqual({ providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY', baseURL: 'https://proxy.example/api/v1', models: [{ id: 'moonshotai/kimi-k2' }] } } })
    expect(selection!.config).toEqual({ provider: 'openrouter', model: 'moonshotai/kimi-k2' })
  })

  it('maps Kimi and GLM to their pi-ai routes', () => {
    expect(modelPatch({ PULSEOS_MODEL: 'moonshotai/kimi-k2' })![0]!.config).toMatchObject({ providers: { moonshotai: { apiKeyEnv: 'MOONSHOT_API_KEY' } } })
    expect(modelPatch({ PULSEOS_MODEL: 'zai/glm-4.6' })![0]!.config).toMatchObject({ providers: { zai: { apiKeyEnv: 'ZAI_API_KEY' } } })
  })

  it('overrides the protocol of a listed route', () => {
    expect(modelPatch({ PULSEOS_MODEL: 'openrouter/acme/new-model', PULSEOS_LLM_API: 'openai-completions' })![0]!.config)
      .toEqual({ providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY', api: 'openai-completions', models: [{ id: 'acme/new-model' }] } } })
  })

  it('declares a custom OpenAI-compatible route from a base URL', () => {
    expect(modelPatch({ PULSEOS_MODEL: 'local/qwen3-32b', PULSEOS_LLM_BASE_URL: 'http://localhost:8000/v1' })![0]).toEqual({
      id: 'llm-pi-ai',
      config: { providers: { local: { apiKeyEnv: 'PULSEOS_LLM_API_KEY', api: 'openai-completions', baseURL: 'http://localhost:8000/v1', models: [{ id: 'qwen3-32b' }] } } },
    })
    expect(modelPatch({ PULSEOS_MODEL: 'gw/claude-x', PULSEOS_LLM_BASE_URL: 'https://gw.example', PULSEOS_LLM_API: 'anthropic-messages' })![0]!.config)
      .toMatchObject({ providers: { gw: { api: 'anthropic-messages' } } })
  })

  it('selects the native DeepSeek route without touching pi-ai', () => {
    expect(modelPatch({ PULSEOS_MODEL: 'deepseek-official/deepseek-pro' })).toEqual([
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-pro' } },
    ])
  })

  it.each([
    [{ PULSEOS_MODEL: 'claude' }, /must be <route>\/<model id>/],
    [{ PULSEOS_MODEL: 'anthropic/' }, /must be <route>\/<model id>/],
    [{ PULSEOS_MODEL: 'Bad Route/x' }, /must be <route>\/<model id>/],
    [{ PULSEOS_MODEL: 'acme/x' }, /custom route needs PULSEOS_LLM_BASE_URL/],
    [{ PULSEOS_MODEL: 'local/x', PULSEOS_LLM_BASE_URL: 'http://h', PULSEOS_LLM_API: 'grpc' }, /PULSEOS_LLM_API must be one of/],
    [{ PULSEOS_MODEL: 'deepseek-official/x', PULSEOS_LLM_BASE_URL: 'http://h' }, /DEEPSEEK_BASE_URL/],
    [{ PULSEOS_LLM_BASE_URL: 'http://h' }, /PULSEOS_MODEL is not/],
  ])('rejects %j', (env, message) => {
    expect(() => modelPatch(env)).toThrow(message)
  })
})
