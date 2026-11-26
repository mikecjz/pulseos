/** A sequence template the viewer offers: a bundled recipe, built through the normal build path. */
export interface SequenceTemplate {
  /** Bundled recipe name, e.g. `pypulseq_epi`. */
  name: string
  title: string
  description: string
  /** Where the recipe comes from: `pulseos`, or the pypulseq example it was vendored from. */
  origin: string
}
