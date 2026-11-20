/** Absolute locations shared by the PulseOS launcher scripts. */
import { fileURLToPath } from 'node:url'

export const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const dshRoot = fileURLToPath(new URL('../dsh/', import.meta.url))
export const appPatch = fileURLToPath(new URL('../apps/pulseos/cordis.patch.yml', import.meta.url))
export const defaultDshHome = fileURLToPath(new URL('../.dsh-home/', import.meta.url))
