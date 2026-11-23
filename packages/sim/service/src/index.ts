/**
 * `ctx.pulseSim`: the only MCP client of PulseOS simulation engines. It turns a sequence revision
 * into its `.seq` text, runs it on an engine (an MCP server, usually in Docker), caches results by
 * content, queues jobs one at a time per engine, and records every run in the session log.
 *
 * Session state is a projection over `plugin:pulseos/sim-run` and `plugin:pulseos/sim-failed`
 * (see `@pulseos/sim-protocol`). Jobs in flight and their progress live in memory only.
 * @module @pulseos/sim-service
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { appendPluginRecord, pluginRecordOf, type Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { RevisionRecord } from '@pulseos/seq-protocol'
import type {} from '@pulseos/seq-service'
import {
  ENGINE_ERROR_PREFIX, isResultKey, SIM_FAILED_RECORD, SIM_PROTOCOL, SIM_RUN_RECORD,
  type EngineState, type PartInfo, type SimAuthor, type SimJob, type SimFailedRecord, type SimFailureKind,
  type SimPart, type SimRunRecord, type SimSettings, type SimulateReply,
} from '@pulseos/sim-protocol'
import { EngineConnection, EngineToolError, EngineUnavailableError } from './engine.ts'
import { launchSpec, type EngineConfig } from './launch.ts'

export { EngineUnavailableError, EngineToolError } from './engine.ts'
export type { EngineState, EngineStatus, Progress, SimJob } from '@pulseos/sim-protocol'
export type { EngineConfig } from './launch.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** One finished simulation. */
    'plugin:pulseos/sim-run': SimRunRecord
    /** A simulation that produced no result. */
    'plugin:pulseos/sim-failed': SimFailedRecord
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** PulseOS sequence simulation. */
    pulseSim: PulseSimService
  }
}

/** Per-session simulation state folded from the session log. */
export interface SimulationState {
  runs: SimRunRecord[]
  /** The latest failure, with the number of runs recorded before it. */
  lastFailure: (SimFailedRecord & { afterRuns: number }) | null
}

const EMPTY: SimulationState = { runs: [], lastFailure: null }
const PROJECTION_KEY = 'pulseosSimulation'

/** What to simulate. Unset fields use the latest revision and the configured defaults. */
export interface SimRequest {
  rev?: number
  engine?: string
  phantom?: string
  settings?: SimSettings
  author: SimAuthor
  /** Why, in the requester's words. */
  cause: string
}

export type SimOutcome = { ok: true; run: SimRunRecord } | { ok: false; failure: SimFailedRecord }

/** The request cannot be served in the session's current state (no sequence, unknown revision or engine). */
export class SimRequestError extends Error {
  override name = 'SimRequestError'
}

/** A stored result is missing or does not match its key. */
export class ResultUnavailableError extends Error {
  override name = 'ResultUnavailableError'
}

/** Service configuration. */
export interface Config {
  /** Directory for results (`<dataDir>/sim/<hex>/`). Shared with the engine processes. */
  dataDir: string
  /** Engines by ID. */
  engines: Record<string, EngineConfig>
  defaultEngine: string
  defaultPhantom: string
  /** Wall-clock limit of one simulation. */
  timeoutMs: number
  /** Limit for starting an engine and listing its phantoms (Docker start and torch import). */
  connectTimeoutMs: number
  /** Stop an engine after this long without work; 0 keeps it running. */
  idleShutdownMs: number
}

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))

const EngineSchema = z.object({
  launcher: z.union(['docker', 'local', 'fake'] as const).default('docker').description('How the engine process is started.'),
  image: z.string().default('pulseos/mrzero-mcp:dev').description('Docker image (docker launcher).'),
  gpu: z.union([z.natural(), z.const(null)]).default(0).description('GPU index for --gpus device=N; null runs on the CPU (docker launcher).'),
  command: z.array(z.string()).default([join(REPO, 'sims/mrzero-mcp/.venv/bin/mrzero-mcp'), 'serve']).description('Command of the local launcher.'),
  device: z.string().default('auto').description('Device of the local launcher: auto, cpu, cuda or cuda:N.'),
  env: z.dict(z.string()).default({}).description('Extra environment of the local launcher.'),
  memory: z.string().default('16g').description('Container memory limit (docker launcher).'),
  fakeDelayMs: z.natural().default(2).description('Per-line delay of the fake engine.'),
}) as unknown as z<Partial<EngineConfig>, EngineConfig>

