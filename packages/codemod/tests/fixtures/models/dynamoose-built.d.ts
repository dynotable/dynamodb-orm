// A wrapper's built declarations: tsc writes `export const dynamoose = $dynamoose` as the object's type.
export declare const dynamoose: {
  Condition: typeof import('@acme/dynamoose/dist/Condition').Condition;
  Schema: typeof import('@acme/dynamoose/dist/Schema').Schema;
  transaction: typeof import('@acme/dynamoose/dist/Transaction').default;
};
export declare const nowIso: () => string;
