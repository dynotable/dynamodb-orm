import {describe, expect, it} from 'vitest';
import {ExpressionError} from '../src/errors.js';
import type {ConditionNode} from '../src/expression/condition-ast.js';
import {compileCondition, compileUpdate} from '../src/expression/compile.js';
import {parsePath} from '../src/expression/paths.js';

const eq = (name: string, s: string): ConditionNode => ({
  kind: 'compare',
  op: '=',
  path: [name],
  value: {S: s}
});

describe('parsePath', () => {
  it('splits names and list indexes', () => {
    expect(parsePath('a.b[0].c')).toStrictEqual(['a', 'b', 0, 'c']);
    expect(parsePath('m[1][12]')).toStrictEqual(['m', 1, 12]);
    // dynamoose accepts a dot before an index.
    expect(parsePath('reps.[0].name')).toStrictEqual(['reps', 0, 'name']);
  });

  it.each([
    [
      'reps[0]name',
      'Invalid path: reps[0]name. A list index must be followed by a dot, another index or the end of the path.'
    ],
    ['[0].a', 'Invalid path: [0].a. A path must start with an attribute name.'],
    ['.[0]', 'Invalid path: .[0]. An attribute name cannot be empty.'],
    ['a..b', 'Invalid path: a..b. An attribute name cannot be empty.'],
    ['a.', 'Invalid path: a.. An attribute name cannot be empty.'],
    ['a[0].', 'Invalid path: a[0].. An attribute name cannot be empty.'],
    ['a[-1]', 'Invalid path: a[-1]. A list index must be a number.'],
    ['a[]', 'Invalid path: a[]. A list index cannot be empty.'],
    ['a[0', 'Invalid path: a[0. A bracket is not closed.'],
    ['a[99999999999999999]', 'Invalid path: a[99999999999999999]. A list index is too large.'],
    ['', 'Invalid path: . An attribute name cannot be empty.'],
    ['__proto__.x', 'Invalid path: __proto__.x. "__proto__" is not allowed as an attribute name.'],
    [
      'a.constructor',
      'Invalid path: a.constructor. "constructor" is not allowed as an attribute name.'
    ],
    [
      'a[0].prototype',
      'Invalid path: a[0].prototype. "prototype" is not allowed as an attribute name.'
    ],
    [
      'a.__proto__[0]',
      'Invalid path: a.__proto__[0]. "__proto__" is not allowed as an attribute name.'
    ]
  ])('rejects %s', (path, message) => {
    expect(() => parsePath(path)).toThrow(new ExpressionError(message));
  });
});

