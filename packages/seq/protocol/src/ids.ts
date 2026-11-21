/**
 * Element IDs: `<seq>:<role>[.<event>][@<loop>=<i>,...]`, `<seq>:param.<name>` and
 * `<seq>:marker.<name>`. The grammar matches `pulseos_seq.ids` in the Python backend.
 */

const NAME = '[A-Za-z][A-Za-z0-9_]*'
const NAME_RE = new RegExp(`^${NAME}$`)
const ID_RE = new RegExp(`^(${NAME}):(${NAME})(?:\\.(${NAME}))?(?:@(${NAME}=\\d+(?:,${NAME}=\\d+)*))?$`)

/** Role names with a fixed meaning. */
export const PARAM_ROLE = 'param'
export const MARKER_ROLE = 'marker'

/** A parsed element ID. `loop` keeps loop-nesting order. */
export interface ElementId {
  seq: string
  role: string
  event?: string
  loop: readonly (readonly [string, number])[]
}

/** Thrown for malformed element IDs. */
export class ElementIdError extends Error {
  override name = 'ElementIdError'
}

/**
 * Whether a string is a valid sequence, role, event, loop or parameter name.
 * @param value - candidate name.
 * @returns true when it matches the name grammar.
 */
export function isName(value: string): boolean {
  return NAME_RE.test(value)
}

/**
 * Parse an element ID.
 * @param text - the ID string.
 * @returns the parsed ID.
 */
export function parseElementId(text: string): ElementId {
  const match = ID_RE.exec(text)
  if (match === null) throw new ElementIdError(`"${text}" is not an element ID (<seq>:<role>[.<event>][@<loop>=<i>,...])`)
  const [, seq, role, event, loopText] = match
  const loop: [string, number][] = []
  if (loopText !== undefined) {
    for (const part of loopText.split(',')) {
      const [name, index] = part.split('=') as [string, string]
      if (loop.some(([seen]) => seen === name)) throw new ElementIdError(`"${text}" repeats loop "${name}"`)
      loop.push([name, Number(index)])
    }
  }
  const id: ElementId = { seq: seq!, role: role!, ...(event === undefined ? {} : { event }), loop }
  if (id.role === PARAM_ROLE && (id.event === undefined || id.loop.length > 0)) {
    throw new ElementIdError(`"${text}": a parameter ID is <seq>:param.<name> with no loop indices`)
  }
  return id
}

/**
 * Format an element ID.
 * @param id - parsed ID.
 * @returns the canonical string.
 */
export function formatElementId(id: ElementId): string {
  let text = `${id.seq}:${id.role}`
  if (id.event !== undefined) text += `.${id.event}`
  if (id.loop.length > 0) text += '@' + id.loop.map(([name, index]) => `${name}=${index}`).join(',')
  return text
}

/**
 * The same element without loop indices.
 * @param id - parsed ID.
 * @returns the role-level ID.
 */
export function roleLevel(id: ElementId): ElementId {
  return { seq: id.seq, role: id.role, ...(id.event === undefined ? {} : { event: id.event }), loop: [] }
}
