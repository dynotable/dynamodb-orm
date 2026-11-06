// Update cases of the CI corpus. Every value is synthetic.
//
// 28 cases ported from a dynamoose 4.x update suite, each marked below. Out of scope:
// - "writes a nested forced default …" and "still writes a top-level forced default …": this lib has no `forceDefault`;
// - "transaction get … applies schema get modifiers": this lib has no transaction `get` and no `get` modifiers.
// Regression cases for nested $SET/$REMOVE and path guards follow, except
// "Should not apply a parent's forced default over a nested $SET value" (`forceDefault` again).
import type {AttributeValue} from '@aws-sdk/client-dynamodb';
import {z} from 'zod';
import {storage} from '../src/zod/meta.js';
import type {Case, Step} from './harness.js';

type Raw = Record<string, AttributeValue>;
type Definition = Record<string, unknown>;

const K = {id: 1};
const seed = (item: Raw, id = 1): Step => ({
  label: `seed ${id}`,
  put: {id: {N: String(id)}, ...item}
});
const at1700 = new Date(1700000000000);

// dynamoose changes the definitions it is given, and the harness builds a Schema more than once: copy them each time.
const copy = (v: unknown): any =>
  Array.isArray(v)
    ? v.map(copy)
    : v?.constructor === Object
      ? Object.fromEntries(Object.entries(v).map(([k, e]) => [k, copy(e)]))
      : v;
// The dynamoose side's `Schema`, built from plain definitions (Combine as a type object).
const schemaOf =
  (schema: Definition, settings?: Definition): Case['dynamoose'] =>
  (d) =>
    new d.Schema(copy(schema), copy(settings));
const combine = (attributes: string[], separator: string) => ({
  value: 'Combine',
  settings: {attributes, separator}
});

const lower = (v: string) => v.toLowerCase();

const opt = {
  str: () => z.string().optional(),
  num: () => z.number().optional()
};

