import {describe, expect, it, vi} from 'vitest';
import {ConfigError} from '../src/errors.js';
import {resolveMetadata} from '../src/plan.js';
import type {StandardSchema} from '../src/types.js';

const schema: StandardSchema = {
  '~standard': {version: 1, vendor: 'test', validate: (value) => ({value})}
};

describe('resolveMetadata', () => {
  it('fills in the dynamoose defaults', () => {
    const meta = resolveMetadata(schema, {
      hashKey: 'pk',
      rangeKey: 'sk',
      indexes: {
        status: {rangeKey: 'createdAt'},
        kind: [
          {type: 'local', project: false},
          {name: 'byKind', project: ['a']}
        ]
      },
      combine: {sk: {sources: ['a', 'b']}},
      timestamps: true
    });
    expect(meta).toStrictEqual({
      schema,
      key: {hash: 'pk', range: 'sk'},
      // Names and projection as dynamoose Schema.getIndexes builds them.
      indexes: [
        {
          name: 'statusGlobalIndex',
          type: 'global',
          hash: 'status',
          range: 'createdAt',
          project: true
        },
        {name: 'kindLocalIndex', type: 'local', hash: 'pk', range: 'kind', project: false},
        {name: 'byKind', type: 'global', hash: 'kind', project: ['a']}
      ],
      dates: new Map(),
      combine: [{target: 'sk', sources: ['a', 'b'], separator: ',', isKey: true}],
      timestamps: {
        createdAt: {name: 'createdAt', kind: 'date', storage: 'milliseconds'},
        updatedAt: {name: 'updatedAt', kind: 'date', storage: 'milliseconds'}
      },
      defaultDateStorage: 'milliseconds',
      unknownKeys: 'zod'
    });
  });

  it('rejects a combine target that is its own source', () => {
    expect(() =>
      resolveMetadata(schema, {hashKey: 'pk', combine: {k: {sources: ['a', 'k']}}})
    ).toThrow(new ConfigError("the combine target 'k' is also one of its sources"));
  });

  it('rejects a local index on a table without a range key', () => {
    expect(() => resolveMetadata(schema, {hashKey: 'pk', indexes: {at: {type: 'local'}}})).toThrow(
      new ConfigError("the local index on 'at' needs a table range key")
    );
  });

  it('rejects a model without a hash key', () => {
    expect(() => resolveMetadata(schema, {})).toThrow(ConfigError);
  });
});

describe('importing the package', () => {
  const snapshot = () => ({
    globals: Reflect.ownKeys(globalThis),
    prototypes: [
      Object,
      Array,
      Function,
      String,
      Number,
      Boolean,
      Date,
      Map,
      Set,
      Promise,
      Error
    ].map((c) => Reflect.ownKeys(c.prototype)),
    env: {...process.env}
  });

  it('has no side effects', async () => {
    const clients: unknown[] = [];
    vi.resetModules();
    vi.doMock('@aws-sdk/client-dynamodb', async (importOriginal) => {
      const sdk = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
      return {
        ...sdk,
        DynamoDBClient: class extends sdk.DynamoDBClient {
          constructor(...args: ConstructorParameters<typeof sdk.DynamoDBClient>) {
            super(...args);
            clients.push(args);
          }
        }
      };
    });
    try {
      // The SDK's own import side effects (it sets globalThis.awslambda) are not the package's.
      await import('@aws-sdk/client-dynamodb');
      const before = snapshot();
      await import('../src/index.js');
      await import('../src/zod/index.js');
      expect(snapshot()).toStrictEqual(before);
      expect(clients).toStrictEqual([]);
    } finally {
      vi.doUnmock('@aws-sdk/client-dynamodb');
    }
  });
});
