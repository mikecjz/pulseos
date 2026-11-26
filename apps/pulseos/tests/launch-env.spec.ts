import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchEnv, readEnvFile } from '../../../scripts/env.mjs'

const PROXY = 'https://user:pass@proxy.example:443'

describe('launcher environment', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('turns on Node env proxy support when HTTPS_PROXY comes from .env', () => {
    dir = mkdtempSync(join(tmpdir(), 'pulseos-env-'))
    writeFileSync(join(dir, '.env'), `HTTPS_PROXY="${PROXY}"\n`)
    const env = launchEnv({ PATH: '/bin' }, readEnvFile(join(dir, '.env')))
    expect(env).toMatchObject({ PATH: '/bin', HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: '1', NO_PROXY: 'localhost,127.0.0.1,::1' })
  })

  it('turns it on for a proxy from the shell, e.g. `infisical run --`', () => {
    expect(launchEnv({ https_proxy: PROXY }).NODE_USE_ENV_PROXY).toBe('1')
  })

  it('leaves the environment alone without a proxy or without .env', () => {
    expect(readEnvFile('/nonexistent/.env')).toEqual({})
    const env = launchEnv({ PATH: '/bin' })
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined()
    expect(env.NO_PROXY).toBeUndefined()
  })

  it('lets the shell win over .env and defaults, and keeps explicit proxy settings', () => {
    const env = launchEnv(
      { HTTPS_PROXY: 'http://shell:1', NODE_USE_ENV_PROXY: '0', no_proxy: 'internal', DSH_HOME: '/mine' },
      { HTTPS_PROXY: PROXY, DEEPSEEK_API_KEY: 'k' },
      { DSH_HOME: '/default' },
    )
    expect(env).toMatchObject({ HTTPS_PROXY: 'http://shell:1', NODE_USE_ENV_PROXY: '0', DEEPSEEK_API_KEY: 'k', DSH_HOME: '/mine' })
    expect(env.NO_PROXY).toBeUndefined()
    expect(launchEnv({}, {}, { DSH_HOME: '/default' }).DSH_HOME).toBe('/default')
  })
})
