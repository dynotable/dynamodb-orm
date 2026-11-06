import {type Condition, type orm} from 'dynotable-orm';

// Used in types only: the imports that replace it are type imports.
export type MaybeCondition = Condition | undefined;
export type Entry = Parameters<typeof orm.transaction>[0][number];
