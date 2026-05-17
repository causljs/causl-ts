import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: { alias: { '@causl/core': coreSrc } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
  },
})
