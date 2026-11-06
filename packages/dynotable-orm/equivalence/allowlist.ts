import {queryLabels} from './corpus.js';
import type {Check} from './harness.js';

/**
 * A known difference from dynamoose 4.2.0 on one check of one step. Each entry must really differ (a stale
 * entry fails). `reason` starts with the number of the difference in the migration guide's "Allowlisted
 * differences"; `ref` names the guide section that describes the behaviour.
 */
export interface AllowlistEntry {
  case: string;
  step: string;
  check: Check;
  reason: string;
  ref: string;
}

type Difference = Pick<AllowlistEntry, 'reason' | 'ref'>;
const guide = (section: string) => `migration guide › ${section}`;

const D2: Difference = {
  reason:
    'D2: create() and save() resolve to the item with Date objects. dynamoose 4.2.0 resolves to the stored form (an ISO string or an epoch number). The stored items are equal.',
  ref: guide('Tests that change')
};
const D3: Difference = {
  reason:
    'D3: a nested $SET, $ADD or $DELETE of `a.b` writes b inside a. dynamoose 4.2.0 writes a top-level attribute named "a.b" and leaves a as it was. On read, dynamoose keeps that attribute and this lib drops it (D12).',
  ref: guide('Updates')
};
const D4: Difference = {
  reason:
    'D4: a nested $REMOVE (also a nested path or a list element set to undefined) removes the nested value. dynamoose 4.2.0 removes a top-level attribute named by the path, so nothing is removed.',
  ref: guide('Updates')
};
const D5: Difference = {
  reason:
    'D5: a Date in a nested update is stored with the storage of its path. dynamoose 4.2.0 rejects the update ("Unsupported type passed", or a TypeError).',
  ref: guide('Updates')
};
const D6: Difference = {
  reason:
    'D6: an update of a key inside a list element or inside a schemaless object is written. dynamoose 4.2.0 throws a TypeError.',
  ref: guide('Updates')
};
const D7: Difference = {
  reason:
    'D7: this lib refuses a nested value that fails its own checks (enum, validate, type), a nested write under a parent or a record with its own check or transform, and a __proto__ or constructor segment. dynamoose 4.2.0 runs none of these checks and writes the path as a top-level attribute (D3).',
  ref: guide('Updates')
};
const D8: Difference = {
  reason:
    'D8: an undeclared nested key is dropped, and an update with nothing left throws "Nothing to update". dynamoose 4.2.0 writes the key as a top-level attribute named by the path.',
  ref: guide('Updates')
};
const D9: Difference = {
  reason:
    'D9: an update that writes no combine source keeps the combine attribute as stored. dynamoose 4.2.0 refuses it ("You must update all or none of the combine attributes"), even when it writes no source.',
  ref: guide('Updates')
};
const D10: Difference = {
  reason:
    'D10: a $REMOVE of a Set attribute and a $SET of a list in one update store the list as a list (L). dynamoose 4.2.0 stores it as a string set (SS), and then cannot read it.',
  ref: guide('Updates')
};
const D11: Difference = {
  reason:
    'D11: a stored value whose type does not match the schema (a number on an ISO Date path, a list on a Set path) is read as stored. dynamoose 4.2.0 rejects the read (TypeMismatch).',
  ref: guide('The Date storage trap')
};
const D13: Difference = {
  reason:
    "D13: queriedCount is DynamoDB's ScannedCount. dynamoose 4.2.0 reads a QueriedCount field that DynamoDB never returns, so its queriedCount is always undefined.",
  ref: guide('Queries and scans')
};
const D14: Difference = {
  reason:
    "D14: this lib ignores the caller's updatedAt and writes its own stamp. dynamoose 4.2.0 sets updatedAt and then the caller's updatedAt too, so DynamoDB rejects the update (two document paths overlap).",
  ref: guide('Timestamps')
};
const D15: Difference = {
  reason:
    "D15: an append stores the element as given, so the stored items are equal. This lib reads the list by the transform's output schema, which renames the key, and drops the stored key; dynamoose 4.2.0 reads by the declared schema.",
  ref: guide('Updates')
};

