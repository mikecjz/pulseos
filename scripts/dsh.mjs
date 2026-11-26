/**
 * Launch a DSH profile from the submodule source with the PulseOS overlay.
 * Usage: node scripts/dsh.mjs <profile> [dsh options] [app args]
 *
 * The CLI runs with dsh/ as working directory so tsx resolves @deepseek-ai/*
 * imports, including those in PulseOS plugin source, through dsh/tsconfig.json.
 * DSH_HOME defaults to .dsh-home/ in this repository so development profiles
 * stay out of the user's ~/.dsh. Team secrets in a git-ignored .env at the
 * repository root are loaded (the shell wins), and an HTTPS_PROXY turns on
 * Node's env proxy support; see scripts/env.mjs and docs/secrets.md.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { launchEnv, readEnvFile } from './env.mjs'
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
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', profile, '--patch', appPatch, ...rest], {
  cwd: dshRoot,
  stdio: 'inherit',
  env: launchEnv(process.env, readEnvFile(`${repoRoot}.env`), { DSH_HOME: defaultDshHome }),
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
