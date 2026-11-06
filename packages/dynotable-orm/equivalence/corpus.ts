// The CI corpus: pairs of a dynamoose `Schema` (the dynamoose 4.2.0 side) and a Zod model (this lib), written for
// this repo. Every value is synthetic. Keys are literals, so both sides write the same items.
import {z} from 'zod';
import {storage} from '../src/zod/meta.js';
import type {Case, Dynamoose} from './harness.js';
import {updateCorpus} from './update-corpus.js';

// Typed loosely: dynamoose's typings reject a Date storage type that its runtime accepts.
const date = (storage: 'iso' | 'milliseconds' | 'seconds'): any => ({
  value: Date,
  settings: {storage}
});
const lower = (item: Record<string, unknown>) => ({
  ...item,
  ...(typeof item.ei === 'string' && {ei: item.ei.toLowerCase()})
});

const flat: Case = {
  name: 'flat',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      name: {type: String, required: true},
      count: Number,
      active: Boolean,
      list: {type: Array, schema: [String]}
    }),
  lib: {
    schema: z.object({
      id: z.string(),
      name: z.string(),
      count: z.number().optional(),
      active: z.boolean().optional(),
      list: z.array(z.string()).optional()
    }),
    options: {hashKey: 'id'}
  },
  steps: [
    {
      label: 'create',
      create: {id: 'f1', name: 'n', count: 3, active: false, list: ['a', 'b'], extra: 'dropped'}
    },
    {label: 'missing required name', create: {id: 'f2'}}
  ],
  failing: ['missing required name']
};

// The number literals of tests/marshall.test.ts, checked against what DynamoDB stores.
const numbers: Case = {
  name: 'numbers',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      tiny: Number,
      negativeZero: Number,
      sum: Number,
      maxSafe: Number,
      negative: Number,
      ns: {type: Set, schema: [Number]}
    }),
  lib: {
    schema: z.object({
      id: z.string(),
      tiny: z.number(),
      negativeZero: z.number(),
      sum: z.number(),
      maxSafe: z.number(),
      negative: z.number(),
      ns: z.set(z.number())
    }),
    options: {hashKey: 'id'}
  },
  steps: [
    {
      label: 'create',
      create: {
        id: 'n1',
        tiny: 1e-7,
        negativeZero: -0,
        sum: 0.1 + 0.2,
        maxSafe: Number.MAX_SAFE_INTEGER,
        negative: -1.5,
        ns: new Set([1e-7, -0, 0.1 + 0.2])
      }
    }
  ]
};

const nested: Case = {
  name: 'nested',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      profile: {
        type: Object,
        schema: {
          name: String,
          address: {type: Object, schema: {city: String, lines: {type: Array, schema: [String]}}}
        }
      }
    }),
  lib: {
    schema: z.object({
      id: z.string(),
      profile: z
        .object({
          name: z.string().optional(),
          address: z
            .object({city: z.string().optional(), lines: z.array(z.string()).optional()})
            .optional()
        })
        .optional()
    }),
    options: {hashKey: 'id'}
  },
  steps: [
    {
      label: 'create',
      create: {
        id: 'o1',
        profile: {
          name: 'p',
          extra: 1,
          address: {city: 'c', lines: ['l1', 'l2'], extra: {deep: true}}
        }
      }
    }
  ]
};

const setsAndBuffer: Case = {
  name: 'sets and buffer',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      ss: {type: Set, schema: [String]},
      ns: {type: Set, schema: [Number]},
      bytes: Buffer
    }),
  lib: {
    schema: z.object({
      id: z.string(),
      ss: z.set(z.string()).optional(),
      ns: z.set(z.number()).optional(),
      bytes: z.instanceof(Uint8Array).optional()
    }),
    options: {hashKey: 'id'}
  },
  steps: [
    {
      label: 'create',
      create: {
        id: 's1',
        ss: new Set(['b', 'a']),
        ns: new Set([2, 1]),
        bytes: Buffer.from([1, 2, 3])
      }
    }
  ]
};

// …999 ms: a seconds Date attribute rounds up, an iso one keeps the milliseconds.
const AT_999 = new Date('2026-01-02T03:04:05.999Z');

const dates: Case = {
  name: 'dates',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      iso: date('iso'),
      ms: date('milliseconds'),
      sec: date('seconds'),
      meta: {type: Object, schema: {at: date('seconds')}}
    }),
  lib: {
    schema: z.object({
      id: z.string(),
      iso: z.date().optional(),
      ms: z.date().optional(),
      sec: z.date().optional(),
      meta: z.object({at: z.date().optional()}).optional()
    }),
    options: {hashKey: 'id', dates: {iso: 'iso', sec: 'seconds', 'meta.at': 'seconds'}}
  },
  steps: [
    {label: 'create', create: {id: 'd1', iso: AT_999, ms: AT_999, sec: AT_999, meta: {at: AT_999}}}
  ]
};

// No storage setting on either side: dynamoose stores a Date and the timestamps in milliseconds.
const defaultDates: Case = {
  name: 'dates with no storage setting',
  dynamoose: (d) =>
    new d.Schema(
      {id: {type: String, hashKey: true}, at: Date, meta: {type: Object, schema: {at: Date}}},
      {timestamps: true}
    ),
  lib: {
    schema: z.object({
      id: z.string(),
      at: z.date().optional(),
      meta: z.object({at: z.date().optional()}).optional(),
      createdAt: z.date().optional(),
      updatedAt: z.date().optional()
    }),
    options: {hashKey: 'id', timestamps: true}
  },
  steps: [
    {label: 'create', create: {id: 'n1', at: AT_999, meta: {at: AT_999}}},
    {label: 'get', get: {id: 'n1'}}
  ]
};

