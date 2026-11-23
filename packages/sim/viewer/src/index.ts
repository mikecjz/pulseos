/**
 * Host face of the simulation panel: routes the browser page reads state and result arrays from,
 * and the run / cancel / connect actions. Routes act on live sessions only (`ctx.sessions.get`);
 * the browser reaches them through the authenticated DSH connection.
 * @module @pulseos/sim-viewer
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@pulseos/seq-service'
import { SIM_PARTS, type SimPart } from '@pulseos/sim-protocol'
import { ResultUnavailableError, SimRequestError } from '@pulseos/sim-service'
import { SHAPE_HEADER, SIM_CANCEL_PATH, SIM_CONNECT_PATH, SIM_RESULT_PATH, SIM_RUN_PATH, SIM_STATE_PATH, type SimPanelState } from './routes.ts'

export * from './routes.ts'

export const name = 'pulseos-sim-viewer'
export const inject = ['pulseSim', 'pulseSeq', 'sessions', 'connection']

interface Route {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}
interface Connection { readonly fetch: { register(route: Route): () => Promise<void> } }

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const problem = (status: number, message: string): Response => json({ error: message }, status)
const IMMUTABLE = 'private, max-age=31536000, immutable'

/**
 * Register the simulation routes.
 * @param ctx - plugin context with `pulseSim`, `pulseSeq`, `sessions` and `connection`.
 */
export function apply(ctx: Context): void {
  const connection = Reflect.get(ctx, 'connection') as Connection
  const sim = ctx.pulseSim

  function sessionOf(url: URL): Session | Response {
    const id = url.searchParams.get('sessionId')
    if (id === null || id === '') return problem(400, 'sessionId is required')
    return ctx.sessions.get(id as SessionId) ?? problem(404, 'the session is not open on the host')
  }
  const route = (path: string, handler: (url: URL) => Promise<Response>, methods: Route['methods'] = ['GET']) => {
    connection.fetch.register({
      path, methods, requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await handler(new URL(request.url))
        } catch (error) {
          if (error instanceof SimRequestError) return problem(409, error.message)
          if (error instanceof ResultUnavailableError) return problem(404, error.message)
          return problem(500, error instanceof Error ? error.message : String(error))
        }
      },
    })
  }

  route(SIM_STATE_PATH, async (url) => {
    const session = sessionOf(url)
    if (session instanceof Response) return session
    const state = sim.state(session)
    const body: SimPanelState = {
      runs: state.runs, lastFailure: state.lastFailure, jobs: sim.jobsOf(session), engines: sim.engines(), defaults: sim.defaults,
      revisions: ctx.pulseSeq.state(session).revisions.map(r => ({ rev: r.rev, seq: r.seq, cause: r.cause })),
    }
    return json(body)
  })

  route(SIM_RESULT_PATH, async (url) => {
    const key = url.searchParams.get('key') ?? ''
    const part = url.searchParams.get('part') ?? 'meta'
    if (part === 'meta') {
      const { meta } = await sim.result(key)
      return new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json', 'cache-control': IMMUTABLE } })
    }
    if (!SIM_PARTS.includes(part as SimPart)) return problem(400, `part must be meta or one of ${SIM_PARTS.join(', ')}`)
    const { info, bytes } = await sim.part(key, part as SimPart)
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'cache-control': IMMUTABLE, [SHAPE_HEADER]: info.shape.join(',') } })
  })

  route(SIM_RUN_PATH, async (url) => {
    const session = sessionOf(url)
    if (session instanceof Response) return session
    const rev = url.searchParams.get('rev')
    const job = sim.run(session, {
      ...(rev === null || rev === '' || rev === 'latest' ? {} : { rev: Number(rev) }),
      ...(url.searchParams.get('engine') ? { engine: url.searchParams.get('engine')! } : {}),
      ...(url.searchParams.get('phantom') ? { phantom: url.searchParams.get('phantom')! } : {}),
      author: 'user', cause: 'simulated from the panel',
    })
    void job.done.catch(() => undefined)
    return json({ id: job.id }, 202)
  }, ['POST'])

  route(SIM_CANCEL_PATH, async (url) => {
    const session = sessionOf(url)
    if (session instanceof Response) return session
    return json({ cancelled: sim.cancel(session, url.searchParams.get('id') ?? undefined) })
  }, ['POST'])

  route(SIM_CONNECT_PATH, async (url) => {
    try {
      return json(await sim.connect(url.searchParams.get('engine') ?? undefined))
    } catch (error) {
      if (error instanceof SimRequestError) throw error
      // The engine state (status unavailable, error) is what the panel shows.
      return json(sim.engines().find(e => e.id === (url.searchParams.get('engine') ?? sim.defaults.engine)) ?? null, 503)
    }
  }, ['POST'])
}
