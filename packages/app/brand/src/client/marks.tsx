import { LOGO_TRANSFORM, PULSE_PATH, PULSE_STROKE_WIDTH, WORD_PATH, WORD_TRANSFORM } from './paths.ts'

/*
 * View boxes crop the artwork to its ink (stroke included) plus a small margin; measured from
 * the rendered asset files:
 * - mark (256 square): pulse ink x 13.5–242.5, y 43.5–223 → a 240 square centered on it;
 * - logo (752 × 256): ink x 4–737, y 43.5–223;
 * - wordmark alone (logo coordinates): x 283.8–736.9, y 90.2–205 ("l" ascender to "p" descender).
 */
const MARK_VIEWBOX = '8 13 240 240'
const BANNER_VIEWBOX = { x: 0, y: 39.5, width: 741, height: 188 }
const WORD_VIEWBOX = { x: 282, y: 88, width: 457, height: 119 }

/** Height of the hero banner in px; the DeepSeek hero row it replaces was 34 × 25 fish + 32px title. */
const BANNER_HEIGHT = 52
/** Height of the sidebar wordmark in px: its x-height lands near the 18px brand text it replaces. */
const WORD_HEIGHT = 20

function Pulse() {
  return (
    <path
      d={PULSE_PATH}
      fill="none"
      stroke="currentColor"
      strokeWidth={PULSE_STROKE_WIDTH}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  )
}

/**
 * The pulse mark, square at the requested size (the fish it replaces was 24 wide).
 * @param props.size - edge in px.
 * @returns the decorative mark svg.
 */
export function PulseMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox={MARK_VIEWBOX} fill="none" aria-hidden="true" data-pulseos-mark>
      <Pulse />
    </svg>
  )
}

/**
 * The "pulseos" wordmark glyphs, for the sidebar brand name.
 * @returns the decorative wordmark svg (the brand row is aria-hidden; its button carries the label).
 */
export function Wordmark() {
  const { x, y, width, height } = WORD_VIEWBOX
  return (
    <svg
      width={(WORD_HEIGHT * width) / height}
      height={WORD_HEIGHT}
      viewBox={`${x} ${y} ${width} ${height}`}
      aria-hidden="true"
      data-pulseos-wordmark
    >
      <g transform={LOGO_TRANSFORM}>
        <g transform={WORD_TRANSFORM}><path d={WORD_PATH} fill="currentColor" /></g>
      </g>
    </svg>
  )
}

/**
 * The full PulseOS banner (pulse + wordmark) for the blank-session hero. It ignores the host's
 * fish class so the fish's hover swim does not apply, and it is the hero's accessible title.
 * @returns the banner svg.
 */
export function HeroBanner() {
  const { x, y, width, height } = BANNER_VIEWBOX
  return (
    <svg
      width={(BANNER_HEIGHT * width) / height}
      height={BANNER_HEIGHT}
      viewBox={`${x} ${y} ${width} ${height}`}
      role="img"
      aria-label="PulseOS"
      data-pulseos-banner
    >
      <g transform={LOGO_TRANSFORM}>
        <Pulse />
        <g transform={WORD_TRANSFORM}><path d={WORD_PATH} fill="currentColor" /></g>
      </g>
    </svg>
  )
}