// A Zod→dynamoose converter turns a union of a Date with a string into a Date attribute.
const dateUnion: Case = {
  name: 'date union',
  dynamoose: (d) => new d.Schema({id: {type: String, hashKey: true}, when: date('iso')}),
  lib: {
    schema: z.object({id: z.string(), when: z.union([z.date(), z.string()]).optional()}),
    options: {hashKey: 'id', defaultDateStorage: 'iso'}
  },
  steps: [{label: 'create from a Date', create: {id: 'u1', when: AT_999}}]
};

// A Date field whose transform keeps the Date, in a list: its storage mark applies, as dynamoose's on a Date
// element with a set modifier.
const transformedDates: Case = {
  name: 'transformed dates in a list',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      at: {type: Array, schema: [{...date('seconds'), set: (v: Date) => v}]}
    }),
  lib: {
    schema: z.object({
      id: z.string(),
      at: z
        .array(
          storage(
            z.date().transform((v) => v),
            'seconds'
          )
        )
        .optional()
    }),
    options: {hashKey: 'id'}
  },
  steps: [{label: 'create', create: {id: 't1', at: [AT_999]}}]
};

const combineKey: Case = {
  name: 'combine as key',
  dynamoose: (d) =>
    new d.Schema({
      pk: {type: d.type.COMBINE(['kind', 'ref'], '#'), hashKey: true},
      kind: {type: String, required: true},
      ref: {type: String, required: true}
    }),
  lib: {
    schema: z.object({pk: z.string(), kind: z.string(), ref: z.string()}),
    options: {hashKey: 'pk', combine: {pk: {sources: ['kind', 'ref'], separator: '#'}}}
  },
  steps: [{label: 'create', create: {kind: 'user', ref: 'r1'}}]
};

// A number createdAt is stored in milliseconds; a seconds updatedAt floors (a Date attribute rounds).
const mixedTimestamps: Case = {
  name: 'mixed timestamps',
  dynamoose: (d) =>
    new d.Schema(
      {id: {type: String, hashKey: true}, sec: date('seconds')},
      {
        timestamps: {
          createdAt: {createdAt: {type: Number}},
          updatedAt: {updatedAt: {type: date('seconds')}}
        }
      }
    ),
  lib: {
    schema: z.object({
      id: z.string(),
      sec: z.date().optional(),
      createdAt: z.number().optional(),
      updatedAt: z.date().optional()
    }),
    options: {
      hashKey: 'id',
      dates: {sec: 'seconds'},
      timestamps: {createdAt: {}, updatedAt: {storage: 'seconds'}}
    }
  },
  steps: [
    {label: 'create', create: {id: 't1', sec: AT_999}},
    {
      label: 'create with createdAt in the input',
      create: {id: 't2', createdAt: 5, updatedAt: new Date(0)}
    }
  ]
};

const isoTimestamps: Case = {
  name: 'iso timestamps',
  dynamoose: (d) =>
    new d.Schema(
      {id: {type: String, hashKey: true}},
      {
        timestamps: {
          createdAt: {createdAt: {type: date('iso')}},
          updatedAt: {updatedAt: {type: date('iso')}}
        }
      }
    ),
  lib: {
    schema: z.object({
      id: z.string(),
      createdAt: z.date().optional(),
      updatedAt: z.date().optional()
    }),
    options: {hashKey: 'id', timestamps: true, defaultDateStorage: 'iso'}
  },
  steps: [{label: 'create with createdAt in the input', create: {id: 'i1', createdAt: new Date(0)}}]
};

// A default, the whole-item hook and combine, in dynamoose's write order. dynamoose stores k "DEF#UP" and ei "up".
const hook: Case = {
  name: 'default, hook and combine',
  dynamoose: (d) =>
    new d.Schema(
      {
        id: {type: String, hashKey: true},
        ei: String,
        ec: {type: String, default: 'DEF'},
        k: {type: d.type.COMBINE(['ec', 'ei'], '#')}
      },
      {set: lower}
    ),
  lib: {
    schema: z.object({
      id: z.string(),
      ei: z.string(),
      ec: z.string().default('DEF'),
      k: z.string().optional()
    }),
    options: {hashKey: 'id', combine: {k: {sources: ['ec', 'ei'], separator: '#'}}, set: lower}
  },
  steps: [{label: 'create', create: {id: 'h1', ei: 'UP'}}]
};

