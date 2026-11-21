/**
 * Resolve element IDs against a sequence model and across revisions. Mirrors
 * `pulseos_seq.resolve`: an ID resolves to its own element or to `gone`, never to another element.
 */

import { formatElementId, MARKER_ROLE, PARAM_ROLE, parseElementId, type ElementId } from './ids.ts'
import type { BlockElement, MarkerElement, ParamElement, RoleElement, RoleEvent, SequenceEvent, SequenceModel } from './model.ts'

export type ResolvedElement =
  | { kind: 'param'; element: ParamElement }
  | { kind: 'marker'; element: MarkerElement }
  | { kind: 'role'; element: RoleElement }
  | { kind: 'role-event'; element: RoleEvent & { role: string } }
  | { kind: 'block'; element: BlockElement }
  | { kind: 'event'; element: SequenceEvent }

export type Resolution =
  | ({ status: 'ok'; id: string } & ResolvedElement)
  | { status: 'gone'; id: string; reason: string }

function loopMatches(loop: Record<string, number>, wanted: ElementId['loop']): boolean {
  const entries = Object.entries(loop)
  return entries.length === wanted.length && entries.every(([name, index], i) => wanted[i]![0] === name && wanted[i]![1] === index)
}

/**
 * Look up one element.
 * @param model - the sequence model.
 * @param elementId - ID string or parsed ID; malformed strings throw `ElementIdError`.
 * @returns `ok` with the element, or `gone` with a reason.
 */
export function resolve(model: SequenceModel, elementId: string | ElementId): Resolution {
  const id = typeof elementId === 'string' ? parseElementId(elementId) : elementId
  const text = formatElementId(id)
  const gone = (reason: string): Resolution => ({ status: 'gone', id: text, reason })
  if (id.seq !== model.seq) return gone(`sequence is "${model.seq}", not "${id.seq}"`)
  if (id.role === PARAM_ROLE) {
    const found = model.params[id.event!]
    return found === undefined ? gone(`no parameter "${id.event}"`) : { status: 'ok', id: text, kind: 'param', element: found }
  }
  if (id.role === MARKER_ROLE) {
    const found = model.markers.find(marker => marker.id === text)
    return found === undefined ? gone(`no marker "${id.event}"`) : { status: 'ok', id: text, kind: 'marker', element: found }
  }
  const role = model.roles.find(r => r.role === id.role)
  if (role === undefined) return gone(`no role "${id.role}"`)
  if (id.event !== undefined && !role.events.some(e => e.name === id.event)) return gone(`role "${id.role}" has no event "${id.event}"`)
  if (id.loop.length === 0) {
    if (id.event === undefined) return { status: 'ok', id: text, kind: 'role', element: role }
    const event = role.events.find(e => e.name === id.event)!
    return { status: 'ok', id: text, kind: 'role-event', element: { ...event, role: id.role } }
  }
  if (id.event === undefined) {
    const block = model.blocks.find(b => b.role === id.role && loopMatches(b.loop, id.loop))
    if (block !== undefined) return { status: 'ok', id: text, kind: 'block', element: block }
  } else {
    const event = model.events.find(e => e.id === text)
    if (event !== undefined) return { status: 'ok', id: text, kind: 'event', element: event }
  }
  return gone('no instance with these loop indices')
}

export type CrossResolution =
  | { status: 'same' | 'changed'; id: string; element: ResolvedElement['element']; kind: ResolvedElement['kind']; renamedFrom?: string }
  | { status: 'gone'; id: string; reason: string }

/**
 * Resolve an ID taken from `older` in `newer`, following declared `formerly` renames.
 * @param older - model the ID was taken from.
 * @param newer - model to resolve in.
 * @param elementId - ID string valid in `older`.
 * @returns `same` / `changed` by fingerprint, or `gone`.
 */
export function resolveBetween(older: SequenceModel, newer: SequenceModel, elementId: string): CrossResolution {
  const id = parseElementId(elementId)
  const before = resolve(older, id)
  let after = resolve(newer, id)
  let renamedFrom: string | undefined
  if (after.status === 'gone' && id.role !== PARAM_ROLE && id.role !== MARKER_ROLE) {
    const target = newer.roles.find(r => r.formerly === id.role)
    if (target !== undefined) {
      after = resolve(newer, { ...id, role: target.role })
      renamedFrom = elementId
    }
  }
  if (after.status === 'gone') return { status: 'gone', id: elementId, reason: after.reason }
  const changed = before.status !== 'ok' || before.element.fingerprint !== after.element.fingerprint
  return {
    status: changed ? 'changed' : 'same', id: after.id, kind: after.kind, element: after.element,
    ...(renamedFrom === undefined ? {} : { renamedFrom }),
  }
}

/** Role-level differences between two models. */
export interface RoleDiff { added: string[]; removed: string[]; renamed: string[]; changed: string[]; same: string[] }

/**
 * Compare the roles of two models.
 * @param older - base model.
 * @param newer - compared model.
 * @returns added, removed, renamed (`old->new`), changed and unchanged role names.
 */
export function roleDiff(older: SequenceModel, newer: SequenceModel): RoleDiff {
  const oldRoles = new Map(older.roles.map(r => [r.role, r]))
  const newRoles = new Map(newer.roles.map(r => [r.role, r]))
  const renamed = new Map<string, string>()
  for (const [name, role] of newRoles) {
    if (role.formerly !== null && oldRoles.has(role.formerly) && !newRoles.has(role.formerly)) renamed.set(role.formerly, name)
  }
  const diff: RoleDiff = { added: [], removed: [], renamed: [], changed: [], same: [] }
  for (const [name, role] of newRoles) {
    const source = [...renamed].find(([, to]) => to === name)?.[0] ?? name
    const previous = oldRoles.get(source)
    if (previous === undefined) { diff.added.push(name); continue }
    if (source !== name) diff.renamed.push(`${source}->${name}`)
    ;(previous.fingerprint === role.fingerprint ? diff.same : diff.changed).push(name)
  }
  diff.removed = [...oldRoles.keys()].filter(name => !newRoles.has(name) && !renamed.has(name))
  return diff
}

/** Parameter changes between two models. */
export interface ParamChange { name: string; id: string; unit: string; before: number | null; after: number | null }

/**
 * List parameters whose values differ.
 * @param older - base model.
 * @param newer - compared model.
 * @returns one entry per added, removed or changed parameter.
 */
export function paramChanges(older: SequenceModel, newer: SequenceModel): ParamChange[] {
  const names = new Set([...Object.keys(older.params), ...Object.keys(newer.params)])
  const changes: ParamChange[] = []
  for (const name of names) {
    const before = older.params[name]
    const after = newer.params[name]
    if (before?.value === after?.value) continue
    changes.push({ name, id: (after ?? before)!.id, unit: (after ?? before)!.unit, before: before?.value ?? null, after: after?.value ?? null })
  }
  return changes
}
