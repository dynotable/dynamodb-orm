import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', '**/node_modules/**'],
    setupFiles: ['tests/setup/block-network.ts'],
    typecheck: {enabled: true, include: ['tests/**/*.test-d.ts']}
  }
});
