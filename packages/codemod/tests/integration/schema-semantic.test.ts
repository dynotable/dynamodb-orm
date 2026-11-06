import dynamoose from 'dynamoose';
import {afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';
import {differences, differs, later} from '../../../dynotable-orm/equivalence/allowlist.js';
import {type Case, runCase, verdict} from '../../../dynotable-orm/equivalence/harness.js';
import {LOCAL} from '../../../dynotable-orm/tests/integration/setup.js';

// Each schema fixture is written through dynamoose 4.2.0 (its input) and through dynotable-orm (the codemod's
// output) on DynamoDB Local, and the stored items and the reads must be equal.
let cases: Case[];

const {D2, D9} = differences;
const refused = [
  'a lives validate fails',
  'a tag RegExp fails',
  'a breed outside the enum',
  'a size outside the enum',
  'a mood outside the enum',
  'name is required'
];
const allowlist = [
  ...differs(D2, 'cat', {'create every attribute': ['write'], 'create with defaults': ['write']}),
  ...differs(D9, 'cat', {update: ['write', 'stored', 'strictRead']}),
  ...differs(later(D9), 'cat', Object.fromEntries(refused.map((step) => [step, ['stored']]))),
  ...differs(D2, 'event', {create: ['write']}),
  ...differs(D9, 'event', {update: ['write', 'stored', 'strictRead']}),
  ...differs(D2, 'audit', {create: ['write']})
];

beforeAll(async () => {
  // The input fixtures define their models at import: bind them to DynamoDB Local before, and let none create a table.
  dynamoose.aws.ddb.set(new dynamoose.aws.ddb.DynamoDB(LOCAL));
  dynamoose.Table.defaults.set({create: false, waitForActive: false});
  const [catIn, catOut, eventIn, eventOut] = await Promise.all([
    import('../fixtures/schema/input/cat.js'),
    import('../fixtures/schema/output/cat.js'),
    import('../fixtures/schema/input/event.js'),
    import('../fixtures/schema/output/event.js')
  ]);
  const owner = {name: 'Ann', since: new Date('2025-06-01T10:20:30.456Z')};
  cases = [
    {
      name: 'cat',
      dynamoose: () => catIn.catSchema,
      lib: {schema: catOut.catSchema, options: catOut.catOptions},
      steps: [
        {
          label: 'create every attribute',
          create: {
            id: 'c1',
            born: 2020,
            name: 'Tom',
            breed: 'persian',
            lives: 7,
            tag: 'grey',
            toys: new Set(['ball', 'mouse']),
            weights: new Set([4.5, 5]),
            chip: Buffer.from([1, 2, 3]),
            adopted: new Date('2024-02-03T04:05:06.789Z'),
            vetVisit: new Date('2026-01-02T03:04:05.999Z'),
            owner: {...owner, unknown: 'dropped'},
            meals: [{food: 'fish', grams: 50, extra: 'dropped'}],
            nickname: null,
            room: 'hall',
            size: 2,
            mood: 'wild',
            indoor: true,
            dropped: 'x'
          }
        },
        {
          label: 'create with defaults',
          create: {id: 'c2', born: 2021, name: 'Kit', nickname: 'kitty'}
        },
        {
          label: 'update',
          update: [
            {id: 'c2', born: 2021},
            {lives: 8, owner}
          ]
        },
        {label: 'a lives validate fails', create: {id: 'c3', born: 2022, name: 'X', lives: 0}},
        {label: 'a tag RegExp fails', create: {id: 'c4', born: 2022, name: 'X', tag: 'Grey'}},
        {
          label: 'a breed outside the enum',
          create: {id: 'c5', born: 2022, name: 'X', breed: 'tabby'}
        },
        {label: 'a size outside the enum', create: {id: 'c6', born: 2022, name: 'X', size: 4}},
        {label: 'a mood outside the enum', create: {id: 'c8', born: 2022, name: 'X', mood: 'Wild'}},
        {label: 'name is required', create: {id: 'c7', born: 2022}}
      ],
      failing: refused
    },
    {
      name: 'event',
      dynamoose: () => eventIn.eventSchema,
      lib: {schema: eventOut.eventSchema, options: eventOut.eventOptions},
      steps: [
        {
          label: 'create',
          create: {
            kind: 'Click',
            ref: 'r1',
            meta: {source: 'web', extra: {deep: [1, {x: true}]}},
            'trace-id': 't1',
            dropped: 1
          }
        },
        {
          label: 'update',
          update: [{pk: 'Click,r1'}, {'trace-id': 't2', meta: {source: 'app', added: 'kept'}}]
        }
      ]
    },
    {
      name: 'audit',
      dynamoose: () => eventIn.auditSchema,
      lib: {schema: eventOut.auditSchema, options: eventOut.auditOptions},
      steps: [
        {
          label: 'create',
          create: {
            id: 'a1',
            body: {kind: 'k', more: {deep: 1}},
            note: {free: ['x']},
            top: {a: {b: 2}}
          }
        }
      ]
    }
  ];
});

beforeEach(() => {
  // Only Date is frozen, so both sides stamp the same timestamps.
  vi.useFakeTimers({toFake: ['Date'], now: new Date('2026-01-02T03:04:05.999Z')});
});
afterEach(() => {
  vi.useRealTimers();
});

it.each(['cat', 'event', 'audit'])(
  '%s stores and reads the same items through dynamoose and the converted model',
  async (name) => {
    const testCase = cases.find((c) => c.name === name)!;
    expect(verdict(testCase, await runCase(testCase, dynamoose), allowlist)).toStrictEqual([]);
  }
);
