/** `[[element id]]` reference chip in sent user messages. */
import { useSyncExternalStore } from 'react'
import type { ViewerStore } from './store.ts'
import styles from './chip.module.css'

export interface ChipProps {
  id: string
  rev: number | null
  raw: string
  interactive: boolean
  store: ViewerStore
  open(id: string, rev: number | null): void
}

/** Label without the sequence prefix, keeping instance indices (`readout.adc @line=64`). */
export function chipLabel(id: string): string {
  return id.replace(/^[^:]+:/, '').replace('@', ' @')
}

export function Chip({ id, rev, raw, interactive, store, open }: ChipProps) {
  useSyncExternalStore(store.subscribe, () => store.getSnapshot().chips, () => 0)
  const state = store.chipState(id, rev)
  const dot = state.channel === null ? 'var(--param)' : `var(--${state.channel})`
  const revText = state.status === 'changed' ? `r${state.rev ?? state.latest}→r${state.latest}` : state.rev !== null ? `r${state.rev}` : state.latest !== null ? `r${state.latest}` : ''
  const label = `Reference: ${chipLabel(id)}, revision ${state.rev ?? state.latest ?? '?'}${state.status === 'changed' ? `, ${state.detail}` : state.status === 'gone' ? ', no longer exists' : state.status === 'unresolved' ? `, unresolved: ${state.detail}` : ''}`
  return (
    <span
      className={`${styles.chip} ${styles[state.status] ?? ''}`}
      data-pulseos-chip={id}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={label}
      title={`${raw}${state.detail ? ` — ${state.detail}` : ''}`}
      onMouseEnter={() => { store.highlight(id, rev) }}
      onMouseLeave={() => { store.highlight(null) }}
      onFocus={() => { store.highlight(id, rev) }}
      onBlur={() => { store.highlight(null) }}
      onClick={interactive ? () => { open(id, rev) } : undefined}
      onKeyDown={interactive ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(id, rev) } } : undefined}
    >
      <span className={styles.dot} style={{ background: dot }} />
      <span className={styles.label}>{chipLabel(id)}</span>
      {state.status === 'unresolved' ? <span className={styles.rev}>unresolved</span> : revText && <span className={styles.rev}>{revText}</span>}
      {state.status === 'gone' && <span aria-hidden="true">ⓘ</span>}
    </span>
  )
}
