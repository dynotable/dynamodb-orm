import type {ModelGetSettings as Read} from '@acme/dynamoose/dist/Model';

// A local type with the dynotable-orm name would take the renamed use.
export function read(settings: Read) {
  type GetOptions = number;
  const limit: GetOptions = 1;
  const kept: Read = settings;
  return [limit, kept];
}
