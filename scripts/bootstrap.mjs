/**
 * One-time setup: check out the pinned DSH submodule, install and build it,
 * then install the PulseOS workspace and the Python backend environment.
 * Re-run after moving the submodule pin.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dshRoot, repoRoot } from './paths.mjs'

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run('git', ['submodule', 'update', '--init', '--depth', '1', 'dsh'])
if (!existsSync(join(dshRoot, 'package.json'))) throw new Error('dsh submodule is missing after checkout')
// CI=true skips DSH's lefthook installer, which cannot configure hooks inside a
// submodule (core.worktree lives in the superproject's modules/dsh/config).
run('pnpm', ['install', '--frozen-lockfile'], { cwd: dshRoot, env: { ...process.env, CI: 'true' } })
// DSH boots from source but loads built Typert modules, the native addon and
// the Web client bundle from its lib/ outputs.
run('pnpm', ['run', 'build:artifacts'], { cwd: dshRoot })
run('pnpm', ['install'])
run('pnpm', ['run', 'build'])
run('uv', ['sync', '--project', 'python'])
