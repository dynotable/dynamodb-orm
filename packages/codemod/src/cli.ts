import {relative} from 'node:path';
import {parseConfig} from './config.js';
import {migrate} from './index.js';

/** Runs the codemod and returns the exit code: 1 when a TODO was left, 2 on a bad command line. */
export async function main(
  argv: readonly string[],
  log: (line: string) => void = console.log
): Promise<number> {
  let config;
  try {
    config = parseConfig(argv);
  } catch (e) {
    log((e as Error).message);
    return 2;
  }
  const result = await migrate(config);
  const at = (file: string, line?: number) =>
    `${relative(process.cwd(), file)}${line === undefined ? '' : `:${line}`}`;
  log(`${config.dryRun ? 'would change' : 'changed'} ${result.changed.length} file(s)`);
  for (const {file} of result.changed) log(`  ${at(file)}`);
  if (result.sdkImports.length > 0) {
    log('direct DynamoDB SDK imports:');
    for (const i of result.sdkImports) {
      log(
        `  ${at(i.file, i.line)} ${i.name} (${i.module})${i.replacement ? ` → ${i.replacement}` : ''}`
      );
    }
  }
  if (result.todos.length === 0) return 0;
  log(`${result.todos.length} TODO(s) left in the code:`);
  for (const t of result.todos) log(`  ${at(t.file, t.line)} ${t.message}`);
  return 1;
}
