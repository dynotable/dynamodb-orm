import {
  type CallExpression,
  type Expression,
  type NewExpression,
  Node,
  type ObjectLiteralExpression,
  SyntaxKind,
  type Type,
  ts
} from 'ts-morph';
import {type Context, isConstDeclaration} from './context.js';
import {
  dynamooseMembers,
  IMPORTED_TYPES,
  isZodNamespace,
  localName,
  type Member,
  refsInFile,
  tableSettings,
  takenMessage,
  zodModule
} from './imports.js';
import {removeUnusedTypes} from './model.js';

/** Text to write, with nodes rendered at render time, so the edits inside them apply. */
type Piece = string | Node;

const STORAGES = new Set(['iso', 'milliseconds', 'seconds']);
const MODIFIERS = new Set(['get', 'set']);
const INDEX_SETTINGS = new Set(['name', 'type', 'rangeKey', 'project']);
const SCALARS: Record<string, string> = {
  String: 'z.string()',
  Number: 'z.number()',
  Boolean: 'z.boolean()',
  Buffer: 'z.instanceof(Buffer)'
};
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

interface Place {
  path: string[];
  /** Indentation level of the object the attribute is a field of. */
  depth: number;
  /** A top-level attribute: it can be a key, an index or a combine target. */
  top: boolean;
  /** An array element or a type option: it has no `required` or `default` of its own. */
  element: boolean;
  /** `options.dates` can name the attribute's path. */
  addressable: boolean;
}

interface Timestamp {
  kind: 'createdAt' | 'updatedAt';
  name: string;
  date: boolean;
  storage: string;
}

const join = (parts: Piece[][], separator: string): Piece[] =>
  parts.flatMap((p, i) => (i === 0 ? p : [separator, ...p]));
const prop = (node: ObjectLiteralExpression, name: string) => {
  const p = node.getProperty(name);
  return Node.isPropertyAssignment(p) ? p.getInitializerOrThrow() : undefined;
};
// dynamoose awaits its set hook; dynotable-orm would marshal the Promise as the item.
const returnsPromise = (fn: Node): boolean =>
  fn
    .getType()
    .getCallSignatures()
    .some((s) => {
      const t = s.getReturnType();
      return (t.isUnion() ? t.getUnionTypes() : [t]).some(
        (u) => u.getProperty('then') !== undefined
      );
    });
const isDate = (t: Type) => t.getText() === 'Date';
// A Date value, or a function whose every call gives one.
const givesDate = (n: Node): boolean => {
  const signatures = n.getType().getCallSignatures();
  return signatures.length > 0
    ? signatures.every((s) => isDate(s.getReturnType()))
    : isDate(n.getType());
};
const literalName = (p: Node) => {
  const name = Node.isPropertyAssignment(p) ? p.getNameNode() : undefined;
  if (Node.isIdentifier(name)) return name.getText();
  return Node.isStringLiteral(name) || Node.isNumericLiteral(name)
    ? name.getLiteralText()
    : undefined;
};
const isCallable = (n: Node) =>
  Node.isArrowFunction(n) ||
  Node.isFunctionExpression(n) ||
  n.getType().getCallSignatures().length > 0;
const isNumber = (n: Node) =>
  Node.isNumericLiteral(n) ||
  (Node.isPrefixUnaryExpression(n) &&
    n.getOperatorToken() === SyntaxKind.MinusToken &&
    Node.isNumericLiteral(n.getOperand()));
/**
 * `E` of `Object.values(E)`, where `E` is an enum whose members all have a string literal value: its values are
 * the members' values, as `z.enum(E)` checks. A numeric enum's `Object.values` also holds the member names.
 */
function stringEnumOf(n: Node): Node | undefined {
  if (!Node.isCallExpression(n) || n.getArguments().length !== 1) return undefined;
  const callee = n.getExpression();
  if (
    !Node.isPropertyAccessExpression(callee) ||
    callee.getName() !== 'values' ||
    !isGlobal(callee.getExpression(), 'Object')
  )
    return undefined;
  const arg = n.getArguments()[0]!;
  const symbol = arg.getSymbol();
  const decl = (symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol)?.getValueDeclaration();
  if (!Node.isEnumDeclaration(decl) || decl.isConstEnum()) return undefined;
  const members = decl.getMembers();
  return members.length > 0 && members.every((m) => Node.isStringLiteral(m.getInitializer()))
    ? arg
    : undefined;
}
/** A built-in global (`String`, `Date`, `Buffer`…), not a binding of the file with the same name. */
const isGlobal = (n: Node, name: string) =>
  Node.isIdentifier(n) &&
  n.getText() === name &&
  !!n
    .getSymbol()
    ?.getDeclarations()
    .every((d) => d.getSourceFile().isDeclarationFile());