// dynamoose gives a nested default before its set modifier runs, so it stores "up". dynamoose has no tuple: its
// side is a list of the same element.
const nestedDefault: Case = {
  name: 'nested default through its check',
  dynamoose: (d) => {
    const s = {type: String, set: (v: any) => v.toLowerCase(), default: 'UP'};
    return new d.Schema({
      id: {type: String, hashKey: true},
      p: {type: Object, schema: {s, o: String}},
      pair: {type: Array, schema: [{type: Object, schema: {s, o: String}}]}
    });
  },
  lib: {
    schema: z.object({
      id: z.string(),
      p: z.object({s: z.string().toLowerCase().default('UP'), o: z.string().optional()}).optional(),
      pair: z
        .tuple([z.object({s: z.string().toLowerCase().default('UP'), o: z.string().optional()})])
        .optional()
    }),
    options: {hashKey: 'id'}
  },
  steps: [
    {label: 'create with the parent and no nested value', create: {id: 'nd1', p: {o: 'x'}}},
    {label: 'create without the parent', create: {id: 'nd2'}},
    {
      label: 'create with a tuple element and no nested value',
      create: {id: 'nd3', pair: [{o: 'x'}]}
    }
  ]
};

const defaults: Case = {
  name: 'defaults',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      state: {type: String, default: 'new'},
      zero: {type: Number, default: 0},
      flag: {type: Boolean, default: false}
    }),
  lib: {
    schema: z.object({
      id: z.string(),
      state: z.string().default('new'),
      zero: z.number().default(0),
      flag: z.boolean().default(false)
    }),
    options: {hashKey: 'id'}
  },
  steps: [
    {label: 'create with no values', create: {id: 'x1'}},
    {label: 'create with values', create: {id: 'x2', state: 'old', zero: 7, flag: true}}
  ]
};

// dynamoose gives a default for null too, where the field's type accepts null; one that does not rejects the null.
// An update writes the null as given.
const nullDefaults: Case = {
  name: 'null takes the default',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      state: {type: [String, d.type.NULL], default: 'new'},
      p: {type: Object, schema: {m: {type: [String, d.type.NULL], default: 'x'}}},
      plain: {type: String, default: 'd'}
    }),
  lib: {
    schema: z.object({
      id: z.string(),
      state: z.string().nullable().default('new'),
      p: z.object({m: z.string().nullable().default('x')}).optional(),
      plain: z.string().default('d')
    }),
    options: {hashKey: 'id'}
  },
  steps: [
    {label: 'create with nulls', create: {id: 'n1', state: null, p: {m: null}}},
    {label: 'update to null', update: [{id: 'n1'}, {state: null}]},
    {label: 'null where the type has no null', create: {id: 'n2', plain: null}}
  ],
  failing: ['null where the type has no null']
};

// A transform over a whole list, as dynamoose's set on the Array: its elements' Dates are still stored, and their
// defaults still go through the element's checks.
const transformedList: Case = {
  name: 'transformed list',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      at: {type: Array, schema: [date('seconds')], set: (v: any) => v},
      rows: {
        type: Array,
        schema: [
          {
            type: Object,
            schema: {s: {type: String, set: (v: any) => v.toLowerCase(), default: 'UP'}}
          }
        ],
        set: (v: any) => v
      }
    }),
  lib: {
    schema: z.object({
      id: z.string(),
      at: z
        .array(storage(z.date(), 'seconds'))
        .transform((v) => v)
        .optional(),
      rows: z
        .array(z.object({s: z.string().toLowerCase().default('UP')}))
        .transform((v) => v)
        .optional()
    }),
    options: {hashKey: 'id'}
  },
  steps: [{label: 'create', create: {id: 'tl1', at: [AT_999], rows: [{}]}}]
};

// A Zod→dynamoose converter: a record at the root keeps the field whole (`tags.**`); one level down it opens its parent (`meta.**`).
const records: Case = {
  name: 'records',
  dynamoose: (d) =>
    new d.Schema(
      {
        id: {type: String, hashKey: true},
        tags: Object,
        meta: {type: Object, schema: {known: String, extra: Object}}
      },
      {saveUnknown: ['tags.**', 'meta.**']}
    ),
  lib: {
    schema: z.object({
      id: z.string(),
      tags: z.record(z.string(), z.unknown()).optional(),
      meta: z
        .object({known: z.string().optional(), extra: z.record(z.string(), z.string()).optional()})
        .optional()
    }),
    options: {hashKey: 'id', unknownKeys: 'dynamoose'}
  },
  steps: [
    {
      label: 'create',
      create: {
        id: 'r1',
        dropped: 1,
        tags: {a: 'x', deep: {b: 1}},
        meta: {known: 'k', extra: {e: 'v'}, sibling: {kept: true}}
      }
    },
    {
      label: 'update keeps the undeclared keys of an opened parent',
      update: [{id: 'r1'}, {meta: {known: 'k2', sibling: {kept: false}}}]
    }
  ]
};

// The hook changes a nested value in place. dynamoose hands it a deep copy, so the caller's input stays as given.
const touch = (item: Record<string, unknown>) => {
  const inner = (item.meta as Record<string, any> | undefined)?.inner;
  if (inner) inner.touched = true;
  return item;
};
const hookCopy: Case = {
  name: 'hook on nested values',
  dynamoose: (d) =>
    new d.Schema(
      {id: {type: String, hashKey: true}, meta: Object},
      {saveUnknown: ['meta.**'], set: touch}
    ),
  lib: {
    schema: z.object({id: z.string(), meta: z.record(z.string(), z.unknown()).optional()}),
    options: {hashKey: 'id', unknownKeys: 'dynamoose', set: touch}
  },
  steps: [
    {label: 'create', create: {id: 'n1', meta: {inner: {a: 1}}}},
    {label: 'update', update: [{id: 'n1'}, {meta: {inner: {a: 2}}}]}
  ]
};