/** Simulation service; see the module documentation. */
export class PulseSimService extends Service {
  static inject = ['pulseSeq', 'sessionProjections']

  static Config: z<Partial<Config>, Config> = z.object({
    dataDir: z.string().default(join(REPO, '.pulseos-data')).description('Directory for simulation results (dataDir/sim).'),
    engines: z.dict(EngineSchema).default({ mrzero: {} as EngineConfig }).description('Simulation engines by ID.'),
    defaultEngine: z.string().default('mrzero').description('Engine used when a request names none.'),
    defaultPhantom: z.string().default('brainweb-axial').description('Phantom used when a request names none.'),
    timeoutMs: z.natural().min(1000).max(2_147_483_647).default(600_000).description('Wall-clock limit of one simulation.'),
    connectTimeoutMs: z.natural().min(1000).default(180_000).description('Limit for starting an engine.'),
    idleShutdownMs: z.natural().default(900_000).description('Stop an idle engine after this long; 0 keeps it running.'),
  }) as unknown as z<Partial<Config>, Config>

  private projection: ProjectionHandle<SimulationState> | undefined
  private readonly connections = new Map<string, EngineConnection>()
  private readonly jobs = new Map<string, { job: SimJob; controller: AbortController; resolve: (o: SimOutcome) => void; request: SimRequest; session: Session; revision: RevisionRecord }>()
  private readonly queues = new Map<string, string[]>()
  private readonly running = new Set<string>()
  private readonly listeners = new Set<(sessionId: string) => void>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pulseSim')
    if (!isAbsolute(config.dataDir)) throw new Error(`pulseSim: dataDir must be an absolute path, got "${config.dataDir}"`)
    if (config.engines[config.defaultEngine] === undefined) throw new Error(`pulseSim: defaultEngine "${config.defaultEngine}" is not configured`)
    for (const [id, engine] of Object.entries(config.engines)) {
      if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`pulseSim: engine ID "${id}" must be lowercase letters, digits and dashes`)
      const resolved = { ...(EngineSchema(engine) as EngineConfig) }
      config.engines[id] = resolved
      this.connections.set(id, new EngineConnection(id, () => launchSpec(resolved, this.resultDir, { uid: process.getuid?.() ?? 10001, gid: process.getgid?.() ?? 10001 }), {
        connectTimeoutMs: config.connectTimeoutMs, idleShutdownMs: config.idleShutdownMs, onChange: () => { this.notify('*') },
        prepare: async () => { await mkdir(this.resultDir, { recursive: true }) },
      }))
    }
  }

  /** Directory engines write results to. */
  get resultDir(): string {
    return join(this.config.dataDir, 'sim')
  }

  get defaults(): { engine: string; phantom: string } {
    return { engine: this.config.defaultEngine, phantom: this.config.defaultPhantom }
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register<typeof PROJECTION_KEY, SimulationState>({
      key: PROJECTION_KEY,
      stateSchema: zod.custom<SimulationState>(value => typeof value === 'object' && value !== null && 'runs' in value),
      init: () => EMPTY,
      apply: applySimRecord,
      stateVersion: 1,
    })
    this.ctx.effect(() => () => {
      for (const entry of this.jobs.values()) entry.controller.abort(new Error('the simulation service stopped'))
      for (const connection of this.connections.values()) void connection.close()
    }, 'pulseSim: engines')
  }

  /**
   * Simulation state of a session.
   * @param session - the session.
   * @returns runs and the last failure.
   */
  state(session: Session): SimulationState {
    if (this.projection === undefined) throw new Error('pulseSim: the session projection is not registered yet')
    return this.projection.stateOf(session)
  }

  /**
   * Queued and running jobs of a session, oldest first.
   * @param session - the session.
   * @returns the jobs.
   */
  jobsOf(session: Session): SimJob[] {
    const id = String(session.id)
    return [...this.jobs.values()].map(e => e.job).filter(j => j.sessionId === id).toSorted((a, b) => a.queuedAt - b.queuedAt)
  }

  /** Configured engines and their connection state. */
  engines(): EngineState[] {
    return [...this.connections.entries()].map(([id, c]) => ({
      id, launcher: this.config.engines[id]!.launcher, status: c.status, error: c.error, info: c.info, phantoms: c.phantoms,
    }))
  }

  /**
   * Start an engine and list its phantoms.
   * @param engine - engine ID; default engine when omitted.
   * @returns the engine state after connecting.
   */
  async connect(engine = this.config.defaultEngine): Promise<EngineState> {
    const connection = this.connection(engine)
    await connection.connect()
    return this.engines().find(e => e.id === engine)!
  }

  /**
   * Subscribe to job changes (queued, progress, finished). The argument is a session ID, or `*` for engine changes.
   * @param listener - callback.
   * @returns unsubscribe.
   */
  onChange(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(sessionId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId)
      } catch {
        // A listener's failure must not stop the job.
      }
    }
  }

  private connection(engine: string): EngineConnection {
    const connection = this.connections.get(engine)
    if (connection === undefined) throw new SimRequestError(`there is no engine "${engine}"; engines: ${[...this.connections.keys()].join(', ')}`)
    return connection
  }

  /**
   * Queue a simulation. One job runs at a time per engine. A newer request of the same session,
   * engine and phantom supersedes an older one that has not started yet.
   * @param session - the session that owns the run.
   * @param request - what to simulate.
   * @param signal - cancellation of this job.
   * @returns the job ID and its outcome.
   */
  run(session: Session, request: SimRequest, signal?: AbortSignal): { id: string; done: Promise<SimOutcome> } {
    const seq = this.ctx.pulseSeq
    const revision = request.rev === undefined ? seq.current(session) : seq.revision(session, request.rev)
    if (revision === undefined) {
      throw new SimRequestError(request.rev === undefined ? 'no sequence has been built in this session yet' : `there is no revision r${request.rev}`)
    }
    const engine = request.engine ?? this.config.defaultEngine
    this.connection(engine)
    const phantom = request.phantom ?? this.config.defaultPhantom
    const sessionId = String(session.id)
    const queue = this.queues.get(engine) ?? []
    this.queues.set(engine, queue)
    for (const id of queue.slice()) {
      const entry = this.jobs.get(id)!
      if (entry.job.sessionId === sessionId && entry.job.phantom === phantom) this.finish(id, { kind: 'superseded', message: `superseded by a newer request (r${revision.rev})` }, false)
    }
    const id = randomUUID().slice(0, 8)
    const controller = new AbortController()
    signal?.addEventListener('abort', () => { controller.abort(signal.reason) }, { once: true })
    const job: SimJob = { id, sessionId, rev: revision.rev, engine, phantom, author: request.author, state: 'queued', progress: null, queuedAt: Date.now(), startedAt: null }
    const done = new Promise<SimOutcome>((resolve) => {
      this.jobs.set(id, { job, controller, resolve, request: { ...request, engine, phantom }, session, revision })
    })
    queue.push(id)
    this.notify(sessionId)
    void this.pump(engine)
    return { id, done }
  }

  /**
   * Cancel a session's job, or all of them.
   * @param session - the session.
   * @param id - job ID; all jobs of the session when omitted.
   * @returns the number of jobs cancelled.
   */
  cancel(session: Session, id?: string): number {
    let count = 0
    for (const job of this.jobsOf(session)) {
      if (id !== undefined && job.id !== id) continue
      const entry = this.jobs.get(job.id)!
      if (job.state === 'queued') this.finish(job.id, { kind: 'cancelled', message: 'the simulation was cancelled before it started' }, true)
      else entry.controller.abort(new Error('cancelled'))
      count++
    }
    return count
  }

  private async pump(engine: string): Promise<void> {
    if (this.running.has(engine)) return
    const queue = this.queues.get(engine)!
    const next = queue.shift()
    if (next === undefined) return
    this.running.add(engine)
    try {
      await this.execute(next)
    } finally {
      this.running.delete(engine)
      void this.pump(engine)
    }
  }

  private finish(id: string, outcome: { kind: SimFailureKind; message: string } | SimRunRecord, record: boolean): void {
    const entry = this.jobs.get(id)
    if (entry === undefined) return
    this.jobs.delete(id)
    const queue = this.queues.get(entry.job.engine)
    const at = queue?.indexOf(id) ?? -1
    if (at >= 0) queue!.splice(at, 1)
    if ('resultKey' in outcome) {
      appendPluginRecord(entry.session, SIM_RUN_RECORD, outcome)
      entry.resolve({ ok: true, run: outcome })
    } else {
      const { request } = entry
      const failure: SimFailedRecord = {
        id, rev: entry.revision.rev, engine: request.engine!, phantom: request.phantom!, settings: request.settings ?? {},
        author: request.author, cause: request.cause, error: outcome,
      }
      if (record) appendPluginRecord(entry.session, SIM_FAILED_RECORD, failure)
      entry.resolve({ ok: false, failure })
    }
    this.notify(entry.job.sessionId)
  }

  private async execute(id: string): Promise<void> {
    const entry = this.jobs.get(id)
    if (entry === undefined) return
    const { job, controller, request, revision } = entry
    if (controller.signal.aborted) {
      this.finish(id, { kind: 'cancelled', message: 'the simulation was cancelled before it started' }, true)
      return
    }
    job.state = 'running'
    job.startedAt = Date.now()
    this.notify(job.sessionId)
    const connection = this.connection(job.engine)
    try {
      let seqText: string
      try {
        seqText = await readFile(this.ctx.pulseSeq.seqPath(revision), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        this.finish(id, { kind: 'input', message: `the .seq file of r${revision.rev} is not in the store; rebuild the sequence first` }, true)
        return
      }
      const seqHash = `sha256:${sha256Hex(seqText)}`
      const live = await connection.connect()
      const phantom = live.phantoms.find(p => p.id === job.phantom)
      if (phantom === undefined) {
        this.finish(id, { kind: 'input', message: `the ${job.engine} engine has no phantom "${job.phantom}"; phantoms: ${live.phantoms.map(p => p.id).join(', ')}` }, true)
        return
      }
      const settings = canonicalSettings(request.settings ?? {})
      const key = sha256Hex(JSON.stringify({ protocol: SIM_PROTOCOL, seqHash, engine: live.info.engine, engineVersion: live.info.engineVersion, phantom: phantom.hash, settings }))
      const base = {
        id, rev: revision.rev, seq: revision.seq, engine: job.engine, engineVersion: live.info.engineVersion, phantom: phantom.id, settings,
        resultKey: `sha256:${key}`, seqHash, author: request.author, cause: request.cause,
      }
      const cached = await this.cachedReply(key)
      if (cached !== undefined) {
        this.finish(id, { ...base, cached: true, device: cached.device, grid: cached.grid, stats: cached.stats, timing: cached.timing, warnings: cached.warnings }, true)
        return
      }
      await mkdir(this.resultDir, { recursive: true })
      const reply = await connection.simulate({ seqText, seqHash, phantom: phantom.id, resultKey: key, settings }, {
        signal: controller.signal,
        timeoutMs: this.config.timeoutMs,
        onprogress: (progress) => { job.progress = progress; this.notify(job.sessionId) },
      })
      if (reply.resultKey !== key) throw new EngineToolError('the engine stored the result under a different key')
      this.finish(id, { ...base, cached: false, device: reply.device, grid: reply.grid, stats: reply.stats, timing: reply.timing, warnings: reply.warnings }, true)
    } catch (error) {
      if (controller.signal.aborted) this.finish(id, { kind: 'cancelled', message: 'the simulation was cancelled' }, true)
      else if (error instanceof EngineUnavailableError) this.finish(id, { kind: 'unavailable', message: error.message }, true)
      else if (error instanceof EngineToolError) this.finish(id, { kind: /cancel/i.test(error.message) ? 'cancelled' : error.message.startsWith(ENGINE_ERROR_PREFIX) ? 'engine' : 'input', message: error.message }, true)
      else if (/timed? ?out/i.test((error as Error).message)) this.finish(id, { kind: 'timeout', message: `the simulation did not finish within ${this.config.timeoutMs} ms` }, true)
      else this.finish(id, { kind: 'engine', message: (error as Error).message }, true)
    }
  }

  private async cachedReply(key: string): Promise<SimulateReply | undefined> {
    try {
      const meta = JSON.parse(await readFile(join(this.resultDir, key, 'meta.json'), 'utf8')) as SimulateReply
      return { ...meta, warnings: meta.warnings ?? [], timing: meta.timing ?? {}, device: meta.device ?? 'unknown' }
    } catch {
      // Not cached (or unreadable): simulate.
      return undefined
    }
  }

  /**
   * Metadata of a stored result.
   * @param resultKey - `sha256:<hex>` or bare hex.
   * @returns the parts and the engine's metadata.
   */
  async result(resultKey: string): Promise<{ parts: Record<SimPart, PartInfo>; meta: Record<string, unknown> }> {
    const key = resultKey.replace(/^sha256:/, '')
    if (!isResultKey(key)) throw new ResultUnavailableError(`"${resultKey}" is not a result key`)
    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(await readFile(join(this.resultDir, key, 'meta.json'), 'utf8')) as Record<string, unknown>
    } catch (error) {
      throw new ResultUnavailableError(`result ${resultKey} is not in the store; simulate again`, { cause: error })
    }
    return { parts: meta.parts as Record<SimPart, PartInfo>, meta }
  }

  /**
   * Bytes of one stored array.
   * @param resultKey - result key.
   * @param part - array name.
   * @returns the part's shape and its interleaved complex64 bytes.
   */
  async part(resultKey: string, part: SimPart): Promise<{ info: PartInfo; bytes: Uint8Array }> {
    const { parts } = await this.result(resultKey)
    const info = parts[part]
    if (info === undefined || !/^[a-z]+\.c64$/.test(info.file)) throw new ResultUnavailableError(`result ${resultKey} has no ${part}`)
    const bytes = await readFile(join(this.resultDir, resultKey.replace(/^sha256:/, ''), info.file))
    const count = info.shape.reduce((a, b) => a * b, 1)
    if (bytes.byteLength !== count * 8) throw new ResultUnavailableError(`stored ${part} of ${resultKey} has ${bytes.byteLength} bytes, expected ${count * 8}`)
    return { info, bytes }
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Settings with sorted keys and without undefined values, so equal settings hash equally.
 * @param settings - settings.
 * @returns canonical settings.
 */
export function canonicalSettings(settings: SimSettings): SimSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined).toSorted(([a], [b]) => a.localeCompare(b))) as SimSettings
}

/**
 * Fold one session event into the simulation state; unrelated events return the same state.
 * @param state - state before the event.
 * @param event - session event.
 * @returns state after the event.
 */
export function applySimRecord(state: SimulationState, event: SessionEvent): SimulationState {
  const record = pluginRecordOf(event)
  if (record === undefined) return state
  switch (record.type) {
    case SIM_RUN_RECORD:
      return { ...state, runs: [...state.runs, record.data as SimRunRecord] }
    case SIM_FAILED_RECORD:
      return { ...state, lastFailure: { ...(record.data as SimFailedRecord), afterRuns: state.runs.length } }
    default:
      return state
  }
}

export default PulseSimService
