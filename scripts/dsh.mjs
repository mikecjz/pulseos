/**
 * Launch a DSH profile from the submodule source with the PulseOS overlay.
 * Usage: node scripts/dsh.mjs <profile> [dsh options] [app args]
 *
 * The CLI runs with dsh/ as working directory so tsx resolves @deepseek-ai/*
 * imports, including those in PulseOS plugin source, through dsh/tsconfig.json.
 * DSH_HOME defaults to .dsh-home/ in this repository so development profiles
 * stay out of the user's ~/.dsh.
 *
 * For the `web` profile without `--port`, the launcher binds the first free
 * port from 3080 upward (see web-port.mjs) so several checkouts can share one
 * server; an explicit `--port` is passed through and fails if it is taken.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appPatch, defaultDshHome, dshRoot, repoRoot } from './paths.mjs'
import { DEFAULT_WEB_PORT, withFreeWebPort } from './web-port.mjs'

const [profile, ...args] = process.argv.slice(2)
if (profile === undefined) {
  console.error('usage: node scripts/dsh.mjs <profile> [dsh options] [app args]')
  process.exit(2)
}
// The overlay's Web client plugins load their built bundles; DSH fails the boot without them.
for (const [pkg, label] of [['seq/viewer', 'sequence viewer'], ['app/brand', 'brand']]) {
  if (!existsSync(`${repoRoot}packages/${pkg}/lib/client.js`)) {
    console.error(`The ${label} client bundle is missing: run \`pnpm run build\` first.`)
    process.exit(1)
  }
}
let rest = args
if (profile === 'web') {
  let chosen
  try {
    chosen = await withFreeWebPort(args)
  } catch (error) {
    console.error(`PulseOS web: ${error.message}`)
    process.exit(1)
  }
  rest = chosen.args
  if (chosen.port !== undefined) {
    const authority = chosen.host.includes(':') ? `[${chosen.host}]` : chosen.host
    if (chosen.port !== DEFAULT_WEB_PORT) console.log(`PulseOS web: port ${DEFAULT_WEB_PORT} is in use; using ${chosen.port} instead.`)
    console.log(`PulseOS web: http://${authority}:${chosen.port}/  (open the "dsh web:" link printed below; it carries the login token)`)
  }
}
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', profile, '--patch', appPatch, ...rest], {
  cwd: dshRoot,
  stdio: 'inherit',
  env: { DSH_HOME: defaultDshHome, ...process.env },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