/** One dynamoose `Schema` definition read into a Zod object and model options. */
class SchemaReader {
  readonly problems: string[] = [];
  /** dynamoose members the conversion consumed (`type.COMBINE`). */
  readonly members: Member[] = [];
  private readonly entries: Piece[][] = [];
  private readonly indexes: Piece[][] = [];
  private readonly combine: Piece[][] = [];
  private readonly dates: Piece[][] = [];
  private openAll = false;
  private readonly openPaths: string[][] = [];
  private readonly opened = new Set<string>();
  private hash: string | undefined;
  private range: string | undefined;
  readonly zod: Piece[] = [];
  /** The options hold the whole-item hook, a function the options variable must type. */
  hasSet = false;

  constructor(
    private readonly lookup: Map<ts.Node, Member>,
    private readonly q: string,
    private readonly indent: string,
    definition: Node | undefined,
    settings: Node | undefined
  ) {
    if (!Node.isObjectLiteralExpression(definition)) {
      this.problems.push('the definition is not an object literal');
      return;
    }
    if (settings !== undefined && !Node.isObjectLiteralExpression(settings)) {
      this.problems.push('the settings are not an object literal');
      return;
    }
    const timestamps = settings ? this.settings(settings) : [];
    this.keys(definition);
    this.zod.push(
      ...this.object(
        definition,
        {path: [], depth: 0, top: true, element: false, addressable: true},
        timestamps
      )
    );
    for (const p of this.openPaths) {
      if (!this.opened.has(p.join('.')))
        this.problems.push(`saveUnknown '${p.join('.')}.**' does not name an Object attribute`);
    }
    if (this.hash !== undefined) this.entries.push([`hashKey: ${this.str(this.hash)}`]);
    if (this.range !== undefined) this.entries.push([`rangeKey: ${this.str(this.range)}`]);
    const record = (name: string, list: Piece[][]) =>
      list.length > 0 && this.entries.push([`${name}: {`, ...join(list, ', '), '}']);
    record('indexes', this.indexes);
    record('combine', this.combine);
    record('dates', this.dates);
    if (timestamps.length > 0)
      this.entries.push(['timestamps: ', this.timestampOption(timestamps)]);
    const set = settings && prop(settings, 'set');
    if (set) this.entries.push(['set: ', set]);
    this.hasSet = !!set;
  }

  /** The options object, with `extra` properties appended. */
  options(extra: Piece[][] = []): Piece[] {
    return ['{', ...join([...this.entries, ...extra], ', '), '}'];
  }

  private key(name: string): string {
    return IDENTIFIER.test(name) ? name : this.str(name);
  }

