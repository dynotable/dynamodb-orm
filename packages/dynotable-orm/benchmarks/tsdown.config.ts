// Bundles the benchmarks to plain JavaScript in .bench/, so they run under plain node: a TypeScript loader
// such as tsx hooks every `require`, which dynamoose calls inline in its hot paths, and would slow dynamoose.
// One build per entry: a shared chunk would move bench.ts's "run as the main module" check out of bench.js.
import type {UserConfig} from 'tsdown';

const entry = (name: string, file: string): UserConfig => ({
  entry: {[name]: file},
  outDir: '.bench',
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: false,
  // Every package, and this lib's dist, load at run time; only the benchmark's own sources are bundled.
  external: [/^[^./]/]
});

// An array of configs: tsdown builds each one; its defineConfig() types do not take an array.
export default [
  entry('bench', 'benchmarks/bench.ts'),
  entry('competitors.local', 'benchmarks/competitors.local.ts')
];
