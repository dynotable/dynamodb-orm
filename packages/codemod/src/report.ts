import type {ImportDeclaration, Node, SourceFile} from 'ts-morph';

export interface SdkImport {
  file: string;
  line: number;
  module: string;
  name: string;
  /** The dynotable-orm API that covers the usual reason for this direct SDK use. */
  replacement?: string;
}

export const SDK_MODULE = /^@aws-sdk\/(client|lib|util)-dynamodb$/;

/** The known reasons services bypass dynamoose, by the SDK name they import. */
const REPLACEMENTS: Record<string, string> = {
  DynamoDB: 'setClient(client), or the per-call {client, abortSignal} options',
  DynamoDBClient: 'setClient(client), or the per-call {client, abortSignal} options',
  DynamoDBDocumentClient: 'setClient(client), or the per-call {client, abortSignal} options',
  GetItemCommand:
    'M.get(key, {raw: true}) for stored values, {rawKey: true} for a legacy key, {consistent: true}',
  GetCommand:
    'M.get(key, {raw: true}) for stored values, {rawKey: true} for a legacy key, {consistent: true}',
  PutItemCommand:
    'M.create(item, {overwrite, condition}), or {return: "request"} for the raw input',
  PutCommand: 'M.create(item, {overwrite, condition}), or {return: "request"} for the raw input',
  UpdateItemCommand:
    'M.update(key, changes, {condition, rawKey, return: "request"}) with ifNotExists(v), attributeNotExists() and list or map equality',
  UpdateCommand:
    'M.update(key, changes, {condition, rawKey, return: "request"}) with ifNotExists(v), attributeNotExists() and list or map equality',
  DeleteItemCommand: 'M.delete(key, {condition, rawKey: true})',
  DeleteCommand: 'M.delete(key, {condition, rawKey: true})',
  QueryCommand: 'M.query(...)',
  ScanCommand: 'M.scan(...), with parallel(n)',
  BatchGetItemCommand: 'M.batchGet(keys)',
  BatchGetCommand: 'M.batchGet(keys)',
  BatchWriteItemCommand: 'M.batchPut(items) or M.batchDelete(keys)',
  BatchWriteCommand: 'M.batchPut(items) or M.batchDelete(keys)',
  TransactWriteItemsCommand: 'transaction([...M.transaction.*, raw TransactItems])',
  TransactWriteCommand: 'transaction([...M.transaction.*, raw TransactItems])',
  TransactionCanceledException:
    'transaction(): the error keeps CancellationReasons and adds reasons',
  ConditionalCheckFailedException: 'isConditionalCheckFailed(e)',
  marshall: 'converter.marshall',
  unmarshall: 'converter.unmarshall',
  convertToAttr: 'converter.convertToAttr'
};

/** Value imports from the DynamoDB SDK packages, each with its dynotable-orm replacement when one is known. */
export function sdkImports(
  file: SourceFile,
  drops: ReadonlyMap<ImportDeclaration, ReadonlySet<Node>>
): SdkImport[] {
  const found: SdkImport[] = [];
  for (const decl of file.getImportDeclarations()) {
    const module = decl.getModuleSpecifierValue();
    if (!SDK_MODULE.test(module) || decl.isTypeOnly()) continue;
    for (const spec of decl.getNamedImports()) {
      if (spec.isTypeOnly() || drops.get(decl)?.has(spec)) continue;
      const name = spec.getName();
      found.push({
        file: file.getFilePath(),
        line: spec.getStartLineNumber(),
        module,
        name,
        replacement: REPLACEMENTS[name]
      });
    }
  }
  return found;
}