// A step after one that differs: the whole tables are compared, so what the earlier step wrote still differs.
export const later = (d: Difference): Difference => ({
  ...d,
  reason: `${d.reason} Here the difference is what an earlier step of the case wrote.`
});

const WRITE = ['write'] as const;
const STORED = ['stored'] as const;
const NESTED = ['write', 'stored', 'strictRead'] as const;
const EVERY = ['write', 'stored', 'read', 'strictRead'] as const;
const REFUSED = ['write', 'stored', 'read'] as const;

/** The entries of one difference: the checks that differ, by step, of one case. */
export const differs = (
  d: Difference,
  name: string,
  steps: Record<string, readonly Check[]>
): AllowlistEntry[] =>
  Object.entries(steps).flatMap(([step, checks]) =>
    checks.map((check) => ({case: name, step, check, ...d}))
  );

export const differences = {D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D13, D14, D15};

export const allowlist: AllowlistEntry[] = [
  ...differs(D2, 'dates', {create: WRITE}),
  ...differs(D2, 'dates with no storage setting', {create: WRITE}),
  ...differs(D2, 'date union', {'create from a Date': WRITE}),
  ...differs(D2, 'transformed dates in a list', {create: WRITE}),
  ...differs(D2, 'mixed timestamps', {create: WRITE, 'create with createdAt in the input': WRITE}),
  ...differs(D2, 'iso timestamps', {'create with createdAt in the input': WRITE}),
  ...differs(D2, 'transformed list', {create: WRITE}),
  ...differs(D2, 'crud', {
    create: WRITE,
    'create with overwrite': WRITE,
    'save keeps createdAt': WRITE
  }),
  ...differs(D2, 'order', {create: WRITE, 'create with financing': WRITE}),
  ...differs(D2, 'query and scan', {
    'create q1': WRITE,
    'create q2': WRITE,
    'create q3': WRITE,
    'create r1': WRITE
  }),
  ...differs(D11, 'legacy items', {'N on an iso path': ['read'], 'L on a Set path': ['read']}),
  ...queryLabels.flatMap((step) => differs(D13, 'query and scan', {[step]: ['scannedCount']})),

  ...differs(D3, 'update: nested set keeps siblings', {
    'writes one nested key and keeps its siblings': EVERY
  }),
  ...differs(D3, 'update: nested transform', {'applies a nested set modifier': EVERY}),
  ...differs(D3, 'update: nested key under saveUnknown', {
    'writes a nested key that saveUnknown covers as it is': EVERY
  }),
  ...differs(D3, 'update: nested sets and numbers', {
    'adds an array to a nested string set': EVERY,
    'deletes an array from a nested string set': NESTED,
    'adds to a nested number': EVERY
  }),
  ...differs(D3, 'update: hook on a nested path', {'the hook on a nested $SET path': EVERY}),
  ...differs(D3, 'update: nested truthy default', {
    'a nested truthy default on $REMOVE goes through the check and the hook': EVERY
  }),
  ...differs(D3, 'update: schema-level validate', {
    'a schema-level validate once per nested path': EVERY
  }),
  ...differs(D3, 'update: multi-type parent', {'sibling paths of different definitions': EVERY}),
  ...differs(later(D3), 'update: multi-type parent', {
    'a nested value no definition accepts': STORED
  }),

  ...differs(D4, 'update: nested remove under a required parent', {
    'removes a nested key under a required parent and keeps its siblings': NESTED
  }),
  ...differs(D4, 'update: nested remove under a parent with a default', {
    'removes a nested key under a parent with a default, without writing the default': NESTED
  }),
  ...differs(D4, 'update: list element in a required list', {
    'removes a list element in a required list': NESTED
  }),
  ...differs(D4, 'update: nested path set to undefined', {
    'removes a nested path set to undefined': NESTED
  }),
  ...differs(D4, 'update: multi-type parent', {
    'a nested $REMOVE under a multi-type parent with no rule': NESTED
  }),

  ...differs(D5, 'update: nested Date in seconds', {
    'stores a nested Date with its storage setting and reads it back as a Date': NESTED
  }),
  ...differs(D5, 'update: Date inside a list element', {
    'stores a Date inside a list element': NESTED
  }),
  ...differs(D5, 'update: top-level, nested set and nested remove with timestamps', {
    'applies a top-level value, a nested $SET and a nested $REMOVE in one update, with timestamps':
      NESTED
  }),
  ...differs(D5, 'update: nested values', {
    'many nested paths of one update, each with its own value': NESTED
  }),

  ...differs(D6, 'update: key inside a list element', {
    'removes a key inside a list element': NESTED
  }),
  ...differs(D6, 'update: schemaless object drops nested keys', {
    'skips a nested key inside a schemaless Object and writes the rest': NESTED
  }),
  ...differs(D6, 'update: nested values', {
    'each element of nested paths into different list elements': NESTED
  }),

  ...differs(D7, 'update: nested value checks', {
    'refuses a nested value outside the enum': REFUSED,
    'refuses a nested value that fails validation': REFUSED
  }),
  ...differs(later(D7), 'update: nested value checks', {
    'refuses a nested value of the wrong type': STORED
  }),
  ...differs(D7, 'update: parent with a rule', {
    'a nested $SET under a parent with declared children and its own validate': REFUSED,
    'a nested $REMOVE under a parent with declared children and its own validate': WRITE,
    'a nested $SET to undefined under a parent with its own validate': WRITE,
    'a nested $SET under a parent with its own set modifier': REFUSED
  }),
  ...differs(D7, 'update: record entries', {
    "a record's validate on a nested $SET entry": REFUSED,
    "a schemaless parent's validate once per nested entry": REFUSED
  }),
  ...differs(D7, 'update: nested values', {
    "the validate of the written nested object's own keys": REFUSED
  }),
  ...differs(D7, 'update: prototype paths', {
    'a nested path through __proto__': REFUSED,
    'a nested path through constructor': REFUSED
  }),

  ...differs(D8, 'update: undeclared nested keys', {
    'skips a nested key the schema does not declare and writes the rest': EVERY
  }),
  ...differs(later(D8), 'update: undeclared nested keys', {
    'throws before sending when every key of the update is a nested key the schema drops': STORED
  }),
  ...differs(D8, 'update: nested keys dropped with timestamps', {
    'every requested key is a nested key the schema drops, even with timestamps': REFUSED
  }),

  ...differs(D9, 'update: combine', {
    'leaves the combine attribute as it is when no source is written': NESTED
  }),
  ...differs(later(D9), 'update: combine', {
    'recomputes the combine attribute when all sources are written': NESTED,
    'refuses an update of some sources only': STORED,
    'recomputes from a removed source': NESTED
  }),
  ...differs(D9, 'update: combine as hash key', {
    'updates a model whose hash key is a combine attribute': NESTED
  }),
  ...differs(later(D9), 'update: combine as hash key', {
    'refuses a $SET of a key source': STORED,
    'refuses a $REMOVE of a key source': STORED,
    'refuses an $ADD to a key source': STORED,
    'refuses a $DELETE from a key source': STORED
  }),

  ...differs(D10, 'update: list stored as a list', {
    'stores a list as a list when a set attribute is removed in the same update': EVERY
  }),
  ...differs(D14, 'update: an item read and written back with its updatedAt', {
    'writes the read item back with a change': ['write', 'stored', 'strictRead']
  }),
  ...differs(D15, 'update: $ADD an element a transform renames', {
    'appends an element in seconds': ['write', 'read']
  }),
  ...differs(D15, 'update: $ADD to a list a transform renames', {
    "appends an element of the list's input": ['write', 'read']
  })
];
