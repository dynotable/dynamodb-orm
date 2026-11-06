import {defineConfig} from 'tsdown';

export default defineConfig({
  entry: {index: 'src/index.ts', 'zod/index': 'src/zod/index.ts'},
  format: ['esm', 'cjs'],
  // `@internal` members (Condition.toNode, the Retriever plumbing) take the Plan, whose types import Zod.
  dts: {compilerOptions: {stripInternal: true}},
  clean: true
});
