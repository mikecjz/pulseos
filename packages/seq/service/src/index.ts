/**
 * `ctx.pulseSeq`: builds PulseOS sequences in a confined Python process, records every build in the
 * session log as plugin records, and stores the resulting models by content address.
 *
 * Session state is a projection over three record types (see `@pulseos/seq-protocol`):
 * `plugin:pulseos/recipe` (a recipe version with its full source), `plugin:pulseos/revision` (one
 * successful build) and `plugin:pulseos/build-failed`. The current recipe and parameters are those
 * of the latest revision; a failed build changes neither.
 * @module @pulseos/seq-service
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { createTwoFilesPatch } from 'diff'
import { appendPluginRecord, pluginRecordOf, type Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@pulseos/scanner-profile'
import {
  BUILD_FAILED_RECORD, isName, paramChanges, RECIPE_RECORD, REVISION_RECORD, roleDiff,
  type Author, type BuildError, type BuildFailedRecord, type RecipeRecord, type RevisionKind, type RevisionRecord, type SequenceModel,
} from '@pulseos/seq-protocol'
import { runBuild } from './runner.ts'
import { ModelStore, ModelUnavailableError, sha256 } from './store.ts'

export { ModelUnavailableError } from './store.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** A recipe version, with its full source. */
    'plugin:pulseos/recipe': RecipeRecord
    /** One successful sequence build. */
    'plugin:pulseos/revision': RevisionRecord
    /** A build that produced no revision. */
    'plugin:pulseos/build-failed': BuildFailedRecord
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** PulseOS sequence builds and revisions. */
    pulseSeq: PulseSeqService
  }
}

/** Per-session sequence state folded from the session log. */
export interface SequenceState {
  recipes: Record<string, RecipeRecord>
  revisions: RevisionRecord[]
  lastFailure: (BuildFailedRecord & { afterRev: number | null }) | null
}

const EMPTY: SequenceState = { recipes: {}, revisions: [], lastFailure: null }
const PROJECTION_KEY = 'pulseosSequence'

/** What a build should use. Unset fields come from the current revision. */
export interface BuildRequest {
  /** Why this build happens, in the requester's words; shown in revision lists. */
  cause: string
  author: Author
  /** Strict parameter overrides; unknown names fail the build. */
  params?: Record<string, number>
  /** New recipe source (a code edit). */
  recipeSource?: string
  /** Start from a bundled recipe instead of the current one. */
  bundled?: string
  /** Rebuild this earlier revision's recipe and parameters as a new revision. */
  restore?: number
}

export type BuildOutcome =
  | { ok: true; revision: RevisionRecord; model: SequenceModel }
  | { ok: false; error: BuildError; failure: BuildFailedRecord }

/** Service configuration. */
export interface Config {
  /** Python interpreter of the `pulseos-seq` environment. */
  python: string
  /** Directory holding the bundled recipes (`<name>.py`). */
  recipeDirectory: string
  /** Directory for stored models and `.seq` files. */
  dataDir: string
  /** Wall-clock limit of one build. */
  timeoutMs: number
  /** Grace period between terminate and kill when a build is stopped. */
  graceMs: number
  /** Largest accepted runner output (model JSON). */
  maxOutputBytes: number
  /** Confine each build (Landlock on Linux, Seatbelt on macOS); when unavailable the build fails instead of running unconfined. */
  confine: boolean
  /** Bundled recipe used by the first build of a session. */
  defaultRecipe: string
  /** Number of parsed models kept in memory. */
  modelCacheSize: number
}

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))

/** Sequence service; see the module documentation. */
export class PulseSeqService extends Service {
  static inject = ['scannerProfile', 'subprocess', 'sessionProjections']

  static Config: z<Partial<Config>, Config> = z.object({
    python: z.string().default(join(REPO, 'python/.venv/bin/python')).description('Python interpreter of the pulseos-seq environment.'),
    recipeDirectory: z.string().default(join(REPO, 'python/pulseos_seq/recipes')).description('Directory of bundled recipes.'),
    dataDir: z.string().default(join(REPO, '.pulseos-data')).description('Directory for stored models and .seq files.'),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(120_000).description('Wall-clock limit of one build.'),
    graceMs: z.natural().min(1).max(60_000).default(2_000).description('Grace period before a stopped build is killed.'),
    maxOutputBytes: z.natural().min(1024).default(256 << 20).description('Largest accepted model JSON.'),
    confine: z.boolean().default(true).description('Confine builds (Landlock on Linux, Seatbelt on macOS) and fail closed when unavailable.'),
    defaultRecipe: z.string().default('gre2d').description('Bundled recipe for the first build of a session.'),
    modelCacheSize: z.natural().min(1).default(16).description('Parsed models kept in memory.'),
  })

