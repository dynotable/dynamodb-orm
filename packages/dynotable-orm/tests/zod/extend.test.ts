import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {ConfigError} from '../../src/errors.js';

// Every own key of every Zod class prototype, so any change an import makes shows up.
const prototypes = () =>
  Object.fromEntries(
    Object.entries(z)
      .filter(([name, v]) => name.startsWith('Zod') && typeof v === 'function' && v.prototype)
      .map(([name, v]) => [name, Reflect.ownKeys((v as Function).prototype).map(String)])
  );

// Imported here, not statically, so the snapshot is taken before the module runs.
const before = prototypes();
const {combine, extendZod, getDynamoMeta, hashKey, index, rangeKey, storage} =
  await import('../../src/zod/index.js');
const afterImport = prototypes();
const methodAfterImport = 'hashKey' in z.string();

describe('extendZod', () => {
  it('is not applied by importing the module', () => {
    expect(afterImport).toStrictEqual(before);
    expect(methodAfterImport).toBe(false);
  });

  it('gives the same metadata as the function form', () => {
    extendZod(z);
    const s = z.string();
    const d = z.date();
    const pairs = [
      [s.hashKey(), hashKey(s)],
      [s.rangeKey(), rangeKey(s)],
      [s.index(), index(s)],
      [s.index({name: 'byX', type: 'local'}), index(s, {name: 'byX', type: 'local'})],
      [s.combine(['a', 'b']), combine(s, ['a', 'b'])],
      [s.combine(['a'], '#'), combine(s, ['a'], '#')],
      [d.storage('seconds'), storage(d, 'seconds')],
      [s.hashKey().index().min(1), index(hashKey(s)).min(1)]
    ] as const;
    for (const [method, fn] of pairs)
      expect(getDynamoMeta(method)).toStrictEqual(getDynamoMeta(fn));
  });

  it('is a no-op the second time', () => {
    extendZod(z);
    const once = prototypes();
    extendZod(z);
    expect(prototypes()).toStrictEqual(once);
    expect(getDynamoMeta(z.string().hashKey())).toStrictEqual({hashKey: true});
  });

  it('refuses a different existing method and writes nothing', () => {
    class ZodType {}
    const own = () => undefined;
    Object.assign(ZodType.prototype, {storage: own});
    expect(() => extendZod({ZodType})).toThrow(
      new ConfigError("extendZod: ZodType already has a different 'storage' method")
    );
    expect(Object.keys(ZodType.prototype)).toStrictEqual(['storage']);
    expect((ZodType.prototype as {storage: unknown}).storage).toBe(own);
  });
});
