import type dynamoose from '@acme/dynamoose';

// Used in types only: the imports that replace it are type imports.
export type MaybeCondition = InstanceType<typeof dynamoose.Condition> | undefined;
export type Entry = Parameters<typeof dynamoose.transaction>[0][number];
