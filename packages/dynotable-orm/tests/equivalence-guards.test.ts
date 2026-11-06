import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {allowlist, type AllowlistEntry} from '../equivalence/allowlist.js';
import {difference} from '../equivalence/comparator.js';
import type {Case, CheckResult, StepRecord} from '../equivalence/harness.js';
import {verdict} from '../equivalence/harness.js';

describe('comparator', () => {
  const stored = (a: unknown, b: unknown) => difference(a, b, '$', 'stored');

  it('compares Sets without order: a JS Set, and an SS node of a stored item, also inside a map', () => {
    expect(difference(new Set([1, 2]), new Set([2, 1]))).toBeUndefined();
    expect(stored([{t: {SS: ['b', 'a']}}], [{t: {SS: ['a', 'b']}}])).toBeUndefined();
    expect(
      stored([{m: {M: {t: {NS: ['2', '1']}}}}], [{m: {M: {t: {NS: ['1', '2']}}}}])
    ).toBeUndefined();
  });

  // A read result, or a stored list, can hold an attribute named SS: its order is data.
  it('compares a list in order where an attribute, not the AttributeValue type, is named SS', () => {
    expect(difference({SS: ['a', 'b']}, {SS: ['b', 'a']})).toBeDefined();
    expect(
      stored([{SS: {L: [{S: 'a'}, {S: 'b'}]}}], [{SS: {L: [{S: 'b'}, {S: 'a'}]}}])
    ).toBeDefined();
  });

  it('rejects an SS against the same values as a sorted L', () => {
    expect(difference({t: {SS: ['b', 'a']}}, {t: {L: [{S: 'a'}, {S: 'b'}]}})).toBeDefined();
  });

  it('compares numbers as stored text', () => {
    expect(difference({n: {N: '1'}}, {n: {N: '1.0'}})).toBeDefined();
  });

  it('rejects a missing attribute against NULL', () => {
    expect(difference({a: {S: 'x'}}, {a: {S: 'x'}, b: {NULL: true}})).toBeDefined();
  });

  // JSON.parse makes '__proto__' an own key, as an item read from DynamoDB can have it.
  it.each(['__proto__', 'constructor'])('compares an own %s key', (key) => {
    const item = (s: string) => JSON.parse(`{"${key}": {"S": "${s}"}}`);
    expect(difference(item('old'), item('new'))).toBeDefined();
    expect(difference(item('same'), item('same'))).toBeUndefined();
  });

  it('rejects a Buffer against a Uint8Array', () => {
    expect(difference(Buffer.from([1]), Uint8Array.of(1))).toBeDefined();
  });

  it('finds a different Set element, Date and bytes', () => {
    expect(difference(new Set([1, 2]), new Set([1, 3]))).toBe('$: 2 has no match');
    expect(stored([{t: {SS: ['a', 'b']}}], [{t: {SS: ['a', 'c']}}])).toBe(
      '$[0].t.SS: "b" has no match'
    );
    expect(difference(new Date(0), new Date(1))).toBe(
      '$: Date(1970-01-01T00:00:00.000Z) vs Date(1970-01-01T00:00:00.001Z)'
    );
    expect(difference(Buffer.from([1]), Buffer.from([2]))).toBe('$: bytes differ');
  });
});

describe('verdict', () => {
  const testCase = (failing?: string[]): Case => ({
    name: 'c',
    dynamoose: () => undefined,
    lib: {schema: z.object({id: z.string()}), options: {hashKey: 'id'}},
    steps: [],
    ...(failing && {failing})
  });
  const write = (dyn: 'resolve' | 'reject', lib: 'resolve' | 'reject'): CheckResult => ({
    check: 'write',
    dynamoose: dyn === 'resolve' ? {outcome: dyn} : {outcome: dyn, message: 'Error: no'},
    lib: lib === 'resolve' ? {outcome: lib} : {outcome: lib, message: 'Error: no'},
    ...(dyn !== lib && {diff: `${dyn} vs ${lib}`})
  });
  const stored = (diff?: string): CheckResult => ({
    check: 'stored',
    dynamoose: [],
    lib: [],
    ...(diff && {diff})
  });
  const entry = (over: Partial<AllowlistEntry> = {}): AllowlistEntry => ({
    case: 'c',
    step: 's',
    check: 'stored',
    reason: 'why',
    ref: 'migration guide, Updates',
    ...over
  });
  const steps = (...checks: CheckResult[]): StepRecord[] => [{label: 's', checks}];

  it('fails a step that rejects on both sides unless it is listed in failing', () => {
    expect(verdict(testCase(), steps(write('reject', 'reject')), [])).toStrictEqual([
      's: rejects on both sides but is not listed in failing'
    ]);
    expect(verdict(testCase(['s']), steps(write('reject', 'reject')), [])).toStrictEqual([]);
  });

  it('fails a step this lib rejects with a built-in error class', () => {
    const typeError: CheckResult = {
      check: 'write',
      dynamoose: {outcome: 'reject', message: 'Error: no'},
      lib: {outcome: 'reject', message: 'TypeError: x is undefined'}
    };
    expect(verdict(testCase(['s']), steps(typeError), [])).toStrictEqual([
      's: this lib rejects with a TypeError, a bug rather than a refusal'
    ]);
  });

  it('fails a stale failing entry', () => {
    expect(verdict(testCase(['s']), steps(write('resolve', 'resolve')), [])).toStrictEqual([
      's: listed in failing but dynamoose does not reject'
    ]);
  });

  it('fails a difference unless it is allowlisted for that step and check', () => {
    expect(verdict(testCase(), steps(stored('$.a: 1 vs 2')), [])).toStrictEqual([
      's › stored: $.a: 1 vs 2'
    ]);
    expect(
      verdict(testCase(), steps(stored('$.a: 1 vs 2')), [entry({check: 'read'})])
    ).toStrictEqual([
      's › stored: $.a: 1 vs 2',
      's › read: allowlisted but the check does not run'
    ]);
    expect(verdict(testCase(), steps(stored('$.a: 1 vs 2')), [entry()])).toStrictEqual([]);
  });

  it('fails a stale allowlist entry', () => {
    expect(verdict(testCase(), steps(stored()), [entry()])).toStrictEqual([
      's › stored: allowlisted but does not differ (stale entry)'
    ]);
  });

  it('fails an allowlist entry without a reason or a reference', () => {
    expect(verdict(testCase(), steps(stored('d')), [entry({ref: ' '})])).toStrictEqual([
      'allowlist s › stored: needs a reason and a reference'
    ]);
  });
});

// A renamed guide section or a renumbered difference would leave an entry that cites nothing.
it('cites in every allowlist entry a numbered difference and a section of the migration guide', () => {
  const guide = readFileSync(
    join(import.meta.dirname, '../../../docs/migration-from-dynamoose.md'),
    'utf8'
  );
  const sections = new Set(guide.match(/^#{2,3} .+$/gm)!.map((h) => h.replace(/^#+ /, '')));
  const numbered = new Set([...guide.matchAll(/^\d+\. \*\*(D\d+)\. /gm)].map((m) => m[1]));
  const uncited = allowlist.filter((e) => {
    const difference = /^(D\d+): /.exec(e.reason)?.[1];
    const section = /^migration guide › (.+)$/.exec(e.ref)?.[1];
    return !difference || !numbered.has(difference) || !section || !sections.has(section);
  });
  expect(uncited.map((e) => `${e.case} › ${e.step} › ${e.check}`)).toStrictEqual([]);
});
