import {expect, it, vi} from 'vitest';
import {Automocked} from './fixtures/automocked-model.js';

vi.mock('./fixtures/automocked-model.js');

// A test that automocks a model module and snapshots `new M(x)` pinned what an automocked dynamoose item printed:
// its mocked toJSON returns undefined.
it('an automocked model makes instances that print as automocked dynamoose items', () => {
  expect(new Automocked({id: 'a'})).toMatchInlineSnapshot(`undefined`);
});
