/**
 * `[[element id]]` tokens in rendered assistant text. DSH offers no inline-token seam for assistant
 * markdown, so instead of rewriting React-owned DOM this styles the token ranges with the CSS
 * Custom Highlight API and resolves clicks and hovers by hit-testing the caret position.
 */
import { findReferences } from '@pulseos/seq-protocol'

export interface HighlightTarget {
  /** Valid tokens are styled as references; others as unresolved. */
  isValid(id: string, rev: number | null): boolean
  open(id: string, rev: number | null): void
  hover(id: string | null, rev: number | null): void
}

interface Token { range: Range; id: string; rev: number | null }

const SKIP = '[contenteditable="true"], textarea, input, [data-pulseos-viewer], [data-pulseos-chip], script, style'

/**
 * Start scanning the document for reference tokens.
 * @param target - resolution and actions for the on-screen session.
 * @returns a disposer and a hook to re-classify tokens.
 */
export function startHighlights(target: HighlightTarget): { dispose(): void; rescan(): void } {
  const registry = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights
  const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  if (registry === undefined || HighlightCtor === undefined) return { dispose: () => {}, rescan: () => {} }
  let tokens: Token[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let hovered: Token | null = null

  const scan = () => {
    const found: Token[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: node => (node.nodeValue?.includes('[[') && !node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    })
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      for (const token of findReferences(node.nodeValue ?? '')) {
        const range = document.createRange()
        range.setStart(node, token.start)
        range.setEnd(node, token.end)
        found.push({ range, id: token.id, rev: token.rev })
      }
    }
    tokens = found
    const ok = found.filter(t => target.isValid(t.id, t.rev)).map(t => t.range)
    const bad = found.filter(t => !target.isValid(t.id, t.rev)).map(t => t.range)
    registry.set('pulseos-ref', new HighlightCtor(...ok))
    registry.set('pulseos-ref-bad', new HighlightCtor(...bad))
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(scan, 150) }

  const tokenAt = (x: number, y: number): Token | null => {
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
    const caret = doc.caretPositionFromPoint?.(x, y)
    if (caret === null || caret === undefined) return null
    for (const token of tokens) {
      if (token.range.startContainer !== caret.offsetNode) continue
      if (caret.offset >= token.range.startOffset && caret.offset <= token.range.endOffset) {
        const rect = token.range.getBoundingClientRect()
        if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) return token
      }
    }
    return null
  }
  const onMove = (event: MouseEvent) => {
    const token = tokens.length === 0 ? null : tokenAt(event.clientX, event.clientY)
    if (token === hovered) return
    hovered = token
    document.documentElement.toggleAttribute('data-pulseos-ref-hover', token !== null)
    target.hover(token?.id ?? null, token?.rev ?? null)
  }
  const onClick = (event: MouseEvent) => {
    const token = tokens.length === 0 ? null : tokenAt(event.clientX, event.clientY)
    if (token === null) return
    event.preventDefault()
    target.open(token.id, token.rev)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })
  document.addEventListener('mousemove', onMove, { passive: true })
  document.addEventListener('click', onClick, true)
  scan()
  const dispose = () => {
    observer.disconnect()
    clearTimeout(timer)
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('click', onClick, true)
    document.documentElement.removeAttribute('data-pulseos-ref-hover')
    registry.delete('pulseos-ref')
    registry.delete('pulseos-ref-bad')
  }
  return { dispose, rescan: schedule }
}
