import type {IndexPlan} from './plan.js';

export interface TableKey {
  readonly hash: string;
  readonly range?: string;
}

/**
 * As dynamoose's `find_best_index`: among the indexes whose hash key has an equality, the first whose
 * range key appears in the conditions, else the table, else the first one. Global indexes come before
 * local ones, then the table. `undefined` when no hash key has an equality.
 */
export function findBestIndex(
  table: TableKey,
  indexes: readonly IndexPlan[],
  equal: ReadonlySet<string>,
  mentioned: ReadonlySet<string>
): TableKey | IndexPlan | undefined {
  const candidates = [
    ...indexes.filter((i) => i.type === 'global'),
    ...indexes.filter((i) => i.type === 'local'),
    table
  ].filter((i) => equal.has(i.hash));
  return (
    candidates.find((i) => i.range !== undefined && mentioned.has(i.range)) ??
    candidates.find((i) => i === table) ??
    candidates[0]
  );
}
