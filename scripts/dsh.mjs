/**
 * Launch a DSH profile from the submodule source with the PulseOS overlay.
 * Usage: node scripts/dsh.mjs <profile> [dsh options] [app args]
 *
 * The CLI runs with dsh/ as working directory so tsx resolves @deepseek-ai/*
 * imports, including those in PulseOS plugin source, through dsh/tsconfig.json.
 * DSH_HOME defaults to .dsh-home/ in this repository so development profiles
 * stay out of the user's ~/.dsh.
 */
import { spawn } from 'node:child_process'
import { appPatch, defaultDshHome, dshRoot } from './paths.mjs'

const [profile, ...rest] = process.argv.slice(2)
if (profile === undefined) {
  console.error('usage: node scripts/dsh.mjs <profile> [dsh options] [app args]')
  process.exit(2)
}
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', profile, '--patch', appPatch, ...rest], {
  cwd: dshRoot,
  stdio: 'inherit',
  env: { DSH_HOME: defaultDshHome, ...process.env },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
