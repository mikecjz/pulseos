/**
 * Launch a DSH profile from the submodule source with the PulseOS overlay.
 * Usage: node scripts/dsh.mjs <profile> [dsh options] [app args]
 *
 * The CLI runs with dsh/ as working directory so tsx resolves @deepseek-ai/*
 * imports, including those in PulseOS plugin source, through dsh/tsconfig.json.
 * DSH_HOME defaults to .dsh-home/ in this repository so development profiles
 * stay out of the user's ~/.dsh.
 *
 * PULSEOS_MODEL=<route>/<model id> selects another model provider; see
 * scripts/models.mjs. The launcher writes that selection as a patch file in
 * DSH_HOME and passes it after the PulseOS overlay.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { modelPatch } from './models.mjs'
import { appPatch, defaultDshHome, dshRoot, repoRoot } from './paths.mjs'

const [profile, ...rest] = process.argv.slice(2)
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
const env = { DSH_HOME: defaultDshHome, ...process.env }
const patches = ['--patch', appPatch]
let selection
try {
  selection = modelPatch(env)
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
if (selection !== null) {
  // The CLI resolves a relative DSH_HOME against its working directory, dsh/.
  const home = resolve(dshRoot, env.DSH_HOME)
  mkdirSync(home, { recursive: true })
  // JSON is YAML; the file is rewritten on every launch, so it never goes stale.
  const file = join(home, 'pulseos-model.patch.yml')
  writeFileSync(file, `${JSON.stringify(selection, null, 2)}\n`)
  patches.push('--patch', file)
}
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', profile, ...patches, ...rest], {
  cwd: dshRoot,
  stdio: 'inherit',
  env,
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
