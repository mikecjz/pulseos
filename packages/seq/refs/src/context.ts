/** Build the reference context text for one user message. */
import {
  findReferences, resolve, resolveBetween, type ReferenceToken, type RevisionRecord, type SequenceModel,
} from '@pulseos/seq-protocol'
import { describeElement } from '@pulseos/seq-tools/format'

/** What the context builder needs from the session's sequence state. */
export interface ReferenceSource {
  latest: RevisionRecord | undefined
  revision(rev: number): RevisionRecord | undefined
  model(revision: RevisionRecord): Promise<SequenceModel>
  recipe(rev: number): Promise<string>
}

/** Limits on the injected context. */
export interface ReferenceLimits {
  maxReferences: number
  maxCharsPerReference: number
}

/** Outcome of one reference, recorded in the message source. */
export interface ReferenceOutcome {
  id: string
  rev: number | null
  status: 'resolved' | 'changed' | 'gone' | 'unresolved'
  resolvedRev: number | null
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

async function one(token: ReferenceToken, source: ReferenceSource, limits: ReferenceLimits): Promise<{ text: string; outcome: ReferenceOutcome }> {
  const head = `${token.raw}`
  const unresolved = (why: string) => ({ text: `${head} — unresolved: ${why}`, outcome: { id: token.id, rev: token.rev, status: 'unresolved' as const, resolvedRev: null } })
  if (!token.valid) return unresolved('this is not a valid element ID')
  const latest = source.latest
  if (latest === undefined) return unresolved('no sequence has been built in this session yet')
  const pinned = token.rev === null ? latest : source.revision(token.rev)
  if (pinned === undefined) return unresolved(`there is no revision r${token.rev}`)
  const model = await source.model(pinned)
  const found = resolve(model, token.id)
  if (found.status === 'gone') {
    return { text: `${head} — at r${pinned.rev}: ${token.id} does not exist (${found.reason}).`, outcome: { id: token.id, rev: token.rev, status: 'gone', resolvedRev: pinned.rev } }
  }
  const lines = [`${head} — at r${pinned.rev}${pinned.rev === latest.rev ? ' (latest)' : ''}:`, clip(describeElement(model, found, await source.recipe(pinned.rev)), limits.maxCharsPerReference)]
  let status: ReferenceOutcome['status'] = 'resolved'
  if (pinned.rev !== latest.rev) {
    const now = resolveBetween(model, await source.model(latest), token.id)
    if (now.status === 'gone') {
      lines.push(`At the latest revision r${latest.rev} this element no longer exists (${now.reason}).`)
      status = 'gone'
    } else {
      const renamed = now.renamedFrom === undefined ? '' : ` It is now ${now.id}.`
      lines.push(`At the latest revision r${latest.rev} it is ${now.status === 'same' ? 'unchanged' : 'changed'}.${renamed}`)
      if (now.status === 'changed') status = 'changed'
    }
  }
  return { text: lines.join('\n'), outcome: { id: token.id, rev: token.rev, status, resolvedRev: pinned.rev } }
}

/**
 * Describe every reference in a user message.
 * @param text - the user's message text.
 * @param source - the session's sequence state.
 * @param limits - reference and size limits.
 * @returns the context text and per-reference outcomes, or undefined when the text has no references.
 */
export async function referenceContext(text: string, source: ReferenceSource, limits: ReferenceLimits): Promise<{ text: string; outcomes: ReferenceOutcome[] } | undefined> {
  const seen = new Set<string>()
  const tokens = findReferences(text).filter(token => !seen.has(token.raw) && seen.add(token.raw))
  if (tokens.length === 0) return undefined
  const kept = tokens.slice(0, limits.maxReferences)
  const parts = []
  for (const token of kept) parts.push(await one(token, source, limits))
  const lines = [
    '<sequence-references>',
    'The user\'s message refers to these pulse sequence elements; each [[...]] token in the message means the element described here.',
    ...parts.map(p => p.text),
  ]
  if (tokens.length > kept.length) lines.push(`${tokens.length - kept.length} more reference(s) were not expanded; call seq_get_element for them.`)
  lines.push('</sequence-references>')
  return { text: lines.join('\n\n'), outcomes: parts.map(p => p.outcome) }
}
