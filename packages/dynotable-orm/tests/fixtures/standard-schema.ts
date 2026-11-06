import type {StandardIssue, StandardSchema} from '../../src/types.js';

export interface FixtureItem {
  id: string;
  at?: Date;
  tags?: Set<string>;
  createdAt?: Date;
  updatedAt?: Date;
}

/** A hand-written, non-Zod Standard Schema. Its refine is async: an `id` of `'rejected'` fails after a tick. */
export const fixtureSchema: StandardSchema<FixtureItem> = {
  '~standard': {
    version: 1,
    vendor: 'fixture',
    async validate(value) {
      const item = value as Record<string, unknown>;
      const issues: StandardIssue[] = [];
      if (typeof item?.id !== 'string') issues.push({message: 'id must be a string', path: ['id']});
      for (const key of ['at', 'createdAt', 'updatedAt']) {
        if (item?.[key] !== undefined && !(item[key] instanceof Date))
          issues.push({message: `${key} must be a Date`, path: [key]});
      }
      if (item?.tags !== undefined && !(item.tags instanceof Set))
        issues.push({message: 'tags must be a Set', path: ['tags']});
      await Promise.resolve();
      if (item?.id === 'rejected') issues.push({message: 'id is rejected', path: ['id']});
      return issues.length > 0 ? {issues} : {value: item as unknown as FixtureItem};
    }
  }
};
