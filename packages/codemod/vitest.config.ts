import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/*.test.ts'],
    // Each run builds a TypeScript program over the fixtures.
    testTimeout: 60_000
  }
});