const ported: Case[] = [
  {
    name: 'update: nested remove under a required parent',
    dynamoose: schemaOf({
      id: Number,
      metadata: {type: Object, required: true, schema: {ref: String, code: String}}
    }),
    lib: {
      schema: z.object({id: z.number(), metadata: z.object({ref: opt.str(), code: opt.str()})}),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({metadata: {M: {ref: {S: 'sub'}, code: {S: 'c1'}}}}),
      {
        label: 'removes a nested key under a required parent and keeps its siblings',
        update: [K, {$REMOVE: ['metadata.ref']}]
      }
    ]
  },
  {
    name: 'update: nested remove under a parent with a default',
    dynamoose: schemaOf({
      id: Number,
      settings: {type: Object, default: {theme: 'light'}, schema: {theme: String, lang: String}}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        settings: z.object({theme: opt.str(), lang: opt.str()}).default({theme: 'light'})
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({settings: {M: {theme: {S: 'dark'}, lang: {S: 'es'}}}}),
      {
        label: 'removes a nested key under a parent with a default, without writing the default',
        update: [K, {$REMOVE: ['settings.theme']}]
      }
    ]
  },
  {
    name: 'update: required nested key',
    dynamoose: schemaOf({
      id: Number,
      metadata: {type: Object, schema: {code: {type: String, required: true}}}
    }),
    lib: {
      schema: z.object({id: z.number(), metadata: z.object({code: z.string()}).optional()}),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({metadata: {M: {code: {S: 'c1'}}}}),
      {label: 'refuses to remove a required nested key', update: [K, {$REMOVE: ['metadata.code']}]}
    ],
    failing: ['refuses to remove a required nested key']
  },
  {
    name: 'update: list element in a required list',
    dynamoose: schemaOf({id: Number, tags: {type: Array, required: true, schema: [String]}}),
    lib: {schema: z.object({id: z.number(), tags: z.array(z.string())}), options: {hashKey: 'id'}},
    steps: [
      seed({tags: {L: [{S: 'a'}, {S: 'b'}, {S: 'c'}]}}),
      {label: 'removes a list element in a required list', update: [K, {$REMOVE: ['tags[1]']}]}
    ]
  },
  {
    name: 'update: key inside a list element',
    dynamoose: schemaOf({
      id: Number,
      reps: {type: Array, schema: [{type: Object, schema: {name: String, email: String}}]}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        reps: z.array(z.object({name: opt.str(), email: opt.str()})).optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({reps: {L: [{M: {name: {S: 'a'}, email: {S: 'a@x'}}}]}}),
      {label: 'removes a key inside a list element', update: [K, {$REMOVE: ['reps[0].email']}]}
    ]
  },
  {
    name: 'update: nested path set to undefined',
    dynamoose: schemaOf({id: Number, meta: {type: Object, schema: {name: String, code: String}}}),
    lib: {
      schema: z.object({
        id: z.number(),
        meta: z.object({name: opt.str(), code: opt.str()}).optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({meta: {M: {name: {S: 'x'}, code: {S: 'c1'}}}}),
      {
        label: 'removes a nested path set to undefined',
        update: [K, {$SET: {'meta.name': undefined}}]
      }
    ]
  },
  {
    name: 'update: nested set keeps siblings',
    dynamoose: schemaOf({
      id: Number,
      business: {
        type: Object,
        schema: {name: String, address: {type: Object, schema: {city: String, zip: String}}}
      }
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        business: z
          .object({
            name: opt.str(),
            address: z.object({city: opt.str(), zip: opt.str()}).optional()
          })
          .optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({
        business: {M: {name: {S: 'ACME'}, address: {M: {city: {S: 'Málaga'}, zip: {S: '29001'}}}}}
      }),
      {
        label: 'writes one nested key and keeps its siblings',
        update: [K, {$SET: {'business.address.city': 'Madrid'}}]
      }
    ]
  },
  {
    name: 'update: nested Date in seconds',
    dynamoose: schemaOf({
      id: Number,
      meta: {type: Object, schema: {at: {type: {value: Date, settings: {storage: 'seconds'}}}}}
    }),
    lib: {
      schema: z.object({id: z.number(), meta: z.object({at: z.date().optional()}).optional()}),
      options: {hashKey: 'id', dates: {'meta.at': 'seconds'}}
    },
    steps: [
      seed({meta: {M: {}}}),
      {
        label: 'stores a nested Date with its storage setting and reads it back as a Date',
        update: [K, {$SET: {'meta.at': at1700}}]
      }
    ]
  },
  {
    name: 'update: Date inside a list element',
    dynamoose: schemaOf({
      id: Number,
      items: {type: Array, schema: [{type: Object, schema: {at: Date, label: String}}]}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        items: z.array(z.object({at: z.date().optional(), label: opt.str()})).optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({items: {L: [{M: {label: {S: 'a'}}}, {M: {label: {S: 'b'}}}]}}),
      {label: 'stores a Date inside a list element', update: [K, {$SET: {'items[1].at': at1700}}]}
    ]
  },
  {
    name: 'update: nested transform',
    dynamoose: schemaOf({
      id: Number,
      meta: {type: Object, schema: {name: {type: String, set: (v: string) => v.toUpperCase()}}}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        meta: z.object({name: z.string().toUpperCase().optional()}).optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({meta: {M: {}}}),
      {label: 'applies a nested set modifier', update: [K, {$SET: {'meta.name': 'acme'}}]}
    ]
  },
  {
    name: 'update: nested value checks',
    dynamoose: schemaOf({
      id: Number,
      meta: {type: Object, schema: {status: {type: String, enum: ['A', 'B']}}},
      stats: {
        type: Object,
        schema: {count: Number, positive: {type: Number, validate: (v: number) => v > 0}}
      }
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        meta: z.object({status: z.enum(['A', 'B']).optional()}).optional(),
        stats: z
          .object({
            count: opt.num(),
            positive: z
              .number()
              .refine((v) => v > 0)
              .optional()
          })
          .optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({meta: {M: {status: {S: 'A'}}}, stats: {M: {count: {N: '2'}, positive: {N: '2'}}}}),
      {label: 'refuses a nested value outside the enum', update: [K, {$SET: {'meta.status': 'Z'}}]},
      {
        label: 'refuses a nested value of the wrong type',
        update: [K, {$SET: {'stats.count': 'abc'}}]
      },
      {
        label: 'refuses a nested value that fails validation',
        update: [K, {$SET: {'stats.positive': -1}}]
      }
    ],
    failing: ['refuses a nested value of the wrong type']
  },
  {
    // A schemaless `Object` without saveUnknown declares no key below it: a looseObject, closed under 'dynamoose'.
    name: 'update: schemaless object drops nested keys',
    dynamoose: schemaOf({id: Number, name: String, data: Object}),
    lib: {
      schema: z.object({id: z.number(), name: opt.str(), data: z.looseObject({}).optional()}),
      options: {hashKey: 'id', unknownKeys: 'dynamoose'}
    },
    steps: [
      seed({data: {M: {keep: {S: 'x'}}}}),
      {
        label: 'skips a nested key inside a schemaless Object and writes the rest',
        update: [K, {$SET: {'data.extra': {n: 1}, name: 'y'}}]
      }
    ]
  },
  {
    name: 'update: undeclared nested keys',
    dynamoose: schemaOf({id: Number, meta: {type: Object, schema: {name: String}}}),
    lib: {
      schema: z.object({id: z.number(), meta: z.object({name: opt.str()}).optional()}),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({meta: {M: {name: {S: 'x'}}}}),
      {
        label: 'skips a nested key the schema does not declare and writes the rest',
        update: [K, {$SET: {'meta.extra': 1, 'meta.name': 'y'}}]
      },
      // test/Model.js regression
      {
        label:
          'throws before sending when every key of the update is a nested key the schema drops',
        update: [K, {$SET: {'meta.extra': 1, 'meta.other.deep': 2}}]
      }
    ],
    failing: ['throws before sending when every key of the update is a nested key the schema drops']
  },
  {
    name: 'update: nested key under saveUnknown',
    dynamoose: schemaOf({id: Number, data: Object}, {saveUnknown: ['data.**']}),
    lib: {
      schema: z.object({id: z.number(), data: z.record(z.string(), z.unknown()).optional()}),
      options: {hashKey: 'id', unknownKeys: 'dynamoose'}
    },
    steps: [
      seed({data: {M: {keep: {S: 'x'}}}}),
      {
        label: 'writes a nested key that saveUnknown covers as it is',
        update: [K, {$SET: {'data.extra': {n: 1, tags: ['a']}}}]
      }
    ]
  },
  {
    name: 'update: top-level, nested set and nested remove with timestamps',
    dynamoose: schemaOf(
      {
        id: Number,
        status: String,
        metadata: {type: Object, required: true, schema: {ref: String, code: String, at: Date}}
      },
      {timestamps: {createdAt: null, updatedAt: 'updatedAt'}}
    ),
    lib: {
      schema: z.object({
        id: z.number(),
        status: opt.str(),
        metadata: z.object({ref: opt.str(), code: opt.str(), at: z.date().optional()}),
        updatedAt: z.date().optional()
      }),
      options: {hashKey: 'id', timestamps: {updatedAt: {}}}
    },
    steps: [
      seed({status: {S: 'PENDING'}, metadata: {M: {ref: {S: 'sub'}, code: {S: 'c1'}}}}),
      {
        label:
          'applies a top-level value, a nested $SET and a nested $REMOVE in one update, with timestamps',
        update: [K, {status: 'ACTIVE', $SET: {'metadata.at': at1700}, $REMOVE: ['metadata.ref']}]
      }
    ]
  },
  {
    name: 'update: nested sets and numbers',
    dynamoose: schemaOf({
      id: Number,
      meta: {type: Object, schema: {tags: {type: Set, schema: [String]}}},
      stats: {type: Object, schema: {count: Number}}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        meta: z.object({tags: z.set(z.string()).optional()}).optional(),
        stats: z.object({count: opt.num()}).optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({meta: {M: {tags: {SS: ['a']}}}, stats: {M: {count: {N: '2'}}}}),
      {label: 'adds an array to a nested string set', update: [K, {$ADD: {'meta.tags': ['b']}}]},
      {
        label: 'deletes an array from a nested string set',
        update: [K, {$DELETE: {'meta.tags': ['a']}}]
      },
      {label: 'adds to a nested number', update: [K, {$ADD: {'stats.count': 3}}]}
    ]
  },
  {
    name: 'update: list stored as a list',
    dynamoose: schemaOf({
      id: Number,
      tags: {type: Set, schema: [String]},
      list: {type: Array, schema: [String]}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        tags: z.set(z.string()).optional(),
        list: z.array(z.string()).optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({tags: {SS: ['x']}}),
      {
        label: 'stores a list as a list when a set attribute is removed in the same update',
        update: [K, {$REMOVE: ['tags'], $SET: {list: ['a', 'b']}}]
      }
    ]
  },
  {
    name: 'update: one object in two attributes',
    dynamoose: schemaOf({
      id: Number,
      billing: {type: Object, schema: {city: String}},
      shipping: {type: Object, schema: {city: String}}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        billing: z.object({city: opt.str()}).optional(),
        shipping: z.object({city: opt.str()}).optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      {
        label: 'stores one object used for two attributes in both',
        update: [{id: 1, billing: {city: 'Málaga'}, shipping: {city: 'Málaga'}}]
      }
    ]
  },
  {
    name: 'update: combine',
    dynamoose: schemaOf({
      id: Number,
      name: String,
      first: String,
      last: String,
      full: {type: combine(['first', 'last'], ' ')}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        name: opt.str(),
        first: opt.str(),
        last: opt.str(),
        full: opt.str()
      }),
      options: {hashKey: 'id', combine: {full: {sources: ['first', 'last'], separator: ' '}}}
    },
    steps: [
      seed({first: {S: 'Ada'}, last: {S: 'Lovelace'}, full: {S: 'Ada Lovelace'}}),
      {
        label: 'leaves the combine attribute as it is when no source is written',
        update: [K, {name: 'x'}]
      },
      {
        label: 'recomputes the combine attribute when all sources are written',
        update: [K, {first: 'Grace', last: 'Hopper'}]
      },
      {label: 'refuses an update of some sources only', update: [K, {first: 'Ada'}]},
      {label: 'recomputes from a removed source', update: [K, {first: 'Ada', $REMOVE: ['last']}]}
    ],
    failing: ['refuses an update of some sources only']
  },
  {
    name: 'update: combine as hash key',
    dynamoose: schemaOf({
      pk: {type: combine(['a', 'b'], '#'), hashKey: true},
      a: String,
      b: String,
      note: String
    }),
    lib: {
      schema: z.object({pk: z.string(), a: z.string(), b: z.string(), note: opt.str()}),
      options: {hashKey: 'pk', combine: {pk: {sources: ['a', 'b'], separator: '#'}}}
    },
    steps: [
      {label: 'create', create: {a: 'x', b: 'y'}},
      {
        label: 'updates a model whose hash key is a combine attribute',
        update: [{pk: 'x#y'}, {note: 'hi'}]
      },
      {label: 'refuses a $SET of a key source', update: [{pk: 'x#y'}, {a: 'z'}]},
      {label: 'refuses a $REMOVE of a key source', update: [{pk: 'x#y'}, {$REMOVE: ['b']}]},
      {label: 'refuses an $ADD to a key source', update: [{pk: 'x#y'}, {$ADD: {a: 'q'}}]},
      {label: 'refuses a $DELETE from a key source', update: [{pk: 'x#y'}, {$DELETE: {b: ['x']}}]}
    ],
    failing: [
      'refuses a $SET of a key source',
      'refuses a $REMOVE of a key source',
      'refuses an $ADD to a key source',
      'refuses a $DELETE from a key source'
    ]
  }
];

const lowerV = (item: Record<string, unknown>) => ({
  ...item,
  ...(typeof item.v === 'string' && {v: item.v.toLowerCase()})
});
const markNested = (item: Record<string, unknown>) => {
  const p = item.p as Record<string, unknown> | undefined;
  return typeof p?.s === 'string' ? {...item, p: {...p, s: `${p.s}!`}} : item;
};
const lowerMetaName = (item: Record<string, unknown>) => {
  const meta = item.meta as Record<string, unknown> | undefined;
  return typeof meta?.name === 'string'
    ? {...item, meta: {...meta, name: meta.name.toLowerCase()}}
    : item;
};
const dropV = (item: Record<string, unknown>) => {
  if (item.v !== 'drop') return item;
  const {v: _, ...rest} = item;
  return rest;
};
const isoTimestamps = {
  timestamps: {
    createdAt: {createdAt: {type: {value: Date, settings: {storage: 'iso'}}}},
    updatedAt: {updatedAt: {type: {value: Date, settings: {storage: 'iso'}}}}
  }
};

const added: Case[] = [
  {
    name: 'update shapes',
    dynamoose: schemaOf({
      id: Number,
      n: Number,
      name: String,
      tags: {type: Set, schema: [String]},
      nums: {type: Set, schema: [Number]},
      list: {type: Array, schema: [String]}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        n: opt.num(),
        name: opt.str(),
        tags: z.set(z.string()).optional(),
        nums: z.set(z.number()).optional(),
        list: z.array(z.string()).optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({
        n: {N: '1'},
        name: {S: 'a'},
        tags: {SS: ['a']},
        nums: {NS: ['1']},
        list: {L: [{S: 'a'}]},
        legacy: {S: 'old'}
      }),
      {label: 'implicit $SET', update: [K, {name: 'b'}]},
      {label: '$SET', update: [K, {$SET: {n: 5}}]},
      {label: '$REMOVE as an array', update: [K, {$REMOVE: ['name']}]},
      {label: '$REMOVE as an object of nulls', update: [K, {$REMOVE: {list: null}}]},
      {label: '$REMOVE of an undeclared attribute', update: [K, {$REMOVE: ['legacy']}]},
      {label: '$SET a list', update: [K, {list: ['x']}]},
      {label: '$ADD to a number', update: [K, {$ADD: {n: 2}}]},
      {label: '$ADD a Set', update: [K, {$ADD: {tags: new Set(['b'])}}]},
      {label: '$ADD an array to a Set', update: [K, {$ADD: {tags: ['c']}}]},
      {label: '$ADD an array to a list', update: [K, {$ADD: {list: ['y']}}]},
      {label: '$ADD an element to a list', update: [K, {$ADD: {list: 'z'}}]},
      {label: '$DELETE a Set', update: [K, {$DELETE: {tags: new Set(['a'])}}]},
      {label: '$DELETE an array', update: [K, {$DELETE: {nums: [1]}}]},
      {label: 'one argument holding the key', update: [{id: 1, name: 'c', $ADD: {n: 1}}]},
      {label: 'a scalar key', update: [1, {n: 9}]},
      {label: '$SET undefined removes', update: [K, {name: undefined}]},
      {label: 'an undeclared top-level $SET is dropped', update: [K, {$SET: {nope: 1, n: 12}}]},
      {label: 'returnValues UPDATED_NEW', update: [K, {n: 10}], returnValues: 'UPDATED_NEW'},
      {label: 'returnValues NONE', update: [K, {n: 11}], returnValues: 'NONE'},
      {label: 'an empty update without timestamps', update: [K, {}]}
    ],
    failing: ['an empty update without timestamps']
  },
  {
    // A truthy default replaces a $REMOVE or a $DELETE; 0, false and "" stay a REMOVE.
    name: 'update defaults',
    dynamoose: schemaOf({
      id: Number,
      state: {type: String, default: 'new'},
      tags: {type: Set, schema: [String], default: new Set(['x'])},
      zero: {type: Number, default: 0},
      flag: {type: Boolean, default: false},
      empty: {type: String, default: ''}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        state: z.string().default('new'),
        tags: z.set(z.string()).default(() => new Set(['x'])),
        zero: z.number().default(0),
        flag: z.boolean().default(false),
        empty: z.string().default('')
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({
        state: {S: 'old'},
        tags: {SS: ['a', 'b']},
        zero: {N: '5'},
        flag: {BOOL: true},
        empty: {S: 'z'}
      }),
      {label: 'a truthy default on $REMOVE', update: [K, {$REMOVE: ['state']}]},
      {label: 'a truthy default on $DELETE', update: [K, {$DELETE: {tags: ['a']}}]},
      {label: 'falsy defaults stay REMOVE', update: [K, {$REMOVE: ['zero', 'flag', 'empty']}]},
      {label: 'a truthy default on $SET undefined', update: [K, {$SET: {state: undefined}}]}
    ]
  },
  {
    name: 'update: $ADD under a check',
    dynamoose: schemaOf({id: Number, count: {type: Number, validate: (v: number) => v >= 0}}),
    lib: {
      schema: z.object({id: z.number(), count: z.number().nonnegative().optional()}),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({count: {N: '10'}}),
      {label: '$ADD -1 to a nonnegative 10 stores 9', update: [K, {$ADD: {count: -1}}]}
    ]
  },
  {
    name: 'update: hook',
    dynamoose: schemaOf({id: Number, v: String}, {set: lowerV}),
    lib: {schema: z.object({id: z.number(), v: opt.str()}), options: {hashKey: 'id', set: lowerV}},
    steps: [
      {label: 'the hook on an implicit $SET attribute', update: [K, {v: 'ABC'}]},
      {label: 'the hook on a $SET attribute', update: [K, {$SET: {v: 'DEF'}}]}
    ]
  },
  {
    name: 'update: hook on a nested path',
    dynamoose: schemaOf(
      {id: Number, meta: {type: Object, schema: {name: String}}},
      {set: lowerMetaName}
    ),
    lib: {
      schema: z.object({id: z.number(), meta: z.object({name: opt.str()}).optional()}),
      options: {hashKey: 'id', set: lowerMetaName}
    },
    steps: [
      seed({meta: {M: {}}}),
      {label: 'the hook on a nested $SET path', update: [K, {$SET: {'meta.name': 'ABC'}}]}
    ]
  },
  {
    name: 'update: hook drops the attribute',
    dynamoose: schemaOf({id: Number, v: String}, {set: dropV}),
    lib: {schema: z.object({id: z.number(), v: opt.str()}), options: {hashKey: 'id', set: dropV}},
    steps: [
      seed({v: {S: 'x'}}),
      {label: 'a $SET the hook drops removes the attribute', update: [K, {v: 'drop'}]}
    ]
  },
  {
    name: 'update: combine with updatedAt',
    dynamoose: schemaOf(
      {id: Number, kind: String, k: {type: combine(['kind', 'updatedAt'], '#')}},
      isoTimestamps
    ),
    lib: {
      schema: z.object({
        id: z.number(),
        kind: opt.str(),
        k: opt.str(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional()
      }),
      options: {
        hashKey: 'id',
        timestamps: true,
        defaultDateStorage: 'iso',
        combine: {k: {sources: ['kind', 'updatedAt'], separator: '#'}}
      }
    },
    steps: [
      seed({kind: {S: 'a'}}),
      {label: 'updated through another source only', update: [K, {kind: 'b'}]},
      // updatedAt is always written, so an update that leaves out `kind` writes some sources only.
      {label: 'a touch writes some sources only', update: [K, {}]}
    ],
    failing: ['a touch writes some sources only']
  },
  {
    name: 'update: $ADD to a list of stored Dates',
    dynamoose: schemaOf({
      id: Number,
      rows: {type: Array, schema: [{value: Date, settings: {storage: 'seconds'}}]},
      events: {
        type: Array,
        schema: [
          {type: Object, schema: {at: {value: Date, settings: {storage: 'seconds'}}, n: Number}}
        ]
      },
      nums: {type: Array, schema: [Number]}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        rows: z.array(storage(z.date(), 'seconds')).optional(),
        events: z
          .array(z.object({at: storage(z.date(), 'seconds').optional(), n: opt.num()}))
          .optional(),
        nums: z.array(z.number()).optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({rows: {L: [{N: '1'}]}, events: {L: [{M: {at: {N: '1'}}}]}, nums: {L: [{N: '1'}]}}),
      {
        label: 'appends an array of Dates in seconds',
        update: [K, {$ADD: {rows: [new Date(1500)]}}]
      },
      {label: 'appends one Date in seconds', update: [K, {$ADD: {rows: new Date(2500)}}]},
      {
        label: 'appends an element holding a Date in seconds',
        update: [K, {$ADD: {events: [{at: new Date(3500)}]}}]
      },
      {
        label: 'drops an undeclared key of an appended element',
        update: [K, {$ADD: {events: [{at: new Date(4500), junk: 1}]}}]
      },
      {
        label: 'refuses an appended element of the wrong type',
        update: [K, {$ADD: {nums: ['notanumber']}}]
      },
      {
        label: 'refuses an appended element holding a value of the wrong type',
        update: [K, {$ADD: {events: {n: 'x'}}}]
      }
    ],
    failing: [
      'refuses an appended element of the wrong type',
      'refuses an appended element holding a value of the wrong type'
    ]
  },
  {
    name: 'update: timestamps',
    dynamoose: schemaOf({id: Number, n: Number}, isoTimestamps),
    lib: {
      schema: z.object({
        id: z.number(),
        n: opt.num(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional()
      }),
      options: {hashKey: 'id', timestamps: true, defaultDateStorage: 'iso'}
    },
    steps: [
      seed({
        n: {N: '1'},
        createdAt: {S: '2020-01-01T00:00:00.000Z'},
        updatedAt: {S: '2020-01-01T00:00:00.000Z'}
      }),
      {label: 'an empty update is a touch', update: [K, {}]},
      {label: 'an update writes updatedAt', update: [K, {n: 2}]}
    ]
  },
  {
    // This lib writes a nested truthy default as a $SET of it: the field's set modifier, then the hook. dynamoose
    // 4.2.0 writes it as a top-level attribute (D3).
    name: 'update: nested truthy default',
    dynamoose: schemaOf(
      {
        id: Number,
        p: {
          type: Object,
          schema: {s: {type: String, set: (v: string) => v.toLowerCase(), default: 'UP'}, o: String}
        }
      },
      {set: markNested}
    ),
    lib: {
      schema: z.object({
        id: z.number(),
        p: z.object({s: z.string().toLowerCase().default('UP'), o: opt.str()}).optional()
      }),
      options: {hashKey: 'id', set: markNested}
    },
    steps: [
      seed({p: {M: {s: {S: 'old'}, o: {S: 'x'}}}}),
      {
        label: 'a nested truthy default on $REMOVE goes through the check and the hook',
        update: [K, {$REMOVE: ['p.s']}]
      }
    ]
  },
  {
    // dynamoose's $ADD stores an element as given, without its set modifier or defaults; its $SET of a parent runs
    // the nested set modifiers but puts in no nested default.
    name: 'update: transforms and nested defaults',
    dynamoose: schemaOf({
      id: Number,
      codes: {type: Array, schema: [{type: String, set: lower}]},
      rows: {
        type: Array,
        schema: [{type: Object, schema: {s: {type: String, set: lower, default: 'UP'}, o: String}}]
      },
      p: {
        type: Object,
        schema: {
          s: {type: String, set: lower, default: 'UP'},
          q: {type: Object, schema: {d: {type: String, default: 'D'}}}
        }
      }
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        codes: z.array(z.string().toLowerCase()).optional(),
        rows: z
          .array(z.object({s: z.string().toLowerCase().default('UP'), o: opt.str()}))
          .optional(),
        p: z
          .object({
            s: z.string().toLowerCase().default('UP'),
            q: z.object({d: z.string().default('D')}).optional()
          })
          .optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({codes: {L: []}, rows: {L: []}}),
      {
        label: 'appends elements without their transforms or defaults',
        update: [K, {$ADD: {codes: ['UP'], rows: [{o: 'X'}]}}]
      },
      {label: 'sets a parent without its nested defaults', update: [K, {p: {q: {}}}]},
      {
        label: 'sets a list of objects with their transforms and without their defaults',
        update: [K, {rows: [{o: 'X'}, {o: 'Y', s: 'AB'}]}]
      }
    ]
  },
  {
    name: 'update: combine of a combine',
    dynamoose: schemaOf({
      id: Number,
      a: String,
      b: String,
      c: String,
      ab: {type: combine(['a', 'b'], '-')},
      abc: {type: combine(['ab', 'c'], '+')}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        a: opt.str(),
        b: opt.str(),
        c: opt.str(),
        ab: opt.str(),
        abc: opt.str()
      }),
      options: {
        hashKey: 'id',
        combine: {
          ab: {sources: ['a', 'b'], separator: '-'},
          abc: {sources: ['ab', 'c'], separator: '+'}
        }
      }
    },
    steps: [
      seed({}),
      {
        label: 'computes a combine, then the combine that takes it',
        update: [K, {a: 'A', b: 'B', c: 'C'}]
      }
    ]
  },
  {
    // dynamoose checks only the keys a $SET gives: a nested default, and its own check, are not run.
    name: 'update: $SET a parent without a nested default and its check',
    dynamoose: schemaOf({
      id: Number,
      p: {
        type: Object,
        schema: {s: {type: String, default: 'x', validate: (v: string) => v.length > 3}}
      }
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        p: z
          .object({
            s: z
              .string()
              .default('x')
              .refine((v) => v.length > 3)
          })
          .optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      {label: 'sets a parent that leaves the key out', update: [K, {p: {}}]},
      {label: 'refuses a given value the check fails', update: [K, {p: {s: 'ab'}}]}
    ],
    failing: ['refuses a given value the check fails']
  },
  {
    // An appended element is stored as given: its Dates by its own schema, not by what its set modifier makes.
    name: 'update: $ADD an element a transform renames',
    dynamoose: schemaOf({
      id: Number,
      events: {
        type: Array,
        schema: [
          {
            type: Object,
            schema: {at: {value: Date, settings: {storage: 'seconds'}}},
            set: (e: any) => ({when: e.at})
          }
        ]
      }
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        events: z
          .array(
            z
              .object({at: storage(z.date(), 'seconds')})
              .transform((e) => ({when: e.at}))
              .pipe(z.object({when: z.date()}))
          )
          .optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({events: {L: []}}),
      {
        label: 'appends an element in seconds',
        update: [K, {$ADD: {events: [{at: new Date(5000)}]}}]
      }
    ]
  },
  {
    // An appended element is stored as given, before the list's set modifier: it is checked by the list's input element.
    name: 'update: $ADD to a list a transform renames',
    dynamoose: schemaOf({
      id: Number,
      tags: {
        type: Array,
        schema: [{type: Object, schema: {a: String}}],
        set: (l: {a: string}[]) => l.map((e) => ({b: e.a}))
      }
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        tags: z
          .array(z.object({a: z.string()}))
          .transform((l) => l.map((e) => ({b: e.a})))
          .pipe(z.array(z.object({b: z.string()})))
          .optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({tags: {L: []}}),
      {label: "appends an element of the list's input", update: [K, {$ADD: {tags: [{a: 'x'}]}}]}
    ]
  },
  {
    // Only a truthy default replaces a remove; a falsy one is dropped without its check.
    name: 'update: remove a field with a falsy default and a check',
    dynamoose: schemaOf({
      id: Number,
      s: {type: String, default: '', validate: (v: string) => v.length > 3}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        s: z
          .string()
          .default('')
          .refine((v) => v.length > 3)
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({s: {S: 'long'}}),
      {label: '$REMOVE removes it', update: [K, {$REMOVE: ['s']}]},
      seed({s: {S: 'long'}}, 2),
      {label: '$SET undefined removes it', update: [{id: 2}, {s: undefined}]}
    ]
  },
  {
    // Zod gives an absent value to a pipe's input side first, so a default there is the field's default.
    name: 'update: remove a field whose default is on the input side of a pipe',
    dynamoose: schemaOf({
      id: Number,
      s: {type: String, default: 'abcdef', validate: (v: string) => v.length >= 5}
    }),
    lib: {
      schema: z.object({id: z.number(), s: z.string().default('abcdef').pipe(z.string().min(5))}),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({s: {S: 'longer'}}),
      {label: '$REMOVE writes the default', update: [K, {$REMOVE: ['s']}]},
      seed({s: {S: 'longer'}}, 2),
      {label: '$SET undefined writes the default', update: [{id: 2}, {s: undefined}]}
    ]
  },
  {
    // A set modifier keeps the list's schema; a preprocess declares only its output, so it is the list.
    name: 'update: $ADD to a preprocessed list',
    dynamoose: schemaOf({
      id: Number,
      l: {
        type: Array,
        schema: [{value: Date, settings: {storage: 'seconds'}}],
        set: (l: unknown) => l
      }
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        l: z.preprocess((l) => l, z.array(storage(z.date(), 'seconds'))).optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({l: {L: []}}),
      {label: 'appends one element as a list of it', update: [K, {$ADD: {l: new Date(5000)}}]},
      {label: 'appends a list of elements in seconds', update: [K, {$ADD: {l: [new Date(7000)]}}]},
      {label: 'refuses an element of another type', update: [K, {$ADD: {l: ['nope']}}]}
    ],
    failing: ['refuses an element of another type']
  },
  {
    // dynamoose checks only the keys a $SET gives, so a check after a default (a pipe) is not run either.
    name: 'update: $SET a parent without a nested default piped to a check',
    dynamoose: schemaOf({
      id: Number,
      p: {
        type: Object,
        schema: {s: {type: String, default: 'x', validate: (v: string) => v.length >= 5}}
      }
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        p: z
          .object({
            s: z.string().default('x').pipe(z.string().min(5))
          })
          .optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      {label: 'sets a parent that leaves the key out', update: [K, {p: {}}]},
      {label: 'refuses a given value the check fails', update: [K, {p: {s: 'ab'}}]}
    ],
    failing: ['refuses a given value the check fails']
  }
];

// test/Model.js regression cases.
const dynamooseParent = {
  type: Object,
  schema: {required1: {type: String, required: true}, admin: Boolean},
  validate: (v: any) => typeof v.required1 === 'string' && v.admin !== true
};
const regression: Case[] = [
  {
    name: 'update: parent with a rule',
    dynamoose: schemaOf({
      id: Number,
      parent: dynamooseParent,
      reps: {
        type: Array,
        schema: [{type: Object, schema: {name: String, email: String}}],
        validate: (v: unknown) => Array.isArray(v)
      },
      modified: {
        type: Object,
        schema: {n: Number, flag: Boolean},
        set: (v: any) => ({...v, flag: false})
      }
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        parent: z
          .object({required1: z.string(), admin: z.boolean().optional()})
          .refine((v) => typeof v.required1 === 'string' && v.admin !== true)
          .optional(),
        reps: z
          .array(z.object({name: opt.str(), email: opt.str()}))
          .refine(Array.isArray)
          .optional(),
        modified: z
          .object({n: opt.num(), flag: z.boolean().optional()})
          .transform((v) => ({...v, flag: false}))
          .optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({
        parent: {M: {required1: {S: 'r'}}},
        reps: {L: [{M: {name: {S: 'a'}}}]},
        modified: {M: {n: {N: '1'}}}
      }),
      {
        label: 'a nested $SET under a parent with declared children and its own validate',
        update: [K, {$SET: {'parent.admin': true}}]
      },
      {
        label: 'a nested $REMOVE under a parent with declared children and its own validate',
        update: [K, {$REMOVE: ['parent.admin']}]
      },
      {
        label: 'a nested $SET to undefined under a parent with its own validate',
        update: [K, {$SET: {'parent.admin': undefined}}]
      },
      {
        label: 'a $REMOVE inside a list element under a parent with its own validate',
        update: [K, {$REMOVE: ['reps[0].name']}]
      },
      {
        label: 'a nested $SET under a parent with its own set modifier',
        update: [K, {$SET: {'modified.n': 2}}]
      }
    ],
    failing: ['a $REMOVE inside a list element under a parent with its own validate']
  },
  {
    name: 'update: multi-type parent',
    dynamoose: schemaOf({
      id: Number,
      data: [
        {type: Object, schema: {a: String}},
        {type: Object, schema: {b: Number}}
      ]
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        data: z.union([z.object({a: opt.str()}), z.object({b: opt.num()})]).optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({data: {M: {a: {S: 'x'}}}}),
      {
        label: 'a nested $REMOVE under a multi-type parent with no rule',
        update: [K, {$REMOVE: ['data.a']}]
      },
      {
        label: 'sibling paths of different definitions',
        update: [K, {$SET: {'data.a': 'x', 'data.b': 2}}]
      },
      {label: 'a nested value no definition accepts', update: [K, {$SET: {'data.b': 'abc'}}]}
    ],
    failing: ['a nested value no definition accepts']
  },
  {
    name: 'update: record entries',
    dynamoose: schemaOf(
      {
        id: Number,
        strings: {
          type: Object,
          validate: (v: object) => Object.values(v).every((e) => typeof e === 'string')
        },
        single: {type: Object, validate: (v: object) => Object.keys(v).length === 1}
      },
      {saveUnknown: ['strings.**', 'single.**']}
    ),
    lib: {
      schema: z.object({
        id: z.number(),
        strings: z.record(z.string(), z.string()).optional(),
        single: z
          .record(z.string(), z.string())
          .refine((v) => Object.keys(v).length === 1)
          .optional()
      }),
      options: {hashKey: 'id', unknownKeys: 'dynamoose'}
    },
    steps: [
      seed({strings: {M: {}}, single: {M: {}}}),
      {
        label: "a record's validate on a nested $SET entry",
        update: [K, {$SET: {'strings.foo': 123}}]
      },
      {
        label: "a schemaless parent's validate once per nested entry",
        update: [K, {$SET: {'single.a': '1', 'single.b': '2'}}]
      }
    ]
  },
  {
    name: 'update: nested values',
    dynamoose: schemaOf({
      id: Number,
      parent: {
        type: Object,
        schema: {child: {type: Object, schema: {n: {type: Number, validate: (v: number) => v > 0}}}}
      },
      items: {type: Array, schema: [{type: Object, schema: {at: Date}}]},
      meta: {
        type: Object,
        schema: {
          a: {type: String, set: (v: string) => `${v}!`},
          b: Number,
          deep: {type: Object, schema: {c: Date}}
        }
      }
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        parent: z
          .object({
            child: z
              .object({
                n: z
                  .number()
                  .refine((v) => v > 0)
                  .optional()
              })
              .optional()
          })
          .optional(),
        items: z.array(z.object({at: z.date().optional()})).optional(),
        meta: z
          .object({
            a: z
              .string()
              .transform((v) => `${v}!`)
              .optional(),
            b: opt.num(),
            deep: z.object({c: z.date().optional()}).optional()
          })
          .optional()
      }),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({parent: {M: {}}, items: {L: [{M: {}}, {M: {}}]}, meta: {M: {deep: {M: {}}}}}),
      {
        label: "the validate of the written nested object's own keys",
        update: [K, {$SET: {'parent.child': {n: -1}}}]
      },
      {
        label: 'each element of nested paths into different list elements',
        update: [K, {$SET: {'items[0].at': at1700, 'items[1].at': new Date(1800000000000)}}]
      },
      {
        label: 'many nested paths of one update, each with its own value',
        update: [K, {$SET: {'meta.a': 'x', 'meta.b': 2, 'meta.deep.c': at1700}}]
      }
    ]
  },
  {
    name: 'update: schema-level validate',
    dynamoose: schemaOf(
      {id: Number, meta: {type: Object, schema: {x: String, y: String}}},
      {validate: (o: any) => !(o.meta && o.meta.x && o.meta.y)}
    ),
    lib: {
      schema: z
        .object({id: z.number(), meta: z.object({x: opt.str(), y: opt.str()}).optional()})
        .refine((o) => !(o.meta?.x && o.meta?.y)),
      options: {hashKey: 'id'}
    },
    steps: [
      seed({meta: {M: {}}}),
      {
        label: 'a schema-level validate once per nested path',
        update: [K, {$SET: {'meta.x': '1', 'meta.y': '2'}}]
      }
    ]
  },
  {
    name: 'update: an item read and written back with its updatedAt',
    dynamoose: schemaOf({id: Number, n: Number}, {timestamps: true}),
    lib: {
      schema: z.object({
        id: z.number(),
        n: z.number().optional(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional()
      }),
      options: {hashKey: 'id', timestamps: true}
    },
    steps: [
      seed({n: {N: '1'}, createdAt: {N: '1000'}, updatedAt: {N: '2000'}}),
      {
        label: 'writes the read item back with a change',
        update: [{id: 1, n: 2, createdAt: new Date(1000), updatedAt: new Date(2000)}]
      }
    ],
    failing: ['writes the read item back with a change']
  },
  {
    name: 'update: nested keys dropped with timestamps',
    dynamoose: schemaOf(
      {id: Number, meta: {type: Object, schema: {name: String}}},
      {timestamps: true}
    ),
    lib: {
      schema: z.object({
        id: z.number(),
        meta: z.object({name: opt.str()}).optional(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional()
      }),
      options: {hashKey: 'id', timestamps: true}
    },
    steps: [
      {
        label: 'every requested key is a nested key the schema drops, even with timestamps',
        update: [K, {$SET: {'meta.extra': 1}}]
      }
    ]
  },
  {
    name: 'update: prototype paths',
    dynamoose: schemaOf({id: Number, meta: Object}, {saveUnknown: ['meta.**']}),
    lib: {
      schema: z.object({id: z.number(), meta: z.record(z.string(), z.unknown()).optional()}),
      options: {hashKey: 'id', unknownKeys: 'dynamoose'}
    },
    steps: [
      {label: 'a nested path through __proto__', update: [K, {$SET: {'meta.__proto__': 'x'}}]},
      {label: 'a nested path through constructor', update: [K, {$SET: {'meta.constructor': 'x'}}]}
    ]
  },
  {
    // A looseObject is closed under 'dynamoose' (no record, any or custom field opens it), as on a create.
    name: 'update: undeclared keys of a looseObject under unknownKeys dynamoose',
    dynamoose: schemaOf({
      id: Number,
      meta: {type: Object, schema: {name: String}},
      events: {type: Array, schema: [{type: Object, schema: {n: Number}}]}
    }),
    lib: {
      schema: z.object({
        id: z.number(),
        meta: z.looseObject({name: opt.str()}).optional(),
        events: z.array(z.looseObject({n: opt.num()})).optional()
      }),
      options: {hashKey: 'id', unknownKeys: 'dynamoose'}
    },
    steps: [
      seed({events: {L: []}}),
      {
        label: 'drops an undeclared key of an appended element',
        update: [K, {$ADD: {events: [{n: 1, junk: 2}]}}]
      },
      {
        label: 'drops an undeclared key of a $SET object',
        update: [K, {$SET: {meta: {name: 'a', junk: 1}}}]
      }
    ]
  }
];

export const updateCorpus: Case[] = [...ported, ...added, ...regression];