describe('compileCondition', () => {
  it('renders a single equality exactly as dynamoose does', () => {
    expect(compileCondition(eq('status', 'paid'))).toStrictEqual({
      ConditionExpression: '#a0 = :v0',
      ExpressionAttributeNames: {'#a0': 'status'},
      ExpressionAttributeValues: {':v0': {S: 'paid'}}
    });
  });

  it('renders every operator, one number per term and no shared name, as dynamoose', () => {
    const n = (v: string) => ({N: v});
    const result = compileCondition({
      kind: 'and',
      items: [
        {kind: 'compare', op: '<>', path: ['a'], value: n('1')},
        {kind: 'compare', op: '<=', path: ['a'], value: n('9')},
        {kind: 'between', path: ['b', 'c'], low: n('1'), high: n('2')},
        {kind: 'in', path: ['d', 0], values: [{S: 'x'}, {S: 'y'}]},
        {kind: 'begins_with', path: ['e'], value: {S: 'p'}},
        {kind: 'contains', path: ['f'], value: {S: 'q'}},
        {kind: 'attribute_exists', path: ['g']},
        {kind: 'not', item: {kind: 'attribute_not_exists', path: ['h']}}
      ]
    });
    expect(result).toStrictEqual({
      ConditionExpression:
        '#a0 <> :v0 AND #a1 <= :v1 AND #a2_0.#a2_1 BETWEEN :v2_1 AND :v2_2 AND #a3[0] IN (:v3_1, :v3_2) AND ' +
        'begins_with (#a4, :v4) AND contains (#a5, :v5) AND attribute_exists (#a6) AND NOT attribute_not_exists (#a7)',
      ExpressionAttributeNames: {
        '#a0': 'a',
        '#a1': 'a',
        '#a2_0': 'b',
        '#a2_1': 'c',
        '#a3': 'd',
        '#a4': 'e',
        '#a5': 'f',
        '#a6': 'g',
        '#a7': 'h'
      },
      ExpressionAttributeValues: {
        ':v0': n('1'),
        ':v1': n('9'),
        ':v2_1': n('1'),
        ':v2_2': n('2'),
        ':v3_1': {S: 'x'},
        ':v3_2': {S: 'y'},
        ':v4': {S: 'p'},
        ':v5': {S: 'q'}
      }
    });
  });

  it('adds parentheses only where DynamoDB precedence (NOT, AND, OR) needs them, plus explicit groups', () => {
    const [a, b, c, d] = [eq('a', '1'), eq('b', '2'), eq('c', '3'), eq('d', '4')];
    const text = (node: ConditionNode) => compileCondition(node).ConditionExpression;
    expect(text({kind: 'or', items: [{kind: 'and', items: [a, b]}, c]})).toBe(
      '#a0 = :v0 AND #a1 = :v1 OR #a2 = :v2'
    );
    expect(text({kind: 'and', items: [{kind: 'or', items: [a, b]}, c]})).toBe(
      '(#a0 = :v0 OR #a1 = :v1) AND #a2 = :v2'
    );
    expect(text({kind: 'not', item: {kind: 'and', items: [a, b]}})).toBe(
      'NOT (#a0 = :v0 AND #a1 = :v1)'
    );
    expect(
      text({kind: 'and', items: [{kind: 'group', item: {kind: 'and', items: [a, b]}}, d]})
    ).toBe('(#a0 = :v0 AND #a1 = :v1) AND #a2 = :v2');
  });

  it('renames raw placeholders that collide, without touching #a1 inside #a10', () => {
    const items: ConditionNode[] = Array.from({length: 11}, (_, i) => eq(`f${i}`, `${i}`));
    const raw: ConditionNode = {
      kind: 'raw',
      raw: {
        ConditionExpression: '#a1 = :v1 AND #a10 = :v10 AND #own = :own',
        ExpressionAttributeNames: {'#a1': 'p', '#a10': 'q', '#own': 'r'},
        ExpressionAttributeValues: {':v1': {S: 'P'}, ':v10': {S: 'Q'}, ':own': {S: 'R'}}
      }
    };
    const result = compileCondition({kind: 'and', items: [...items, raw]});
    expect(result.ConditionExpression).toBe(
      '#a0 = :v0 AND #a1 = :v1 AND #a2 = :v2 AND #a3 = :v3 AND #a4 = :v4 AND #a5 = :v5 AND #a6 = :v6 AND ' +
        '#a7 = :v7 AND #a8 = :v8 AND #a9 = :v9 AND #a10 = :v10 AND (#a11 = :v11 AND #a12 = :v12 AND #own = :own)'
    );
    expect(result.ExpressionAttributeNames).toMatchObject({
      '#a1': 'f1',
      '#a10': 'f10',
      '#a11': 'p',
      '#a12': 'q',
      '#own': 'r'
    });
    expect(result.ExpressionAttributeValues).toMatchObject({
      ':v1': {S: '1'},
      ':v10': {S: '10'},
      ':v11': {S: 'P'},
      ':v12': {S: 'Q'},
      ':own': {S: 'R'}
    });
  });
});

describe('raw placeholders', () => {
  const elevenFields: ConditionNode[] = Array.from({length: 11}, (_, i) => eq(`f${i}`, `${i}`));

  it('keeps a free raw name before renaming a colliding one, so the fresh name cannot take it', () => {
    const raw: ConditionNode = {
      kind: 'raw',
      raw: {
        ConditionExpression: '#a1 = :x AND #a11 = :y',
        ExpressionAttributeNames: {'#a1': 'p', '#a11': 'q'},
        ExpressionAttributeValues: {':x': {S: 'X'}, ':y': {S: 'Y'}}
      }
    };
    const result = compileCondition({kind: 'and', items: [...elevenFields, raw]});
    expect(result.ConditionExpression?.endsWith('(#a12 = :x AND #a11 = :y)')).toBe(true);
    expect(result.ExpressionAttributeNames).toMatchObject({'#a1': 'f1', '#a11': 'q', '#a12': 'p'});
  });

  it('refuses a key that is not a placeholder, such as an own __proto__ key', () => {
    const raw = (names: object): ConditionNode => ({
      kind: 'raw',
      raw: {ConditionExpression: 'x', ExpressionAttributeNames: names as Record<string, string>}
    });
    expect(() => compileCondition(raw(JSON.parse('{"__proto__": "p"}')))).toThrow(
      new ExpressionError(
        "'__proto__' is not a name placeholder: it starts with # and holds A-Z, a-z, 0-9 or _"
      )
    );
    expect(() =>
      compileCondition({
        kind: 'raw',
        raw: {ConditionExpression: 'x', ExpressionAttributeValues: {v: {S: 'x'}}}
      })
    ).toThrow(
      new ExpressionError(
        "'v' is not a value placeholder: it starts with : and holds A-Z, a-z, 0-9 or _"
      )
    );
  });
});