// dynamoose runs the hook once on the whole key (convertKeyToObject), so a hook can read both key attributes.
const prefixSk = (item: Record<string, unknown>) =>
  typeof item.id === 'string' && typeof item.sk === 'string' && !item.sk.includes('#')
    ? {...item, sk: `${item.id}#${item.sk}`}
    : item;
const keyHook: Case = {
  name: 'hook on the key',
  dynamoose: (d) =>
    new d.Schema(
      {id: {type: String, hashKey: true}, sk: {type: String, rangeKey: true}, n: Number},
      {set: prefixSk}
    ),
  lib: {
    schema: z.object({id: z.string(), sk: z.string(), n: z.number().optional()}),
    options: {hashKey: 'id', rangeKey: 'sk', set: prefixSk}
  },
  steps: [
    {label: 'create', create: {id: 'a', sk: 'x', n: 1}},
    {label: 'get', get: {id: 'a', sk: 'x'}},
    {label: 'update', update: [{id: 'a', sk: 'x'}, {n: 2}]},
    {label: 'delete', delete: {id: 'a', sk: 'x'}},
    {label: 'get after delete', get: {id: 'a', sk: 'x'}}
  ]
};

// Single-item CRUD on a timestamped model. `save` is dynamoose's item.save() of an item that was read.
const crud: Case = {
  name: 'crud',
  dynamoose: (d) =>
    new d.Schema(
      {id: {type: String, hashKey: true}, n: Number},
      {
        timestamps: {
          createdAt: {createdAt: {type: date('iso')}},
          updatedAt: {updatedAt: {type: date('iso')}}
        }
      }
    ),
  lib: {
    schema: z.object({
      id: z.string(),
      n: z.number().optional(),
      createdAt: z.date().optional(),
      updatedAt: z.date().optional()
    }),
    options: {hashKey: 'id', timestamps: true, defaultDateStorage: 'iso'}
  },
  steps: [
    {label: 'create', create: {id: 'c1', n: 1}},
    {label: 'create on a stored key', create: {id: 'c1', n: 2}},
    {
      label: 'create with overwrite',
      create: {id: 'c1', n: 3, createdAt: new Date(0)},
      overwrite: true
    },
    {label: 'save keeps createdAt', save: {id: 'c1', n: 4, createdAt: new Date(0)}},
    {label: 'get', get: {id: 'c1'}},
    {label: 'get a scalar key', get: 'c1'},
    {label: 'get a missing key', get: {id: 'missing'}},
    {label: 'delete', delete: {id: 'c1'}},
    {label: 'get after delete', get: {id: 'c1'}}
  ],
  failing: ['create on a stored key']
};

// The key's set modifier (a lenient field transform) runs on the key of every call.
const transformedKey: Case = {
  name: 'transformed key',
  dynamoose: (d) =>
    new d.Schema({
      email: {
        type: String,
        hashKey: true,
        set: (v: any) => (typeof v === 'string' ? v.toLowerCase() : v)
      },
      n: Number
    }),
  lib: {
    schema: z.object({email: z.string().toLowerCase(), n: z.number().optional()}),
    options: {hashKey: 'email'}
  },
  steps: [
    {label: 'create', create: {email: 'Jane@Example.COM', n: 1}},
    {label: 'get in mixed case', get: {email: 'JANE@example.com'}},
    {label: 'get a scalar key in mixed case', get: 'jane@EXAMPLE.com'},
    {label: 'delete in mixed case', delete: {email: 'JaNe@ExAmPlE.cOm'}},
    {label: 'get after delete', get: {email: 'jane@example.com'}}
  ]
};

// Items a fleet wrote before a schema change, put raw. Both sides return a mismatched stored type as stored.
const legacy: Case = {
  name: 'legacy items',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      at: date('iso'),
      tags: {type: Set, schema: [String]}
    }),
  lib: {
    schema: z.object({id: z.string(), at: z.date().optional(), tags: z.set(z.string()).optional()}),
    options: {hashKey: 'id', defaultDateStorage: 'iso'}
  },
  steps: [
    {label: 'N on an iso path', put: {id: {S: 'l1'}, at: {N: '1700000000'}}},
    {label: 'ISO string that does not parse', put: {id: {S: 'l2'}, at: {S: 'not-a-date'}}},
    {label: 'L on a Set path', put: {id: {S: 'l3'}, tags: {L: [{S: 'a'}]}}}
  ]
};

// `order`: a dynamoose benchmark order schema (Unlicense), about
// 60 attributes: wide nested objects with checks, a list of objects with multi-type attributes, schemaless
// objects kept through `saveUnknown`, a Set, enums, three global indexes and iso timestamps. Tasks 9 and
// 17 benchmark it. The data has literal ids in place of random ones.
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isSafeString = (v: unknown) => typeof v === 'string' && !/[<>]/.test(v);
const isCountryCode = (v: unknown) => typeof v === 'string' && (!v || /^[A-Z]{2}$/.test(v));
const isSessionId = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(v);
const isHexId = (v: unknown) => typeof v === 'string' && /^[0-9a-fA-F]{40}$/.test(v);
const isFinancingSelection = (v: unknown) =>
  isRecord(v) &&
  [true, false, 'true', 'false'].includes(v.accepted as never) &&
  (v.termCount === undefined || !Number.isNaN(Number(v.termCount))) &&
  (v.planType === undefined || typeof v.planType === 'string');
