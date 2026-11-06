import {defineConfig} from 'vitest/config';

// The benchmark's smoke and gate tests: they need the built dist and .bench/ (`pnpm test:bench` builds both).
export default defineConfig({
  test: {
    include: ['benchmarks/**/*.test.ts'],
    setupFiles: ['tests/setup/block-network.ts']
  }
});
