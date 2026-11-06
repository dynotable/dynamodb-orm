import {defineConfig} from 'vitest/config';

export default defineConfig({
  // The schema fixtures import dynamoose as `@acme/dynamoose`, a stand-in for any scoped dynamoose package.
  resolve: {alias: {'@acme/dynamoose': 'dynamoose'}},
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000
  }
});