function conformFinancingSelection(v: unknown) {
  if (!isFinancingSelection(v)) return v;
  const value = v as Record<string, unknown>;
  return {
    accepted: value.accepted === true || value.accepted === 'true',
    ...(value.termCount !== undefined && {termCount: Number(value.termCount)}),
    ...(value.planType !== undefined && {planType: value.planType})
  };
}

const CHANNELS = ['WEB', 'MOBILE', 'POS', 'MARKETPLACE', 'PHONE', 'API'] as const;
const STATUSES = [
  'PENDING',
  'AWAITING_PAYMENT',
  'PAID',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'PARTIALLY_SHIPPED',
  'DELIVERED',
  'CANCELED',
  'RETURNED',
  'REFUNDED',
  'FAILED'
] as const;
const DEVICE_TYPES = ['desktop', 'mobile', 'smartTV', 'tablet'] as const;
const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;
const CLIENT_STRINGS = [
  'lang',
  'deviceModel',
  'browser',
  'browserVersion',
  'browserAccept',
  'os',
  'osVersion',
  'source',
  'sourceVersion',
  'colorDepth',
  'screenHeight',
  'screenWidth',
  'timezoneOffset',
  'timezoneName',
  'devicePixelRatio',
  'hardwareConcurrency',
  'deviceMemory',
  'maxTouchPoints',
  'platform',
  'languages',
  'fingerprint'
] as const;
const OPTIONAL_STRINGS = [
  'cartId',
  'externalOrderId',
  'storeId',
  'registerId',
  'statusCode',
  'statusMessage',
  'fulfillmentStatusCode',
  'fulfillmentStatusMessage',
  'carrierStatusCode',
  'carrierStatusMessage',
  'sellerId',
  'shipmentGroupId',
  'subscriptionId',
  'lastReturnId',
  'parentOrderId',
  'lastShipmentId',
  'lastInvoiceId',
  'lastCancelId',
  'paymentMethodId',
  'savedPaymentMethodId',
  'couponId',
  'marketplaceId',
  'marketplaceGroupId'
] as const;
const OPTIONAL_BOOLEANS = [
  'savePaymentMethod',
  'autoReorder',
  'financingOffered',
  'emailReceiptSent',
  'smsReceiptSent',
  'guestCheckout',
  'disputed'
] as const;
const SCHEMALESS = [
  'cartSnapshot',
  'pricingRequest',
  'pricingResponse',
  'confirmationResponse',
  'carrierWebhookResponse',
  'storeWebhookResponse',
  'fraudReviewData',
  'addressValidationData'
] as const;
const each = <K extends string, V>(keys: readonly K[], value: () => V) =>
  Object.fromEntries(keys.map((k) => [k, value()])) as Record<K, V>;

const dynamooseClientContext = () => ({
  ip: {type: [String]},
  userAgent: {type: String, validate: isSafeString},
  comment: {type: String, validate: isSafeString},
  countryCode: {type: String, validate: isCountryCode},
  deviceType: {type: String, enum: [...DEVICE_TYPES]},
  sessionId: {type: String, validate: isSessionId},
  ...each(CLIENT_STRINGS, () => String)
});
const zodClientContext = {
  ip: z.string().optional(),
  userAgent: z.string().refine(isSafeString).optional(),
  comment: z.string().refine(isSafeString).optional(),
  countryCode: z.string().refine(isCountryCode).optional(),
  deviceType: z.enum(DEVICE_TYPES).optional(),
  sessionId: z.string().refine(isSessionId).optional(),
  ...each(CLIENT_STRINGS, () => z.string().optional())
};
const stringOrNumber = () => z.union([z.string(), z.number()]).optional();

const dynamooseOrder = (d: Dynamoose) =>
  new d.Schema(
    {
      id: {type: String, hashKey: true, required: true},
      orderNumber: {
        type: String,
        required: true,
        index: {name: 'orderNumber-index', type: 'global'}
      },
      channel: {type: String, required: true, enum: [...CHANNELS]},
      warehouseId: {type: String, validate: isHexId},
      status: {type: String, required: true, enum: [...STATUSES]},
      customerId: {
        type: String,
        required: true,
        index: {name: 'externalOrderId-index', type: 'global', rangeKey: 'externalOrderId'}
      },
      relatedOrders: {type: Set, schema: [{type: String, required: true}]},
      details: {type: Object, required: true, validate: () => true},
      browserContext: {type: Object, schema: dynamooseClientContext()},
      requestContext: {
        type: Object,
        schema: {
          ...dynamooseClientContext(),
          ...each(
            [
              'apiKeyId',
              'partnerKeyId',
              'userId',
              'userEmail',
              'userName',
              'grantId',
              'clientId'
            ] as const,
            () => String
          ),
          verificationRequested: Boolean
        }
      },
      checkoutOpenedAt: Number,
      financing: {
        type: Object,
        schema: {
          planRef: String,
          offers: {
            type: Array,
            schema: [
              {
                type: Object,
                schema: {
                  ...each(
                    [
                      'fee',
                      'feeType',
                      'firstPaymentAmount',
                      'paymentAmount',
                      'termCount',
                      'apr',
                      'totalAmount',
                      'interestRate'
                    ] as const,
                    () => ({type: [String, Number]})
                  ),
                  planType: String,
                  dueDates: {type: Array, schema: [{type: String}]}
                }
              }
            ]
          },
          selection: {
            type: Object,
            schema: {
              accepted: {type: [Boolean, String], required: true},
              termCount: Number,
              planType: String
            },
            validate: isFinancingSelection,
            set: conformFinancingSelection
          },
          lenderName: String,
          lenderCode: {type: [String, Number]},
          termsText: String,
          disclosureFlag: {type: [String, Number]},
          cardInfo: String
        }
      },
      carrierTrackingId: {type: String, index: {name: 'carrierTrackingId-index', type: 'global'}},
      notification: {
        type: Object,
        schema: {
          status: {type: String, required: true, enum: [...NOTIFICATION_STATUSES]},
          statusCode: String,
          statusMessage: String
        }
      },
      reservationExpireAt: Number,
      expireAt: {type: Number, required: true},
      ...each(OPTIONAL_STRINGS, () => String),
      ...each(OPTIONAL_BOOLEANS, () => Boolean),
      ...each(SCHEMALESS, () => ({type: Object, validate: isRecord}))
    } as any,
    {
      saveUnknown: ['details.**', ...SCHEMALESS.map((k) => `${k}.**`)],
      timestamps: {
        createdAt: {createdAt: {type: date('iso')}},
        updatedAt: {updatedAt: {type: date('iso')}}
      }
    }
  );

