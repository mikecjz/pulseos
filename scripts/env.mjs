/**
 * Environment for the DSH child process started by scripts/dsh.mjs.
 *
 * - Variables from the repository's git-ignored `.env` (team secrets, see
 *   docs/secrets.md) fill in anything the shell has not set; the shell wins.
 * - When an HTTP(S) proxy is configured, Node's built-in env proxy support is
 *   switched on (`NODE_USE_ENV_PROXY=1`) so fetch and node:http/https in DSH
 *   route through it, and loopback hosts bypass it unless NO_PROXY is set.
 */
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
const LOOPBACK = 'localhost,127.0.0.1,::1'

/** Parses a dotenv file; a missing file yields no variables. */
export function readEnvFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {}
}

/**
 * @param {Record<string, string | undefined>} base process environment
 * @param {Record<string, string>} fromFile variables read from `.env`
 * @param {Record<string, string>} defaults used only when neither sets the key
 */
export function launchEnv(base, fromFile = {}, defaults = {}) {
  const env = { ...defaults, ...fromFile }
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  if (PROXY_KEYS.some(key => env[key]) && env.NODE_USE_ENV_PROXY === undefined) {
    env.NODE_USE_ENV_PROXY = '1'
    if (env.NO_PROXY === undefined && env.no_proxy === undefined) env.NO_PROXY = LOOPBACK
  }
  return env
}
