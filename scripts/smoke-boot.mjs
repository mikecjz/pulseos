/**
 * Boot smoke for the PulseOS composition, keyless.
 *
 * 1. `dsh web` with the PulseOS overlay boots and its HTTP server answers.
 *    The browser authentication fence may answer 401 to a non-browser
 *    client; any status below 500 counts as a live server.
 * 2. The same boot with an unknown scanner profile id prints the scanner
 *    profile load error, which shows the PulseOS plugins are part of the
 *    composed app and that a bad profile fails loudly.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const launcher = fileURLToPath(new URL('./dsh.mjs', import.meta.url))
const BOOT_TIMEOUT_MS = Number(process.env.PULSEOS_SMOKE_TIMEOUT_MS ?? 180_000)

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function boot(extraArgs, homeDir) {
  const child = spawn(process.execPath, [launcher, 'web', ...extraArgs], {
    env: { ...process.env, DSH_HOME: homeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)))
  return { child, exited, output: () => output }
}

async function stop(run) {
  if (run.child.exitCode === null) run.child.kill('SIGTERM')
  const timer = setTimeout(() => run.child.kill('SIGKILL'), 10_000)
  await run.exited
  clearTimeout(timer)
}

async function waitFor(predicate, run, what) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await predicate()) return
    if (run.child.exitCode !== null) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`${what} did not happen (exit code ${run.child.exitCode}).\n--- dsh output ---\n${run.output()}`)
}

async function servesWebUi(homeDir) {
  const port = await freePort()
  const run = boot(['--no-open', '--host', '127.0.0.1', '--port', String(port)], homeDir)
  try {
    let url
    await waitFor(() => {
      url = /dsh web: (http\S+)/.exec(run.output())?.[1]
      return url !== undefined
    }, run, 'dsh web printing its URL')
    const response = await fetch(url)
    if (response.status >= 500) throw new Error(`GET ${url.replace(/token=[^&]+/, 'token=…')} returned HTTP ${response.status}`)
    console.log(`PASS dsh web with the PulseOS overlay answers HTTP ${response.status} on port ${port}`)
  } finally {
    await stop(run)
  }
}

async function badProfileFailsLoudly(homeDir, scratch) {
  const overlay = join(scratch, 'bad-profile.patch.yml')
  writeFileSync(overlay, '- id: pulseos-scanner-profile\n  config:\n    profile: no-such-scanner\n')
  const port = await freePort()
  const run = boot(['--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', String(port)], homeDir)
  try {
    await waitFor(() => run.output().includes('no-such-scanner.json'), run, 'scanner profile load error')
    console.log('PASS an unknown scanner profile id reports the missing profile file')
  } finally {
    await stop(run)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'pulseos-smoke-'))
try {
  await servesWebUi(join(scratch, 'home-ok'))
  await badProfileFailsLoudly(join(scratch, 'home-bad'), scratch)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