const zodOrder = z.object({
  id: z.string(),
  orderNumber: z.string(),
  channel: z.enum(CHANNELS),
  warehouseId: z.string().refine(isHexId).optional(),
  status: z.enum(STATUSES),
  customerId: z.string(),
  relatedOrders: z.set(z.string()).optional(),
  details: z.record(z.string(), z.unknown()),
  browserContext: z.object(zodClientContext).optional(),
  requestContext: z
    .object({
      ...zodClientContext,
      ...each(
        [
          'apiKeyId',
          'partnerKeyId',
          'userId',
          'userEmail',
          'userName',
          'grantId',
          'clientId'
        ] as const,
        () => z.string().optional()
      ),
      verificationRequested: z.boolean().optional()
    })
    .optional(),
  checkoutOpenedAt: z.number().optional(),
  financing: z
    .object({
      planRef: z.string().optional(),
      offers: z
        .array(
          z.object({
            ...each(
              [
                'fee',
                'feeType',
                'firstPaymentAmount',
                'paymentAmount',
                'termCount',
                'apr',
                'totalAmount',
                'interestRate'
              ] as const,
              stringOrNumber
            ),
            planType: z.string().optional(),
            dueDates: z.array(z.string()).optional()
          })
        )
        .optional(),
      selection: z
        .object({
          accepted: z.union([z.boolean(), z.string()]),
          termCount: z.number().optional(),
          planType: z.string().optional()
        })
        .refine(isFinancingSelection)
        .transform(conformFinancingSelection)
        .optional(),
      lenderName: z.string().optional(),
      lenderCode: stringOrNumber(),
      termsText: z.string().optional(),
      disclosureFlag: stringOrNumber(),
      cardInfo: z.string().optional()
    })
    .optional(),
  carrierTrackingId: z.string().optional(),
  notification: z
    .object({
      status: z.enum(NOTIFICATION_STATUSES),
      statusCode: z.string().optional(),
      statusMessage: z.string().optional()
    })
    .optional(),
  reservationExpireAt: z.number().optional(),
  expireAt: z.number(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
  ...each(OPTIONAL_STRINGS, () => z.string().optional()),
  ...each(OPTIONAL_BOOLEANS, () => z.boolean().optional()),
  ...each(SCHEMALESS, () => z.record(z.string(), z.unknown()).optional())
});

/** A paid web order with one return. All values are invented: example.com addresses, documentation IP ranges. */
export function orderData(
  id = '0123456789abcdef0123456789abcdef01234567'
): Record<string, unknown> {
  const returnId = 'fedcba9876543210fedcba9876543210fedcba98';
  const customerId = '00000000-0000-4000-8000-000000000001';
  const externalOrderId = '100200300400';
  const customer = {name: 'Jane Tester', email: 'jane.tester@example.com', phone: '+10000000000'};
  const store = {name: 'EXAMPLE STORE', country: 'US'};
  const address = {
    line1: '1 Example Street',
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    country: 'US'
  };
  const lines = [
    {sku: 'SKU-1001', name: 'Coffee mug', quantity: 2, unitPrice: 1200, tax: 192},
    {sku: 'SKU-2002', name: 'Tea towel', quantity: 1, unitPrice: 1850, tax: 148}
  ];
  const browserContext = {
    ip: '192.0.2.10',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    countryCode: 'US',
    lang: 'en',
    deviceType: 'desktop',
    browser: 'Chrome',
    browserVersion: '129.0.0.0',
    browserAccept: 'text/html,application/xhtml+xml',
    os: 'Mac OS',
    osVersion: '10.15.7',
    colorDepth: '24',
    screenHeight: '1117',
    screenWidth: '1728',
    timezoneOffset: '300',
    timezoneName: 'America/Chicago',
    languages: 'en-US,en',
    fingerprint: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    sessionId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  };
  return {
    id,
    orderNumber: id,
    channel: 'WEB',
    cartId: browserContext.sessionId,
    externalOrderId,
    storeId: '00000000-0000-4000-8000-000000000002',
    status: 'PAID',
    statusCode: 'P000',
    statusMessage: 'Payment captured',
    fulfillmentStatusCode: '0',
    fulfillmentStatusMessage: 'Waiting for packing',
    carrierStatusCode: '00',
    carrierStatusMessage: 'Label created',
    customerId,
    sellerId: '00000000-0000-4000-8000-000000000003',
    relatedOrders: new Set([returnId]),
    lastReturnId: returnId,
    paymentMethodId: '1111111111111111111111111111111111111111',
    savePaymentMethod: false,
    autoReorder: true,
    details: {
      amount: 4250,
      amountUSD: 4250,
      currency: 'USD',
      billingAddress: {name: customer.name, email: customer.email, phone: customer.phone, address},
      shippingAddress: {name: customer.name, address},
      shippingMethod: 'standard',
      confirmationUrl: 'https://store.example.com/orders/confirmation',
      cancelUrl: 'https://store.example.com/cart',
      customer,
      description: `Order ${externalOrderId}`,
      externalOrderId,
      lines,
      discounts: [{code: 'WELCOME10', amount: 305}],
      store,
      expireAt: 1760500000,
      riskScore: 12.5,
      metadata: {cartId: 'cart-1001', campaign: 'autumn'}
    },
    browserContext,
    requestContext: {
      ip: '192.0.2.20',
      userAgent: 'ExampleClient/2.4.0',
      source: 'ExampleClient',
      sourceVersion: '2.4.0',
      countryCode: 'US',
      apiKeyId: 'key_000000'
    },
    checkoutOpenedAt: 1760400030,
    cartSnapshot: {
      lines,
      currency: 'USD',
      subtotal: 4250,
      customer,
      allowedShippingMethods: ['standard', 'express', 'pickup']
    },
    pricingRequest: {
      orderId: id,
      currency: 'USD',
      lines: lines.map((line) => ({sku: line.sku, quantity: line.quantity})),
      destination: {country: 'US', zip: '62701'},
      coupon: 'WELCOME10'
    },
    pricingResponse: {
      subtotal: 4250,
      discount: 305,
      tax: 340,
      shipping: 499,
      total: 4784,
      currency: 'USD',
      rates: {tax: '0.0800', region: 'US-IL'},
      raw: {r1: id, r2: '4784', r3: 'USD', r4: '0', r5: 'ok'}
    },
    carrierTrackingId: '22222222222222222222222222222222',
    confirmationResponse: {
      id,
      amount: 4784,
      currency: 'USD',
      externalOrderId,
      customerId,
      status: 'PAID',
      statusCode: 'P000',
      statusMessage: 'Payment captured',
      customer,
      store,
      nextAction: {type: 'COMPLETE', redirectUrl: `https://store.example.com/orders/${id}`},
      createdAt: 1760400000,
      updatedAt: 1760400060
    },
    notification: {status: 'SENT', statusCode: '200'},
    emailReceiptSent: true,
    guestCheckout: true,
    expireAt: 3299040211
  };
}

export const order: Case = {
  name: 'order',
  dynamoose: dynamooseOrder,
  lib: {
    schema: zodOrder,
    options: {
      hashKey: 'id',
      indexes: {
        orderNumber: {name: 'orderNumber-index', type: 'global'},
        customerId: {name: 'externalOrderId-index', type: 'global', rangeKey: 'externalOrderId'},
        carrierTrackingId: {name: 'carrierTrackingId-index', type: 'global'}
      },
      timestamps: true,
      defaultDateStorage: 'iso',
      unknownKeys: 'dynamoose'
    }
  },
  steps: [
    {label: 'create', create: orderData()},
    {
      label: 'create with financing and an invalid status',
      create: {...orderData('89abcdef0123456789abcdef0123456789abcdef'), status: 'LOST'}
    },
    {
      label: 'create with financing',
      create: {
        ...orderData('456789abcdef0123456789abcdef0123456789ab'),
        financing: {
          planRef: 'plan-1',
          offers: [
            {fee: '1.5', termCount: 3, dueDates: ['2026-02-01', '2026-03-01'], extra: 'dropped'}
          ],
          selection: {accepted: 'true', termCount: 3},
          lenderCode: 42
        }
      }
    }
  ],
  failing: ['create with financing and an invalid status']
};

// Queries and scans on the same stored items, read by both sides. The range key is an iso Date, so
// conditions and startAt keys on it take the stored form (dynamoose throws on a Date).
const day = (d: number) => new Date(Date.UTC(2026, 0, d));
const QUERY_STEPS = [
  'query a partition',
  'query a range',
  'query one page, descending',
  'query from a last key',
  'query every page',
  'query at most two pages',
  'query with a filter',
  'query an index',
  'query a count'
] as const;
export const queryLabels: readonly string[] = QUERY_STEPS;
const [partition, range, descending, fromLastKey, everyPage, twoPages, filter, gsi, count] =
  QUERY_STEPS;
const queryAndScan: Case = {
  name: 'query and scan',
  dynamoose: (d) =>
    new d.Schema({
      id: {type: String, hashKey: true},
      at: {type: date('iso'), rangeKey: true},
      status: {type: String, index: {name: 'status-index', type: 'global', rangeKey: 'n'}},
      n: Number
    }),
  lib: {
    schema: z.object({
      id: z.string(),
      at: z.date(),
      status: z.string().optional(),
      n: z.number().optional()
    }),
    options: {
      hashKey: 'id',
      rangeKey: 'at',
      defaultDateStorage: 'iso',
      indexes: {status: {name: 'status-index', rangeKey: 'n'}}
    }
  },
  steps: [
    {label: 'create q1', create: {id: 'q', at: day(1), status: 'open', n: 1}},
    {label: 'create q2', create: {id: 'q', at: day(2), status: 'open', n: 2}},
    {label: 'create q3', create: {id: 'q', at: day(3), status: 'done', n: 3}},
    {label: 'create r1', create: {id: 'r', at: day(1), status: 'open', n: 4}},
    {label: partition, retrieve: (m) => m.query('id').eq('q')},
    {
      label: range,
      retrieve: (m) => m.query('id').eq('q').where('at').gt('2026-01-01T12:00:00.000Z')
    },
    {label: descending, retrieve: (m) => m.query('id').eq('q').sort('descending').limit(2)},
    {
      label: fromLastKey,
      retrieve: (m) => m.query('id').eq('q').startAt({id: 'q', at: '2026-01-01T00:00:00.000Z'})
    },
    {label: everyPage, retrieve: (m) => m.query('id').eq('q').limit(1).all()},
    {label: twoPages, retrieve: (m) => m.query('id').eq('q').limit(1).all(0, 2)},
    {label: filter, retrieve: (m) => m.query('id').eq('q').where('n').ge(2)},
    {label: gsi, retrieve: (m) => m.query('status').eq('open')},
    {label: count, retrieve: (m) => m.query('id').eq('q').count()},
    {label: 'scan', retrieve: (m) => m.scan()},
    {label: 'scan with a filter', retrieve: (m) => m.scan('n').gt(1)},
    {label: 'scan every page', retrieve: (m) => m.scan().limit(1).all()},
    {label: 'scan a count', retrieve: (m) => m.scan().count()}
  ]
};

// Each side executes its own transaction and batches; only the stored items and the batch results are compared.
const n3 = {
  ConditionExpression: '#n = :n',
  ExpressionAttributeNames: {'#n': 'n'},
  ExpressionAttributeValues: {':n': {N: '3'}}
};
const transactionsAndBatches: Case = {
  name: 'transactions and batches',
  dynamoose: (d) =>
    new d.Schema(
      {
        id: {type: String, hashKey: true},
        sk: {type: Number, rangeKey: true},
        state: {type: String, default: 'new'},
        n: Number
      },
      {
        timestamps: {
          createdAt: {createdAt: {type: date('iso')}},
          updatedAt: {updatedAt: {type: date('iso')}}
        }
      }
    ),
  lib: {
    schema: z.object({
      id: z.string(),
      sk: z.number(),
      state: z.string().default('new'),
      n: z.number().optional(),
      createdAt: z.date().optional(),
      updatedAt: z.date().optional()
    }),
    options: {hashKey: 'id', rangeKey: 'sk', timestamps: true, defaultDateStorage: 'iso'}
  },
  steps: [
    {
      label: 'batchPut',
      batchPut: [
        {id: 'a', sk: 1, n: 1},
        {id: 'a', sk: 2},
        {id: 'b', sk: 1, n: 3, extra: 'dropped'}
      ]
    },
    {
      label: 'batchGet in key order',
      batchGet: [
        {id: 'b', sk: 1},
        {id: 'missing', sk: 1},
        {id: 'a', sk: 1}
      ]
    },
    {
      label: 'transaction of every entry kind',
      transaction: (m, condition) => [
        m.transaction.create({id: 'c', sk: 1, n: 7}),
        m.transaction.update({id: 'a', sk: 1}, {$ADD: {n: 5}, state: 'done'}),
        m.transaction.delete({id: 'a', sk: 2}),
        m.transaction.condition({id: 'b', sk: 1}, condition(n3))
      ]
    },
    {
      label: 'canceled transaction',
      transaction: (m) => [
        m.transaction.update({id: 'b', sk: 1}, {n: 4}),
        m.transaction.create({id: 'c', sk: 1})
      ]
    },
    {
      label: 'transaction create with overwrite',
      transaction: (m) => [m.transaction.create({id: 'c', sk: 1}, {overwrite: true})]
    },
    {
      label: 'batchDelete',
      batchDelete: [
        {id: 'b', sk: 1},
        {id: 'c', sk: 1}
      ]
    },
    {
      label: 'batchGet after the writes',
      batchGet: [
        {id: 'a', sk: 1},
        {id: 'b', sk: 1}
      ]
    }
  ],
  failing: ['canceled transaction']
};

export const corpus: Case[] = [
  flat,
  numbers,
  nested,
  setsAndBuffer,
  dates,
  defaultDates,
  dateUnion,
  transformedDates,
  combineKey,
  mixedTimestamps,
  isoTimestamps,
  hook,
  defaults,
  nestedDefault,
  nullDefaults,
  transformedList,
  records,
  hookCopy,
  keyHook,
  legacy,
  crud,
  transformedKey,
  order,
  queryAndScan,
  transactionsAndBatches,
  ...updateCorpus
];

export type {Dynamoose};
