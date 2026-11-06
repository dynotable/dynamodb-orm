import {parseArgs} from 'node:util';

/** A scoped dynamoose package (`@<scope>/dynamoose`) is a source too, without being listed. */
export const DEFAULT_SOURCES = ['dynamoose'] as const;
export const DEFAULT_TARGET = 'dynotable-orm';

export interface Config {
  tsconfig: string;
  dryRun: boolean;
  /** The `--source` modules; `migrate()` adds the defaults. */
  sources: string[];
  target: string;
  /** The `--zod` module, or `undefined` for `zod`. */
  zod?: string;
}

const USAGE =
  'usage: dynotable-orm-codemod <tsconfig> [--dry-run] [--source <module>]... [--target <module>] [--zod <module>]';

/** Throws with `USAGE` on a bad command line. */
export function parseConfig(argv: readonly string[]): Config {
  const {values, positionals} = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      'dry-run': {type: 'boolean', default: false},
      source: {type: 'string', multiple: true, default: []},
      target: {type: 'string', default: DEFAULT_TARGET},
      zod: {type: 'string'}
    }
  });
  if (positionals.length !== 1) throw new Error(USAGE);
  return {
    tsconfig: positionals[0],
    dryRun: values['dry-run'],
    sources: values.source,
    target: values.target,
    zod: values.zod
  };
}