  private readonly store: ModelStore
  private projection: ProjectionHandle<SequenceState> | undefined
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pulseSeq')
    for (const key of ['python', 'recipeDirectory', 'dataDir'] as const) {
      if (!isAbsolute(config[key])) throw new Error(`pulseSeq: ${key} must be an absolute path, got "${config[key]}"`)
    }
    if (!isName(config.defaultRecipe)) throw new Error(`pulseSeq: defaultRecipe "${config.defaultRecipe}" is not a recipe name`)
    this.store = new ModelStore(config.dataDir, config.modelCacheSize)
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register<typeof PROJECTION_KEY, SequenceState>({
      key: PROJECTION_KEY,
      stateSchema: zod.custom<SequenceState>(value => typeof value === 'object' && value !== null && 'revisions' in value),
      init: () => EMPTY,
      apply: applyRecord,
      stateVersion: 1,
    })
  }

  /**
   * Sequence state of a session.
   * @param session - the session.
   * @returns recipes, revisions and the last failure.
   */
  state(session: Session): SequenceState {
    if (this.projection === undefined) throw new Error('pulseSeq: the session projection is not registered yet')
    return this.projection.stateOf(session)
  }

  /**
   * The latest revision of a session.
   * @param session - the session.
   * @returns the revision record, or undefined before the first build.
   */
  current(session: Session): RevisionRecord | undefined {
    return this.state(session).revisions.at(-1)
  }

  /**
   * A revision by number.
   * @param session - the session.
   * @param rev - revision number.
   * @returns the revision record, or undefined.
   */
  revision(session: Session, rev: number): RevisionRecord | undefined {
    return this.state(session).revisions.find(r => r.rev === rev)
  }

  /**
   * Recipe source for a revision, or the source the next build would use.
   * @param session - the session.
   * @param rev - revision number; omitted for the current recipe.
   * @returns the recipe source and its hash.
   */
  async recipe(session: Session, rev?: number): Promise<{ source: string; hash: string; bundled: string | null }> {
    const state = this.state(session)
    const revision = rev === undefined ? state.revisions.at(-1) : state.revisions.find(r => r.rev === rev)
    if (revision === undefined) {
      if (rev !== undefined) throw new Error(`there is no revision r${rev}`)
      const source = await this.bundledSource(this.config.defaultRecipe)
      return { source, hash: sha256(source), bundled: this.config.defaultRecipe }
    }
    const record = state.recipes[revision.recipeHash]
    if (record === undefined) throw new Error(`the session log has no recipe ${revision.recipeHash}`)
    return { source: record.source, hash: record.recipeHash, bundled: record.bundled }
  }

  /**
   * Model of a stored build. Revisions record their model's hash; when the store no longer has it
   * (another machine, cleaned data), use {@link modelOf}.
   * @param hash - model content address.
   * @returns the model.
   */
  model(hash: string): Promise<SequenceModel> {
    return this.store.get(hash)
  }

  /**
   * Model of a revision, rebuilt from the recorded recipe and parameters when the store lacks it.
   * @param session - the session.
   * @param revision - the revision record.
   * @param signal - cancellation.
   * @returns the model.
   */
  async modelOf(session: Session, revision: RevisionRecord, signal?: AbortSignal): Promise<SequenceModel> {
    try {
      return await this.store.get(revision.modelHash)
    } catch (error) {
      if (!(error instanceof ModelUnavailableError)) throw error
    }
    const { source } = await this.recipe(session, revision.rev)
    const result = await runBuild(this.ctx, this.runnerSpec(), {
      recipeSource: source, params: revision.params, baseParams: {}, profile: this.profileInput(),
    }, signal)
    if (!result.ok) throw new Error(`rebuilding r${revision.rev} failed: ${result.error.message}`)
    await this.store.put(result.model, result.seqFile)
    return result.model
  }

  /**
   * Path of a revision's `.seq` file (absent when the build wrote none or the store was cleaned).
   * @param revision - the revision record.
   * @returns absolute path.
   */
  seqPath(revision: RevisionRecord): string {
    return this.store.seqPath(revision.modelHash)
  }

  /**
   * Whether a build of this session is queued or running.
   * @param session - the session.
   * @returns true while a build is pending.
   */
  isBuilding(session: Session): boolean {
    return this.queues.has(String(session.id))
  }

  /**
   * Build and record one revision. Builds of one session run one at a time.
   * @param session - the session that owns the revision.
   * @param request - what to build.
   * @param signal - cancellation.
   * @returns the new revision and model, or the recorded failure.
   */
  build(session: Session, request: BuildRequest, signal?: AbortSignal): Promise<BuildOutcome> {
    const key = String(session.id)
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.buildNow(session, request, signal))
    this.queues.set(key, next)
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key) }).catch(() => undefined)
    return next
  }

  private async buildNow(session: Session, request: BuildRequest, signal?: AbortSignal): Promise<BuildOutcome> {
    const state = this.state(session)
    const current = state.revisions.at(-1)
    let recipeSource: string
    let bundled: string | null = null
    let baseParams: Record<string, number> = current?.params ?? {}
    let kind: RevisionKind
    if (request.restore !== undefined) {
      const target = state.revisions.find(r => r.rev === request.restore)
      if (target === undefined) throw new Error(`there is no revision r${request.restore}`)
      recipeSource = (await this.recipe(session, target.rev)).source
      baseParams = target.params
      kind = 'restore'
    } else if (request.bundled !== undefined) {
      if (!isName(request.bundled)) throw new Error(`"${request.bundled}" is not a recipe name`)
      recipeSource = await this.bundledSource(request.bundled)
      bundled = request.bundled
      baseParams = {}
      kind = current === undefined ? 'init' : 'code'
    } else if (request.recipeSource !== undefined) {
      recipeSource = request.recipeSource
      kind = current === undefined ? 'init' : 'code'
    } else {
      const recipe = await this.recipe(session)
      recipeSource = recipe.source
      bundled = current === undefined ? recipe.bundled : null
      kind = current === undefined ? 'init' : 'param'
    }
    const recipeHash = sha256(recipeSource)
    const params = request.params ?? {}
    const result = await runBuild(this.ctx, this.runnerSpec(), { recipeSource, params, baseParams, profile: this.profileInput() }, signal)
    if (!result.ok) {
      const failure: BuildFailedRecord = { cause: request.cause, kind, author: request.author, recipeHash, params, error: result.error }
      appendPluginRecord(session, BUILD_FAILED_RECORD, failure)
      return { ok: false, error: result.error, failure }
    }
    const model = result.model
    const modelHash = await this.store.put(model, result.seqFile)
    const parentModel = current === undefined ? null : await this.modelOf(session, current, signal).catch(() => null)
    const parentRecipe = current === undefined ? null : state.recipes[current.recipeHash] ?? null
    const recipeDiff = parentRecipe !== null && parentRecipe.recipeHash !== recipeHash
      ? createTwoFilesPatch('recipe.py', 'recipe.py', parentRecipe.source, recipeSource, `r${current!.rev}`, `r${(current?.rev ?? 0) + 1}`)
      : null
    if (kind === 'param' && recipeDiff !== null) kind = 'code'
    if (state.recipes[recipeHash] === undefined) {
      appendPluginRecord(session, RECIPE_RECORD, {
        recipeHash, seq: model.seq, source: recipeSource, origin: bundled === null ? 'edit' : 'bundled', bundled,
        parentHash: parentRecipe?.recipeHash ?? null, diff: recipeDiff, cause: request.cause, author: request.author,
      })
    }
    const values = Object.fromEntries(Object.entries(model.params).map(([name, p]) => [name, p.value]))
    const profile = this.ctx.scannerProfile.profile
    const revision: RevisionRecord = {
      rev: (current?.rev ?? 0) + 1,
      parent: current?.rev ?? null,
      kind,
      cause: request.cause,
      author: request.author,
      seq: model.seq,
      recipeHash,
      params: values,
      paramsHash: sha256(JSON.stringify(values)),
      profile: { id: profile.id, hash: sha256(JSON.stringify(profile)) },
      pypulseqVersion: model.pypulseqVersion,
      modelHash,
      timing: { ok: model.timing.ok, errors: model.timing.errors.length },
      duration: model.duration,
      paramDelta: parentModel === null ? [] : paramChanges(parentModel, model),
      roleDiff: parentModel === null || recipeDiff === null ? null : roleDiff(parentModel, model),
      recipeDiff,
    }
    appendPluginRecord(session, REVISION_RECORD, revision)
    return { ok: true, revision, model }
  }

  private runnerSpec() {
    const { python, timeoutMs, graceMs, maxOutputBytes, confine } = this.config
    return { python, timeoutMs, graceMs, maxOutputBytes, confine }
  }

  private profileInput() {
    return { id: this.ctx.scannerProfile.profile.id, directory: this.ctx.scannerProfile.directory }
  }

  private async bundledSource(name: string): Promise<string> {
    try {
      return await readFile(join(this.config.recipeDirectory, `${name}.py`), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`there is no bundled recipe "${name}"`, { cause: error })
      throw error
    }
  }
}

/**
 * Fold one session event into the sequence state; unrelated events return the same state.
 * @param state - state before the event.
 * @param event - session event.
 * @returns state after the event.
 */
export function applyRecord(state: SequenceState, event: SessionEvent): SequenceState {
  const record = pluginRecordOf(event)
  if (record === undefined) return state
  switch (record.type) {
    case RECIPE_RECORD: {
      const data = record.data as RecipeRecord
      return { ...state, recipes: { ...state.recipes, [data.recipeHash]: data } }
    }
    case REVISION_RECORD:
      return { ...state, revisions: [...state.revisions, record.data as RevisionRecord] }
    case BUILD_FAILED_RECORD:
      return { ...state, lastFailure: { ...(record.data as BuildFailedRecord), afterRev: state.revisions.at(-1)?.rev ?? null } }
    default:
      return state
  }
}

export default PulseSeqService