  /** A string literal of `s` in the file's quote: an attribute name may hold a quote or a backslash. */
  private str(s: string): string {
    const json = JSON.stringify(s);
    if (this.q === '"') return json;
    return `'${json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
  }

  private consume(node: Node): void {
    this.members.push(this.lookup.get(node.compilerNode)!);
  }

  /** The hash key is the attribute marked `hashKey`, else the first one (dynamoose's default). */
  private keys(definition: ObjectLiteralExpression): void {
    const marked = (flag: string) =>
      definition.getProperties().find((p) => {
        const value = Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
        return (
          Node.isObjectLiteralExpression(value) &&
          prop(value, flag)?.getKind() === SyntaxKind.TrueKeyword
        );
      });
    const hash = marked('hashKey') ?? definition.getProperties()[0];
    this.hash = hash && literalName(hash);
    const range = marked('rangeKey');
    this.range = range && literalName(range);
  }

  private settings(settings: ObjectLiteralExpression): Timestamp[] {
    let timestamps: Timestamp[] = [];
    for (const p of settings.getProperties()) {
      const name = literalName(p);
      const value = Node.isPropertyAssignment(p) ? p.getInitializerOrThrow() : undefined;
      if (name === 'timestamps' && value) timestamps = this.timestamps(value);
      else if (name === 'saveUnknown' && value) this.saveUnknown(value);
      else if (name === 'set' && value && returnsPromise(value))
        this.problems.push(
          'the schema setting set returns a Promise: the dynotable-orm set hook is synchronous'
        );
      else if (name !== 'set')
        this.problems.push(
          `the schema setting ${name ?? p.getText()} has no dynotable-orm equivalent`
        );
    }
    return timestamps;
  }

  private saveUnknown(value: Node): void {
    if (value.getKind() === SyntaxKind.TrueKeyword) this.openAll = true;
    else if (value.getKind() === SyntaxKind.FalseKeyword) return;
    else if (Node.isArrayLiteralExpression(value)) {
      for (const e of value.getElements()) {
        const glob = Node.isStringLiteral(e) ? e.getLiteralValue() : undefined;
        if (glob === '**') this.openAll = true;
        else if (glob?.endsWith('.**') && !glob.slice(0, -3).includes('*'))
          this.openPaths.push(glob.slice(0, -3).split('.'));
        else
          this.problems.push(
            `saveUnknown ${e.getText()}: only '**' and '<Object attribute>.**' convert`
          );
      }
    } else this.problems.push('saveUnknown is not a literal');
  }

  private timestamps(value: Node): Timestamp[] {
    const defaults = (kind: Timestamp['kind']): Timestamp => ({
      kind,
      name: kind,
      date: true,
      storage: 'milliseconds'
    });
    if (value.getKind() === SyntaxKind.TrueKeyword)
      return [defaults('createdAt'), defaults('updatedAt')];
    if (value.getKind() === SyntaxKind.FalseKeyword) return [];
    if (!Node.isObjectLiteralExpression(value)) {
      this.problems.push('timestamps is not a literal');
      return [];
    }
    const out: Timestamp[] = [];
    for (const p of value.getProperties()) {
      const kind = literalName(p);
      const v = Node.isPropertyAssignment(p) ? p.getInitializerOrThrow() : undefined;
      if ((kind !== 'createdAt' && kind !== 'updatedAt') || !v) {
        this.problems.push(`timestamps.${kind ?? p.getText()} has no dynotable-orm equivalent`);
      } else if (Node.isStringLiteral(v)) {
        out.push({...defaults(kind), name: v.getLiteralValue()});
      } else if (
        Node.isObjectLiteralExpression(v) &&
        v.getProperties().length === 1 &&
        literalName(v.getProperties()[0])
      ) {
        const [field] = v.getProperties();
        const type = this.timestampType(
          (field as Node & {getInitializerOrThrow(): Node}).getInitializerOrThrow()
        );
        if (type) out.push({kind, name: literalName(field)!, ...type});
        else this.problems.push(`timestamps.${kind}: only a Date or Number attribute converts`);
      } else if (v.getKind() !== SyntaxKind.NullKeyword) {
        this.problems.push(
          `timestamps.${kind}: only a name, null or {name: Date | Number} converts`
        );
      }
    }
    return out;
  }

  private timestampType(value: Node): {date: boolean; storage: string} | undefined {
    const type =
      Node.isObjectLiteralExpression(value) && value.getProperties().length === 1
        ? prop(value, 'type')
        : value;
    if (!type) return undefined;
    if (isGlobal(type, 'Number')) return {date: false, storage: 'milliseconds'};
    const storage = this.dateStorage(type);
    return storage ? {date: true, storage} : undefined;
  }

  private timestampOption(list: Timestamp[]): string {
    const plain =
      list.length === 2 &&
      list.every((t) => t.name === t.kind && t.date && t.storage === 'milliseconds');
    if (plain) return 'true';
    const one = (t: Timestamp) => {
      const parts = [
        ...(t.name === t.kind ? [] : [`name: ${this.str(t.name)}`]),
        ...(t.date && t.storage !== 'milliseconds' ? [`storage: ${this.str(t.storage)}`] : [])
      ];
      return `${t.kind}: {${parts.join(', ')}}`;
    };
    return `{${list.map(one).join(', ')}}`;
  }

  /** `Date` or `{value: Date, settings: {storage}}`: its storage, else `undefined`. */
  private dateStorage(type: Node): string | undefined {
    if (isGlobal(type, 'Date')) return 'milliseconds';
    if (!Node.isObjectLiteralExpression(type)) return undefined;
    const value = prop(type, 'value');
    const settings = prop(type, 'settings');
    const storage =
      Node.isObjectLiteralExpression(settings) && settings.getProperties().length === 1
        ? prop(settings, 'storage')
        : undefined;
    const ok =
      value &&
      isGlobal(value, 'Date') &&
      type.getProperties().length === (settings ? 2 : 1) &&
      (!settings || Node.isStringLiteral(storage));
    if (!ok) return undefined;
    const mode =
      storage && Node.isStringLiteral(storage) ? storage.getLiteralValue() : 'milliseconds';
    return STORAGES.has(mode) ? mode : undefined;
  }

  private open(path: string[]): boolean {
    const hit = this.openPaths.filter(
      (p) => p.length <= path.length && p.every((s, i) => s === path[i])
    );
    for (const p of hit) if (p.length === path.length) this.opened.add(p.join('.'));
    return this.openAll || hit.length > 0;
  }

  private object(
    definition: ObjectLiteralExpression,
    place: Place,
    timestamps: Timestamp[] = []
  ): Piece[] {
    const fields: Piece[][] = [];
    const names = new Set<string>();
    for (const p of definition.getProperties()) {
      const name = literalName(p);
      if (name === undefined || !Node.isPropertyAssignment(p)) {
        this.problems.push(`'${[...place.path, p.getText()].join('.')}' is not a plain attribute`);
        continue;
      }
      names.add(name);
      const field = this.attribute(p.getInitializerOrThrow(), {
        path: [...place.path, name],
        depth: place.depth + 1,
        top: place.top,
        element: false,
        addressable: place.addressable
      });
      if (field) fields.push([p.getNameNode(), ': ', ...field]);
    }
    for (const t of timestamps) {
      if (names.has(t.name))
        this.problems.push(`the timestamp '${t.name}' is also declared in the schema`);
      else fields.push([`${this.key(t.name)}: ${t.date ? 'z.date()' : 'z.number()'}.optional()`]);
    }
    const factory = this.open(place.path) ? 'z.looseObject' : 'z.object';
    if (fields.length === 0) return [`${factory}({})`];
    const inner = `\n${this.indent}${'  '.repeat(place.depth + 1)}`;
    return [
      `${factory}({`,
      inner,
      ...join(fields, `,${inner}`),
      `\n${this.indent}${'  '.repeat(place.depth)}})`
    ];
  }

  /** The Zod schema of one attribute definition, or `undefined` after a problem. */
  private attribute(value: Node, place: Place): Piece[] | undefined {
    const at = `'${place.path.join('.')}'`;
    const settings =
      Node.isObjectLiteralExpression(value) && value.getProperty('type') ? value : undefined;
    const props = new Map<string, Expression>();
    if (settings) {
      for (const p of settings.getProperties()) {
        const name = literalName(p);
        if (name === undefined || !Node.isPropertyAssignment(p)) {
          this.problems.push(`${at}: ${p.getText()} is not a plain setting`);
          return undefined;
        }
        props.set(name, p.getInitializerOrThrow());
      }
    } else props.set('type', value as Expression);

    const allowed = place.element
      ? ['type', 'schema', 'enum', 'validate']
      : ['type', 'schema', 'enum', 'validate', 'required', 'default'];
    if (place.top) allowed.push('hashKey', 'rangeKey', 'index');
    for (const name of props.keys()) {
      if (allowed.includes(name)) continue;
      this.problems.push(
        MODIFIERS.has(name)
          ? `${at} has a ${name} modifier, which has no dynotable-orm equivalent`
          : `${at}: the ${name} setting does not convert here`
      );
    }
    for (const flag of ['hashKey', 'rangeKey']) {
      const v = props.get(flag);
      if (v && v.getKind() !== SyntaxKind.TrueKeyword && v.getKind() !== SyntaxKind.FalseKeyword)
        this.problems.push(`${at}: ${flag} is not a literal`);
    }
    const index = props.get('index');
    if (index && place.top) this.index(index, place.path[0]);

    const base = this.type(props.get('type')!, props.get('schema'), place);
    if (!base) return undefined;
    let [zod, kind] = base;

    const values = props.get('enum');
    if (values) {
      const elements = Node.isArrayLiteralExpression(values) ? values.getElements() : [];
      const stringEnum = kind === 'string' ? stringEnumOf(values) : undefined;
      if (kind === 'string' && elements.length > 0 && elements.every(Node.isStringLiteral))
        zod = ['z.enum(', values, ')'];
      else if (kind === 'number' && elements.length > 0 && elements.every(isNumber))
        zod = ['z.literal(', values, ')'];
      else if (stringEnum) zod = ['z.enum(', stringEnum, ')'];
      else
        this.problems.push(
          `${at}: only an enum of string or number literals, or Object.values() of a string enum, converts`
        );
    }
    const validate = props.get('validate');
    if (validate && Node.isRegularExpressionLiteral(validate) && kind === 'string')
      zod = [...zod, '.regex(', validate, ')'];
    // dynamoose validates a Date in its stored form, a number or a string; a Zod refinement gets the Date.
    else if (validate && isCallable(validate) && kind === 'date')
      this.problems.push(
        `${at}: validate on a Date gets the stored number or string in dynamoose, and a Date in a refinement: convert it by hand`
      );
    else if (validate && isCallable(validate)) zod = [...zod, '.refine(', validate, ')'];
    else if (validate)
      this.problems.push(`${at}: validate converts only from a function, or a RegExp on a string`);

    if (place.element) return zod;
    const fallback = props.get('default');
    if (fallback && returnsPromise(fallback)) {
      this.problems.push(
        `${at}: the default returns a Promise, which dynamoose awaits: a Zod default is synchronous`
      );
      return undefined;
    }
    // dynamoose stores a Date attribute's default as it is, a number too; a z.date() default must give a Date.
    if (fallback && kind === 'date' && !givesDate(fallback)) {
      this.problems.push(
        `${at}: the default of a Date gives no Date, and dynamoose stores what it gives: convert it by hand`
      );
      return undefined;
    }
    const required = props.get('required');
    if (
      required &&
      required.getKind() !== SyntaxKind.TrueKeyword &&
      required.getKind() !== SyntaxKind.FalseKeyword
    ) {
      this.problems.push(`${at}: required is not a literal`);
      return undefined;
    }
    // A Zod default lets an update remove the field, or $SET it to undefined; dynamoose's required check refuses the
    // $SET, and a $REMOVE when the default is falsy.
    if (fallback && required?.getKind() === SyntaxKind.TrueKeyword) {
      this.problems.push(
        `${at}: required with a default: dynamoose refuses an update that sets it to undefined, or that removes it when the default is falsy (it writes a truthy default), and a Zod default allows both: convert it by hand`
      );
      return undefined;
    }
    if (fallback) return [...zod, '.default(', fallback, ')'];
    const isKey = place.top && (place.path[0] === this.hash || place.path[0] === this.range);
    return required?.getKind() === SyntaxKind.TrueKeyword || isKey ? zod : [...zod, '.optional()'];
  }

  private index(value: Expression, field: string): void {
    const one = (def: Node): Piece[] | undefined => {
      if (def.getKind() === SyntaxKind.TrueKeyword) return ['{}'];
      if (!Node.isObjectLiteralExpression(def)) return undefined;
      const kept: Piece[][] = [];
      for (const p of def.getProperties()) {
        const name = literalName(p);
        // A table's throughput is set where it is created, which this lib does not do.
        if (name === 'throughput') continue;
        if (name === undefined || !INDEX_SETTINGS.has(name)) return undefined;
        kept.push([p]);
      }
      return ['{', ...join(kept, ', '), '}'];
    };
    if (value.getKind() === SyntaxKind.FalseKeyword) return;
    const defs = Node.isArrayLiteralExpression(value) ? value.getElements().map(one) : [one(value)];
    if (defs.some((d) => d === undefined)) {
      this.problems.push(
        `'${field}': only an index of true, or of {name, type, rangeKey, project}, converts`
      );
      return;
    }
    const list = defs as Piece[][];
    this.indexes.push([
      `${this.key(field)}: `,
      ...(Node.isArrayLiteralExpression(value) ? ['[', ...join(list, ', '), ']'] : list[0])
    ]);
  }

  /** The base Zod schema of a type, and its kind. */
  private type(type: Node, schema: Node | undefined, place: Place): [Piece[], string] | undefined {
    const at = `'${place.path.join('.')}'`;
    const noSchema = (zod: string, kind: string): [Piece[], string] | undefined => {
      if (schema === undefined) return [[zod], kind];
      this.problems.push(`${at}: a schema on a ${kind} has no meaning`);
      return undefined;
    };
    if (Node.isArrayLiteralExpression(type)) return this.union(type, schema, place);
    for (const [name, zod] of Object.entries(SCALARS))
      if (isGlobal(type, name)) return noSchema(zod, name.toLowerCase());
    const storage = this.dateStorage(type);
    if (storage) {
      if (storage !== 'milliseconds' && place.addressable)
        this.dates.push([`${this.key(place.path.join('.'))}: ${this.str(storage)}`]);
      else if (storage !== 'milliseconds')
        this.problems.push(`${at}: a ${storage} Date inside an array or a Set does not convert`);
      return noSchema('z.date()', 'date');
    }
    if (isGlobal(type, 'Object')) {
      if (schema === undefined)
        return [[this.open(place.path) ? 'z.looseObject({})' : 'z.object({})'], 'object'];
      if (Node.isObjectLiteralExpression(schema))
        return [this.object(schema, {...place, top: false}), 'object'];
      this.problems.push(`${at}: an Object schema converts only from an object literal`);
      return undefined;
    }
    if (isGlobal(type, 'Array')) {
      const [element, ...rest] = Node.isArrayLiteralExpression(schema) ? schema.getElements() : [];
      // dynamoose stores a schemaless array as [].
      const zod =
        element &&
        rest.length === 0 &&
        this.attribute(element, {
          ...place,
          path: [...place.path, '0'],
          top: false,
          element: true,
          addressable: false
        });
      if (zod) return [['z.array(', ...zod, ')'], 'array'];
      if (!element || rest.length > 0)
        this.problems.push(`${at}: an Array converts only with a schema of one element type`);
      return undefined;
    }
    if (isGlobal(type, 'Set')) {
      const [element, ...rest] = Node.isArrayLiteralExpression(schema) ? schema.getElements() : [];
      const scalar =
        element &&
        rest.length === 0 &&
        ['String', 'Number', 'Buffer'].find((n) => isGlobal(element, n));
      if (scalar) return [[`z.set(${SCALARS[scalar]})`], 'set'];
      this.problems.push(
        `${at}: a Set converts only with a schema of [String], [Number] or [Buffer]`
      );
      return undefined;
    }
    const callee = Node.isCallExpression(type) ? type.getExpression() : type;
    const member = this.lookup.get(callee.compilerNode)?.path;
    if (member === 'type.NULL' && callee === type) {
      this.consume(type);
      return noSchema('z.null()', 'null');
    }
    if (member === 'type.COMBINE' && Node.isCallExpression(type))
      return this.combineType(type, place) ? noSchema('z.string()', 'string') : undefined;
    this.problems.push(
      member?.startsWith('type.')
        ? `${at}: dynamoose.${member} has no dynotable-orm equivalent`
        : `${at}: the type ${type.getText().replace(/\s+/g, ' ')} has no dynotable-orm equivalent`
    );
    return undefined;
  }

  private union(
    types: Node,
    schema: Node | undefined,
    place: Place
  ): [Piece[], string] | undefined {
    const options = (types as Node & {getElements(): Node[]}).getElements();
    if (schema !== undefined) {
      this.problems.push(`'${place.path.join('.')}': multiple types with a schema do not convert`);
      return undefined;
    }
    const zods = options.map((o) => this.type(o, undefined, {...place, element: true}));
    if (zods.some((z) => z === undefined)) return undefined;
    const kinds = zods.map((z) => z![1]);
    // dynotable-orm reads a union of a Date and one other type as a Date.
    if (kinds.includes('date') && kinds.some((k) => k !== 'date' && k !== 'null')) {
      this.problems.push(
        `'${place.path.join('.')}': a Date converts in multiple types only beside dynamoose.type.NULL`
      );
      return undefined;
    }
    return [
      [
        'z.union([',
        ...join(
          zods.map((z) => z![0]),
          ', '
        ),
        '])'
      ],
      kinds.includes('date') ? 'date' : kinds.length === 1 ? kinds[0] : 'union'
    ];
  }

  private combineType(call: CallExpression, place: Place): boolean {
    const [sources, separator, ...rest] = call.getArguments();
    const ok =
      place.top &&
      rest.length === 0 &&
      Node.isArrayLiteralExpression(sources) &&
      sources.getElements().every(Node.isStringLiteral) &&
      (separator === undefined || Node.isStringLiteral(separator));
    if (!ok) {
      this.problems.push(
        `'${place.path.join('.')}': only a top-level COMBINE of string literals converts`
      );
      return false;
    }
    this.consume(call.getExpression());
    this.combine.push([
      `${this.key(place.path[0])}: {sources: `,
      sources,
      ...(separator ? [', separator: ', separator] : []),
      '}'
    ]);
    return true;
  }
}

interface SchemaSite {
  created: NewExpression;
  reader: SchemaReader;
  /** The const the schema is assigned to. */
  variable?: {
    name: string;
    options: string;
    exported: boolean;
    statement: Node;
    /** The local name of the ModelOptions type the options satisfy, when the schema has a set hook. */
    typeName?: string;
  };
  /** Passed straight to `model()`, which writes it. */
  inline: boolean;
  models: ModelSite[];
  problems: string[];
}

interface ModelSite {
  call: CallExpression;
  schema?: SchemaSite;
  /** A plain-object definition passed to `model()`. */
  inline?: SchemaReader;
  kept: Piece[][];
  problems: string[];
}

/**
 * `new dynamoose.Schema({...}, settings)` → a Zod object and model options; `dynamoose.model(name, schema)`
 * → `model(name, schema, options)`. A schema or a model call with any part that does not convert stays as
 * it is, with a TODO, and so does every model call or schema that depends on it.
 */
export function transformSchemas(ctx: Context): void {
  const lookup = dynamooseMembers(ctx);
  const memberOf = (n: Node) => lookup.get(n.compilerNode);
  const q = ctx.file.getImportDeclarations()[0]?.getModuleSpecifier().getText()[0] ?? "'";
  const indentOf = (n: Node) =>
    ctx.indentAt((n.getFirstAncestor(Node.isStatement) ?? n).getStart());
  const zod = zodModule(ctx);
  const taken = `z is bound to something other than ${zod} in this file`;
  const zTaken = (at: Node) =>
    at
      .getSymbolsInScope(ts.SymbolFlags.Value | ts.SymbolFlags.Alias)
      .some(
        (s) => s.getName() === 'z' && !s.getDeclarations().every((d) => isZodNamespace(d, zod))
      );
  // The names this file's generated declarations and type imports take, so no two of them are the same.
  const generated = new Set<string>(IMPORTED_TYPES);

  const schemas = new Map<NewExpression, SchemaSite>();
  for (const created of ctx.file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    if (memberOf(created.getExpression())?.path !== 'Schema') continue;
    const [definition, settings, ...rest] = created.getArguments();
    const reader = new SchemaReader(lookup, q, indentOf(created), definition, settings);
    const site: SchemaSite = {
      created,
      reader,
      models: [],
      problems: [...reader.problems],
      inline: isModelArgument(created, memberOf)
    };
    if (rest.length > 0) site.problems.push('new Schema() takes a definition and settings');
    if (zTaken(created)) site.problems.push(taken);
    const decl = created.getParent();
    if (
      Node.isVariableDeclaration(decl) &&
      isConstDeclaration(decl) &&
      Node.isIdentifier(decl.getNameNode())
    ) {
      const name = decl.getName();
      const statement = decl.getVariableStatementOrThrow();
      const options = [
        name.endsWith('Schema') && name.length > 6 ? `${name.slice(0, -6)}Options` : '',
        `${name}Options`
      ].find((n) => n && !generated.has(n) && localName(ctx, n, statement) === n);
      if (!options || statement.getDeclarations().length > 1)
        site.problems.push(`no free name for the options of ${name}`);
      if (options) generated.add(options);
      // A set hook types the options with ModelOptions, imported under a name no binding of the file holds.
      const typeName = reader.hasSet ? localName(ctx, 'ModelOptions', statement) : undefined;
      if (reader.hasSet && typeName === undefined) site.problems.push(takenMessage('ModelOptions'));
      site.variable = {
        name,
        options: options ?? '',
        exported: statement.isExported(),
        statement,
        ...(typeName && {typeName})
      };
    } else if (!site.inline) {
      site.problems.push(
        'only a schema assigned to a const, or passed straight to model(), converts'
      );
    }
    schemas.set(created, site);
  }

  const models: ModelSite[] = [];
  for (const call of ctx.file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (memberOf(call.getExpression())?.path !== 'model') continue;
    const [name, schema, settings, ...rest] = call.getArguments();
    const site: ModelSite = {call, kept: [], problems: []};
    models.push(site);
    if (!name || !schema || rest.length > 0) {
      site.problems.push('only model(name, schema) or model(name, schema, settings) converts');
      continue;
    }
    if (Node.isNewExpression(schema) && schemas.has(schema)) site.schema = schemas.get(schema);
    else if (Node.isObjectLiteralExpression(schema)) {
      site.inline = new SchemaReader(lookup, q, indentOf(call), schema, undefined);
      site.problems.push(...site.inline.problems);
      if (zTaken(call)) site.problems.push(taken);
    } else {
      const decl = Node.isIdentifier(schema)
        ? schema.getSymbol()?.getValueDeclaration()
        : undefined;
      const init = Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
      site.schema = Node.isNewExpression(init) ? schemas.get(init) : undefined;
      if (!site.schema)
        site.problems.push(
          'the schema is not a new Schema() of this file: pass its Zod schema and options by hand'
        );
    }
    site.schema?.models.push(site);
    // The options const goes next to the schema; another binding of its name here would be read instead.
    const options = site.schema?.variable?.options;
    if (options && localName(ctx, options, call) !== options)
      site.problems.push(
        `${options} is bound to something else here: rename that binding, then run again`
      );
    if (settings) modelSettings(site, settings);
    if (localName(ctx, 'model', call) === undefined) site.problems.push(takenMessage('model'));
  }

  // A schema variable is used only as a model() argument, so its declaration can change.
  for (const site of schemas.values()) {
    if (!site.variable) continue;
    const uses = refsInFile(
      ctx,
      (site.created.getParentOrThrow() as Node & {getNameNode(): Node}).getNameNode()
    );
    const other = uses.find((u) => !site.models.some((m) => m.call.getArguments()[1] === u));
    if (other)
      site.problems.push(
        `${site.variable.name} is used other than as model()'s schema: ${other.getParentOrThrow().getText()}`
      );
  }
  for (const site of schemas.values()) {
    if (site.problems.length === 0 && site.models.some((m) => m.problems.length > 0)) {
      site.problems.push('a model() of this schema does not convert');
    }
  }

