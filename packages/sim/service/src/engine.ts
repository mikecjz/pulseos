/**
 * One engine connection: an MCP client over stdio to an engine process. Started lazily, restarted
 * after a crash on the next call, and stopped after an idle period.
 */
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  parseEngineInfo, parsePhantoms, parseSimulateReply, SIM_TOOLS,
  type EngineInfo, type PhantomInfo, type SimulateArgs, type SimulateReply,
} from '@pulseos/sim-protocol'
import type { LaunchSpec } from './launch.ts'

/** Connection state shown to the panel. */
export type EngineStatus = 'stopped' | 'starting' | 'ready' | 'unavailable'

/** The engine could not be started or reached. */
export class EngineUnavailableError extends Error {
  override name = 'EngineUnavailableError'
}

/** The engine answered a call with an error result (bad input, or a failure inside the engine). */
export class EngineToolError extends Error {
  override name = 'EngineToolError'
}

/** Progress of a running call. */
export interface Progress { done: number; total: number | null; message: string | null }

interface Live { client: Client; transport: StdioClientTransport; info: EngineInfo; phantoms: PhantomInfo[] }

const STDERR_TAIL = 4000

export class EngineConnection {
  private live: Promise<Live> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private busy = 0
  private stderr = ''
  status: EngineStatus = 'stopped'
  error: string | null = null
  info: EngineInfo | null = null
  phantoms: PhantomInfo[] | null = null

  constructor(
    readonly id: string,
    private readonly spec: () => LaunchSpec,
    private readonly options: { connectTimeoutMs: number; idleShutdownMs: number; onChange?: () => void },
  ) {}

  /** Start the engine (if needed) and return its identity and phantoms. */
  async connect(): Promise<Live> {
    this.live ??= this.open()
    try {
      return await this.live
    } catch (error) {
      this.live = undefined
      throw error
    }
  }

  private async open(): Promise<Live> {
    this.set('starting', null)
    const spec = this.spec()
    const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, stderr: 'pipe' })
    this.stderr = ''
    transport.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL) })
    const client = new Client({ name: 'pulseos-sim', version: '0.1.0' }, { capabilities: {} })
    const timeout = { timeout: this.options.connectTimeoutMs }
    try {
      await client.connect(transport, timeout)
      const info = parseEngineInfo((await client.callTool({ name: SIM_TOOLS.info, arguments: {} }, timeout)).structuredContent)
      const phantoms = parsePhantoms((await client.callTool({ name: SIM_TOOLS.phantoms, arguments: {} }, timeout)).structuredContent)
      const live = { client, transport, info, phantoms }
      client.onclose = () => {
        // The process exited or the pipe closed; the next call starts a new one.
        if (this.live !== undefined) {
          this.live = undefined
          this.set('unavailable', `the engine process exited${this.stderrTail()}`)
        }
      }
      this.info = info
      this.phantoms = phantoms
      this.set('ready', null)
      this.touch()
      return live
    } catch (error) {
      await client.close().catch(() => undefined)
      const message = `could not start the ${this.id} engine (${spec.command} ${spec.args.at(-1) ?? ''}): ${(error as Error).message}${this.stderrTail()}`
      this.set('unavailable', message)
      throw new EngineUnavailableError(message, { cause: error })
    }
  }

  private stderrTail(): string {
    const tail = this.stderr.trim().split('\n').slice(-6).join('\n')
    return tail === '' ? '' : `\n${tail}`
  }

  private set(status: EngineStatus, error: string | null): void {
    this.status = status
    this.error = error
    this.options.onChange?.()
  }

  private touch(): void {
    clearTimeout(this.idleTimer)
    if (this.busy > 0 || this.options.idleShutdownMs <= 0) return
    this.idleTimer = setTimeout(() => { void this.close('idle') }, this.options.idleShutdownMs)
    this.idleTimer.unref?.()
  }

  /**
   * Run one simulation.
   * @param args - contract arguments.
   * @param options - progress callback, cancellation and deadline.
   * @returns the checked reply.
   */
  async simulate(args: SimulateArgs, options: { onprogress: (p: Progress) => void; signal: AbortSignal; timeoutMs: number }): Promise<SimulateReply> {
    const live = await this.connect()
    this.busy++
    clearTimeout(this.idleTimer)
    try {
      const result = await live.client.callTool({ name: SIM_TOOLS.simulate, arguments: { ...args } }, {
        signal: options.signal,
        // The deadline covers the whole call; progress does not extend it.
        timeout: options.timeoutMs,
        maxTotalTimeout: options.timeoutMs,
        onprogress: (p) => { options.onprogress({ done: p.progress, total: p.total ?? null, message: p.message ?? null }) },
      })
      if (result.isError === true) {
        const text = (result.content as { type: string; text?: string }[]).map(c => c.text ?? '').join('\n').trim()
        throw new EngineToolError(text || 'the engine reported an error')
      }
      return parseSimulateReply(result.structuredContent)
    } finally {
      this.busy--
      this.touch()
    }
  }

  /** Stop the engine process. */
  async close(reason: 'idle' | 'dispose' = 'dispose'): Promise<void> {
    clearTimeout(this.idleTimer)
    const live = this.live
    this.live = undefined
    if (live !== undefined) {
      const opened = await live.catch(() => undefined)
      await opened?.client.close().catch(() => undefined)
    }
    if (this.status !== 'unavailable' || reason === 'dispose') this.set('stopped', null)
  }
}
