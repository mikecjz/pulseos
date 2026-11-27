/** `[[sim:r<rev>/<phantom>]]` chip in sent user messages. */
import { useSyncExternalStore } from 'react'
import type { SimStore } from './store.ts'
import styles from './chip.module.css'

export interface SimChipProps {
  rev: number
  phantom: string
  engine: string | null
  raw: string
  interactive: boolean
  store: SimStore
  open(rev: number, phantom: string, engine: string | null): void
}

export function SimChip({ rev, phantom, engine, raw, interactive, store, open }: SimChipProps) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const known = snap.state === null || snap.state.runs.some(r => r.rev === rev && r.phantom === phantom && (engine === null || r.engine === engine))
  const label = `Simulation: r${rev} on ${phantom}${engine ? ` with ${engine}` : ''}${known ? '' : ', no such run in this session'}`
  return (
    <span
      className={`${styles.chip} ${known ? '' : styles.unresolved}`}
      data-pulseos-sim-chip={`r${rev}/${phantom}`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={label}
      title={raw}
      onClick={interactive ? () => { open(rev, phantom, engine) } : undefined}
      onKeyDown={interactive ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(rev, phantom, engine) } } : undefined}
    >
      <span className={styles.icon} />
      <span>sim {phantom}{engine ? `@${engine}` : ''}</span>
      <span className={styles.rev}>r{rev}</span>
    </span>
  )
}
