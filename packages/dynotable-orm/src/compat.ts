import {convertToAttr, marshall, unmarshall} from '@aws-sdk/util-dynamodb';

/** dynamoose's `item.toJSON()`: a JSON round trip, so a Date becomes its ISO string and a Set an empty object. */
export function toJSON(x: readonly object[]): Record<string, any>[];
export function toJSON(x: object): Record<string, any>;
export function toJSON(x: object): unknown {
  return JSON.parse(JSON.stringify(Array.isArray(x) ? [...x] : {...x}));
}

/** The `@aws-sdk/util-dynamodb` functions that dynamoose's `aws.converter()` returns, with their options. */
export const converter = {marshall, unmarshall, convertToAttr};
