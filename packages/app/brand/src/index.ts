/**
 * Host face of the PulseOS brand plugin. It has nothing to serve: the package exists for its
 * browser face (`src/client/`), which DSH loads from `lib/client.js` once the overlay lists it.
 * @module @pulseos/brand
 */
export const name = 'pulseos-brand'

/** No host behavior. */
export function apply(): void {}
