/** Content-addressed storage for sequence models and `.seq` files. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SequenceModel } from '@pulseos/seq-protocol'

/** Thrown when a model hash is not in the store. */
export class ModelUnavailableError extends Error {
  override name = 'ModelUnavailableError'
}

const HASH_RE = /^sha256:([0-9a-f]{64})$/

/**
 * `sha256:<hex>` of a UTF-8 string.
 * @param text - content.
 * @returns the content address.
 */
export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

function hex(hash: string): string {
  const match = HASH_RE.exec(hash)
  if (match === null) throw new ModelUnavailableError(`"${hash}" is not a model hash`)
  return match[1]!
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, data, { mode: 0o600 })
  await rename(temporary, path)
}

/** Stores model JSON under `models/<hex>.json` and `.seq` files under `seq/<hex>.seq`. */
export class ModelStore {
  private readonly cache = new Map<string, SequenceModel>()

  constructor(private readonly root: string, private readonly cacheSize: number) {}

  /**
   * Store a model; identical content is stored once.
   * @param model - model JSON from the runner.
   * @param seqFile - `.seq` bytes, when the build wrote one.
   * @returns the model's content address.
   */
  async put(model: SequenceModel, seqFile: Uint8Array | null): Promise<string> {
    const text = JSON.stringify(model)
    const hash = sha256(text)
    await mkdir(join(this.root, 'models'), { recursive: true })
    await writeAtomic(join(this.root, 'models', `${hex(hash)}.json`), text)
    if (seqFile !== null) {
      await mkdir(join(this.root, 'seq'), { recursive: true })
      await writeAtomic(join(this.root, 'seq', `${hex(hash)}.seq`), seqFile)
    }
    this.remember(hash, model)
    return hash
  }

  /**
   * Load a model by content address.
   * @param hash - `sha256:<hex>`.
   * @returns the parsed model.
   */
  async get(hash: string): Promise<SequenceModel> {
    const cached = this.cache.get(hash)
    if (cached !== undefined) {
      this.remember(hash, cached)
      return cached
    }
    let text: string
    try {
      text = await readFile(join(this.root, 'models', `${hex(hash)}.json`), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ModelUnavailableError(`model ${hash} is not in the store`, { cause: error })
      throw error
    }
    if (sha256(text) !== hash) throw new ModelUnavailableError(`stored model ${hash} does not match its hash`)
    const model = JSON.parse(text) as SequenceModel
    this.remember(hash, model)
    return model
  }

  /**
   * Path of the stored `.seq` file for a model.
   * @param hash - model content address.
   * @returns the absolute path (the file may not exist).
   */
  seqPath(hash: string): string {
    return join(this.root, 'seq', `${hex(hash)}.seq`)
  }

  private remember(hash: string, model: SequenceModel): void {
    this.cache.delete(hash)
    this.cache.set(hash, model)
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!)
  }
}
