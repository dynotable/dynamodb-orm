import {describe, expect, it} from 'vitest';
import {findBestIndex} from '../src/find-best-index.js';
import type {IndexPlan} from '../src/plan.js';

const table = {hash: 'id', range: 'sk'};
const gsi = (name: string, hash: string, range?: string): IndexPlan => ({
  name,
  type: 'global',
  hash,
  ...(range === undefined ? {} : {range}),
  project: true
});
const set = (...a: string[]) => new Set(a);

describe('findBestIndex', () => {
  const byN = gsi('status-n', 'status', 'n');
  const byAt = gsi('status-at', 'status', 'at');

  it('picks, among two GSIs on one hash, the one whose range key is in the conditions', () => {
    expect(findBestIndex(table, [byN, byAt], set('status'), set('status', 'at'))).toBe(byAt);
    expect(findBestIndex(table, [byN, byAt], set('status'), set('status', 'n'))).toBe(byN);
  });

  it('falls back to the first hash match when no range key is in the conditions', () => {
    expect(findBestIndex(table, [byN, byAt], set('status'), set('status'))).toBe(byN);
  });

  it('prefers the table over a GSI on the table hash, unless the GSI range key is in the conditions', () => {
    const sameHash = gsi('id-status', 'id', 'status');
    expect(findBestIndex(table, [sameHash], set('id'), set('id'))).toBe(table);
    expect(findBestIndex(table, [sameHash], set('id'), set('id', 'status'))).toBe(sameHash);
  });

  it('picks a local index over the table when its range key is in the conditions, and a global one before it', () => {
    const lsi: IndexPlan = {name: 'id-at', type: 'local', hash: 'id', range: 'at', project: true};
    const sameRange = gsi('id-at-global', 'id', 'at');
    expect(findBestIndex(table, [lsi], set('id'), set('id', 'at'))).toBe(lsi);
    // Declared after the local index, the global one still comes first.
    expect(findBestIndex(table, [lsi, sameRange], set('id'), set('id', 'at'))).toBe(sameRange);
  });

  it('finds nothing when no hash key has an equality', () => {
    expect(findBestIndex(table, [byN], set(), set('id', 'status'))).toBeUndefined();
  });
});