describe('compileUpdate', () => {
  it('numbers past ten placeholders', () => {
    const actions = Array.from(
      {length: 12},
      (_, i) => ({kind: 'set', path: [`f${i}`], value: {N: `${i}`}}) as const
    );
    const result = compileUpdate(actions);
    expect(result.UpdateExpression).toBe(
      'SET #a0 = :v0, #a1 = :v1, #a2 = :v2, #a3 = :v3, #a4 = :v4, #a5 = :v5, #a6 = :v6, #a7 = :v7, ' +
        '#a8 = :v8, #a9 = :v9, #a10 = :v10, #a11 = :v11'
    );
    expect(result.ExpressionAttributeNames?.['#a1']).toBe('f1');
    expect(result.ExpressionAttributeNames?.['#a10']).toBe('f10');
  });

  it('puts REMOVE (with a list index) before SET, numbering in action order', () => {
    expect(
      compileUpdate([
        {kind: 'set', path: ['a'], value: {S: 'x'}},
        {kind: 'remove', path: ['b']},
        {kind: 'set', path: ['c', 'd'], value: {S: 'y'}},
        {kind: 'remove', path: ['e', 1]}
      ])
    ).toStrictEqual({
      UpdateExpression: 'REMOVE #a1, #a4[1] SET #a0 = :v0, #a2.#a3 = :v2',
      ExpressionAttributeNames: {'#a0': 'a', '#a1': 'b', '#a2': 'c', '#a3': 'd', '#a4': 'e'},
      ExpressionAttributeValues: {':v0': {S: 'x'}, ':v2': {S: 'y'}}
    });
  });

  it("renders DELETE, ADD, list append and if_not_exists in dynamoose's clause order", () => {
    expect(
      compileUpdate([
        {kind: 'set', path: ['x'], value: {N: '0'}, ifNotExists: true},
        {kind: 'append', path: ['l'], value: {L: [{S: 'z'}]}},
        {kind: 'add', path: ['n'], value: {N: '1'}},
        {kind: 'delete', path: ['s'], value: {SS: ['a']}}
      ]).UpdateExpression
    ).toBe(
      'DELETE #a3 :v3 ADD #a2 :v2 SET #a0 = if_not_exists(#a0, :v0), #a1 = list_append(#a1, :v1)'
    );
  });

  it('omits ExpressionAttributeValues when nothing has a value (DynamoDB rejects an empty map)', () => {
    expect(compileUpdate([{kind: 'remove', path: ['a']}])).toStrictEqual({
      UpdateExpression: 'REMOVE #a0',
      ExpressionAttributeNames: {'#a0': 'a'}
    });
  });

  it("keeps a raw condition's #a0/:v0 and numbers the update's own placeholders past them", () => {
    expect(
      compileUpdate([{kind: 'set', path: ['status'], value: {S: 'paid'}}], {
        kind: 'raw',
        raw: {
          ConditionExpression: '#a0 = :v0',
          ExpressionAttributeNames: {'#a0': 'version'},
          ExpressionAttributeValues: {':v0': {N: '3'}}
        }
      })
    ).toStrictEqual({
      ConditionExpression: '#a0 = :v0',
      UpdateExpression: 'SET #a1 = :v1',
      ExpressionAttributeNames: {'#a0': 'version', '#a1': 'status'},
      ExpressionAttributeValues: {':v0': {N: '3'}, ':v1': {S: 'paid'}}
    });
  });

  it('throws on an empty update', () => {
    expect(() => compileUpdate([])).toThrow(new ExpressionError('the update has nothing to write'));
  });
});
