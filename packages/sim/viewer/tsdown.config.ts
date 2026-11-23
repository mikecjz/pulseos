import { clientBundle } from '../../../dsh/packages/client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['src/index.ts'])
