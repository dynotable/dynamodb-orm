import {Project} from 'ts-morph';
import {DEFAULT_SOURCES, DEFAULT_TARGET} from './config.js';
import {type SdkImport, sdkImports} from './report.js';
import {Context, type Todo} from './transforms/context.js';
import {transformErrors} from './transforms/errors.js';
import {finishImports, transformImports} from './transforms/imports.js';
import {transformModels} from './transforms/model.js';
import {transformSchemas} from './transforms/schema.js';

export type {SdkImport} from './report.js';
export type {Todo} from './transforms/context.js';

export interface MigrateOptions {
  tsconfig: string;
  /** Modules that re-export dynamoose. `dynamoose` and any scoped dynamoose package (`@<scope>/dynamoose`) always count. */
  sources?: readonly string[];
  /** The module to import dynotable-orm names from. Default `dynotable-orm`. */
  target?: string;
  /**
   * The module the converted schemas read Zod from, as `import * as z from '<zod>'`.
   * Default: `import {z} from 'zod'`.
   */
  zod?: string;
  /** Compute the changes without writing them. */
  dryRun?: boolean;
}

export interface MigrateResult {
  changed: {file: string; text: string}[];
  /** Shapes the codemod cannot convert, each marked in the code. The CLI exits 1 when there is one. */
  todos: Todo[];
  sdkImports: SdkImport[];
}

/** Migrates every source file of the tsconfig's project (not its dependencies) from dynamoose to dynotable-orm. */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const project = new Project({
    tsConfigFilePath: options.tsconfig,
    skipFileDependencyResolution: true
  });
  const sources = [...new Set([...DEFAULT_SOURCES, ...(options.sources ?? [])])];
  const target = options.target ?? DEFAULT_TARGET;
  const result: MigrateResult = {changed: [], todos: [], sdkImports: []};
  const contexts: Context[] = [];
  for (const file of project.getSourceFiles()) {
    if (file.isDeclarationFile() || file.isInNodeModules()) continue;
    const ctx = new Context(file, {sources, target, zod: options.zod});
    transformModels(ctx);
    transformSchemas(ctx);
    transformErrors(ctx);
    transformImports(ctx);
    finishImports(ctx);
    contexts.push(ctx);
  }
  // Rendered after every file was transformed: the type checker reads the unchanged project throughout.
  for (const ctx of contexts) {
    const text = ctx.render();
    result.todos.push(...ctx.todos);
    result.sdkImports.push(...sdkImports(ctx.file, ctx.drops));
    if (text !== ctx.file.getFullText()) result.changed.push({file: ctx.file.getFilePath(), text});
  }
  if (!options.dryRun) {
    for (const {file, text} of result.changed)
      project.getSourceFileOrThrow(file).replaceWithText(text);
    await project.save();
  }
  return result;
}
