import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
// DSH sources use standard decorators, which Vite's parser does not accept untransformed.
import { standardDecoratorPlugin } from './dsh/vitest.shared.ts'

export default defineConfig({
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/*/*/tests/**/*.spec.ts', 'apps/*/tests/**/*.spec.ts', 'scripts/tests/**/*.spec.mjs'],
    testTimeout: 30_000,
  },
})
