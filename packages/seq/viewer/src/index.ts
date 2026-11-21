/**
 * Host face of the sequence viewer: read-only HTTP routes the browser viewer loads revisions,
 * models, recipes and `.seq` files from, plus one build route for the viewer's empty state.
 * Routes act on live sessions only (`ctx.sessions.get`); the browser reaches them through the
 * authenticated DSH connection.
 * @module @pulseos/seq-viewer
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@pulseos/seq-service'
import { BUILD_PATH, MODEL_PATH, RECIPE_PATH, SEQ_PATH, STATE_PATH, type ViewerState } from './routes.ts'

export * from './routes.ts'

export const name = 'pulseos-seq-viewer'
export const inject = ['pulseSeq', 'sessions', 'connection', 'scannerProfile']

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

/**
 * Register the viewer routes.
 * @param ctx - plugin context with `pulseSeq`, `sessions` and `connection`.
 */
export function apply(ctx: Context): void {
  const connection = Reflect.get(ctx, 'connection') as Connection
  const seq = ctx.pulseSeq

  function sessionOf(url: URL): Session | Response {
    const id = url.searchParams.get('sessionId')
    if (id === null || id === '') return problem(400, 'sessionId is required')
    const session = ctx.sessions.get(id as SessionId)
    return session ?? problem(404, 'the session is not open on the host')
  }
  function revisionOf(session: Session, url: URL) {
    const text = url.searchParams.get('rev')
    const revision = text === null ? seq.current(session) : seq.revision(session, Number(text))
    return revision ?? problem(404, text === null ? 'no sequence has been built yet' : `there is no revision r${text}`)
  }
  // fetch.register is an effect of the calling plugin: unloading the plugin removes the route.
  const route = (path: string, handler: (url: URL, request: Request) => Promise<Response>, methods: Route['methods'] = ['GET']) => {
    connection.fetch.register({
      path, methods, requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await handler(new URL(request.url), request)
        } catch (error) {
          return problem(500, error instanceof Error ? error.message : String(error))
        }
      },
    })
  }

  route(STATE_PATH, async (url) => {
    const session = sessionOf(url)
    if (session instanceof Response) return session
    const state = seq.state(session)
    const profile = ctx.scannerProfile.profile
    const body: ViewerState = {
      revisions: state.revisions, lastFailure: state.lastFailure, building: seq.isBuilding(session),
      profile: { id: profile.id, title: profile.title, limits: { ...profile.limits } },
    }
    return json(body)
  })

  route(MODEL_PATH, async (url, request) => {
    const session = sessionOf(url)
    if (session instanceof Response) return session
    const revision = revisionOf(session, url)
    if (revision instanceof Response) return revision
    const model = await seq.modelOf(session, revision, request.signal)
    return new Response(JSON.stringify(model), { headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=31536000, immutable' } })
  })

  route(RECIPE_PATH, async (url) => {
    const session = sessionOf(url)
    if (session instanceof Response) return session
    const revision = revisionOf(session, url)
    if (revision instanceof Response) return revision
    const recipe = await seq.recipe(session, revision.rev)
    return json({ rev: revision.rev, source: recipe.source, hash: recipe.hash })
  })

  route(SEQ_PATH, async (url) => {
    const session = sessionOf(url)
    if (session instanceof Response) return session
    const revision = revisionOf(session, url)
    if (revision instanceof Response) return revision
    const { readFile } = await import('node:fs/promises')
    let bytes: Uint8Array
    try {
      bytes = await readFile(seq.seqPath(revision))
    } catch {
      // Missing from the store: the model can be rebuilt but the .seq file is only written by builds.
      return problem(404, `the .seq file of r${revision.rev} is not in the store; rebuild it to export`)
    }
    return new Response(bytes, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${revision.seq}-r${revision.rev}.seq"` } })
  })

  route(BUILD_PATH, async (url) => {
    const session = sessionOf(url)
    if (session instanceof Response) return session
    if (seq.current(session) !== undefined) return problem(409, 'this session already has a sequence; change it through chat')
    const outcome = await seq.build(session, { cause: 'initial build from the viewer', author: 'user' })
    return outcome.ok ? json({ ok: true, rev: outcome.revision.rev }) : json({ ok: false, error: outcome.error }, 422)
  }, ['POST'])
}