  const claim = (members: Iterable<Member>, done: boolean) => {
    for (const m of members) ctx.claimed.set(m.root.compilerNode, done);
  };
  const within = (n: Node) =>
    [...lookup.entries()]
      .filter(([c]) => c.pos >= n.getPos() && c.end <= n.getEnd())
      .map(([, m]) => m);

  for (const site of models) {
    const own = [
      ...site.problems,
      ...(site.schema && !site.schema.variable ? site.schema.problems : [])
    ];
    if (own.length > 0 || (site.schema?.variable && site.schema.problems.length > 0)) {
      ctx.todo(
        site.call,
        `model(): ${own.length > 0 ? own.join('; ') : 'its schema does not convert'}`
      );
      claim(within(site.call), false);
      continue;
    }
    const reader = site.inline ?? site.schema!.reader;
    const [name, schema] = site.call.getArguments();
    const variable = site.schema?.variable;
    const schemaText: Piece[] = variable ? [schema] : reader.zod;
    const options: Piece[] = variable
      ? site.kept.length > 0
        ? ['{...', variable.options, ', ', ...join(site.kept, ', '), '}']
        : [variable.options]
      : reader.options(site.kept);
    const local = localName(ctx, 'model', site.call)!;
    ctx.imports.add(local === 'model' ? 'model' : `model as ${local}`);
    ctx.zod ||= !variable;
    ctx.replace(site.call, () =>
      render(ctx, [`${local}(`, name, ', ', ...schemaText, ', ', ...options, ')'])
    );
    // model() types the model from its schema, so the type arguments go: a local type only they used goes too.
    removeUnusedTypes(ctx, site.call.getTypeArguments(), []);
    claim(
      [
        memberOf(site.call.getExpression())!,
        ...reader.members,
        ...(site.schema ? [memberOf(site.schema.created.getExpression())!] : [])
      ],
      true
    );
  }

