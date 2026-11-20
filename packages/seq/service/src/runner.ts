/** One build: write the recipe into a private temporary directory and run `pulseos_seq.run` there. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { BuildError, SequenceModel } from '@pulseos/seq-protocol'

/** Fully resolved inputs of one runner invocation. */
export interface RunnerSpec {
  python: string
  timeoutMs: number
  graceMs: number
  maxOutputBytes: number
  confine: boolean
}

/** What to build. */
export interface RunnerInput {
  recipeSource: string
  params: Record<string, number>
  baseParams: Record<string, number>
  profile: { id: string; directory: string }
}

export type RunnerResult =
  | { ok: true; model: SequenceModel; seqFile: Uint8Array | null }
  | { ok: false; error: BuildError }

interface RunnerReply { ok: boolean; model?: SequenceModel; error?: BuildError }

/**
 * Run one build in a fresh private temporary directory, which is removed afterwards.
 * @param ctx - context providing `ctx.subprocess`.
 * @param spec - interpreter, limits and confinement.
 * @param input - recipe source, parameters and scanner profile.
 * @param signal - caller cancellation.
 * @returns the model and `.seq` bytes, or a structured error.
 */
export async function runBuild(ctx: Context, spec: RunnerSpec, input: RunnerInput, signal?: AbortSignal): Promise<RunnerResult> {
  const directory = await mkdtemp(join(tmpdir(), 'pulseos-build-'))
  try {
    const recipePath = join(directory, 'recipe.py')
    const seqPath = join(directory, 'out.seq')
    await writeFile(recipePath, input.recipeSource, { mode: 0o600, flag: 'wx' })
    const request = {
      recipe: { path: recipePath },
      params: input.params,
      baseParams: input.baseParams,
      profile: input.profile,
      seqPath,
      ...(spec.confine ? { confine: { writable: directory } } : {}),
    }
    const deadline = AbortSignal.timeout(spec.timeoutMs)
    const child = ctx.subprocess.spawn({
      argv: [spec.python, '-I', '-B', '-m', 'pulseos_seq.run'],
      cwd: directory,
      env: { HOME: directory, TMPDIR: directory, PYTHONDONTWRITEBYTECODE: '1' },
      signal: signal === undefined ? deadline : AbortSignal.any([deadline, signal]),
      graceMs: spec.graceMs,
      stdio: { stdin: { data: JSON.stringify(request) }, stdout: { maxBytes: spec.maxOutputBytes }, stderr: { maxBytes: 65_536 } },
    })
    let outcome
    try {
      outcome = await child.done
    } finally {
      await child.waitForExit()
    }
    const timedOut = deadline.aborted
    const cancelled = signal?.aborted === true
    const stdout = child.collected.stdout!.readFrom(0)
    const stderr = child.collected.stderr!.readFrom(0).text.slice(-4000)
    if (timedOut) return { ok: false, error: { kind: 'timeout', message: `the build did not finish within ${spec.timeoutMs} ms`, line: null } }
    if (cancelled) return { ok: false, error: { kind: 'process', message: 'the build was cancelled', line: null } }
    if (stdout.lossy) return { ok: false, error: { kind: 'process', message: `the build output exceeded ${spec.maxOutputBytes} bytes`, line: null } }
    let reply: RunnerReply
    try {
      reply = JSON.parse(stdout.text) as RunnerReply
    } catch {
      // Not JSON: the interpreter failed before the runner could answer.
      return {
        ok: false,
        error: { kind: 'process', message: `the build process exited with ${outcome.exitCode ?? outcome.signal} without a result: ${stderr || '(no output)'}`, line: null },
      }
    }
    if (!reply.ok || reply.model === undefined) {
      return { ok: false, error: reply.error ?? { kind: 'process', message: 'the build returned no model', line: null } }
    }
    let seqFile: Uint8Array | null = null
    try {
      seqFile = await readFile(seqPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { ok: true, model: reply.model, seqFile }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