  for (const site of schemas.values()) {
    if (site.inline) continue;
    if (site.problems.length > 0 || !site.variable) {
      ctx.todo(site.created, `new Schema(): ${site.problems.join('; ')}`);
      claim(within(site.created), false);
      continue;
    }
    const {options, exported, statement, typeName} = site.variable;
    const typed = typeName ? ` satisfies ${typeName}<z.output<typeof ${site.variable.name}>>` : '';
    if (typeName)
      ctx.typeImports.add(typeName === 'ModelOptions' ? typeName : `ModelOptions as ${typeName}`);
    ctx.zod = true;
    ctx.replace(site.created, () => render(ctx, site.reader.zod));
    const indent = ctx.indentAt(statement.getStart());
    ctx.replace([statement.getEnd(), statement.getEnd()], () =>
      render(ctx, [
        `\n${indent}${exported ? 'export ' : ''}const ${options} = `,
        ...site.reader.options(),
        ` as const${typed};`
      ])
    );
    claim([memberOf(site.created.getExpression())!, ...site.reader.members], true);
  }
}

const render = (ctx: Context, pieces: Piece[]) =>
  pieces.map((p) => (typeof p === 'string' ? p : ctx.text(p))).join('');

function isModelArgument(
  created: NewExpression,
  memberOf: (n: Node) => Member | undefined
): boolean {
  const call = created.getParent();
  return (
    Node.isCallExpression(call) &&
    call.getArguments()[1] === created &&
    memberOf(call.getExpression())?.path === 'model'
  );
}

function modelSettings(site: ModelSite, settings: Node): void {
  if (!Node.isObjectLiteralExpression(settings)) {
    site.problems.push('the model settings are not an object literal');
    return;
  }
  const {kept, unknown} = tableSettings(settings, literalName);
  for (const p of kept) site.kept.push([p]);
  for (const p of unknown)
    site.problems.push(
      `the model setting ${literalName(p) ?? p.getText()} has no dynotable-orm equivalent`
    );
}
