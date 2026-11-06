import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {PACKAGE} from './bench.js';
import {
  judge,
  medianIntervalRank,
  ratios,
  regressionVerdict,
  rowVerdict,
  targetVerdict
} from './gate.js';

const times = (n: number, x: number) => Array.from({length: n}, () => x);

// Samples are ops/s per round. The rule must fail a real slowdown and pass runner noise.
describe('regressionVerdict', () => {
  const base = [100, 101, 99, 102, 98, 100, 101, 99, 100, 100];

  it('passes a faster build, with the change in percent', () => {
    expect(regressionVerdict(base, times(10, 105))).toMatchObject({
      change: 5.000000000000004,
      slower: false
    });
  });

  it('fails a 20% slowdown that every round shows', () => {
    expect(regressionVerdict(base, [80, 81, 79, 82, 78, 80, 81, 79, 80, 80]).slower).toBe(true);
  });

  it('passes a 20% median slowdown when the rounds overlap (noise)', () => {
    expect(
      regressionVerdict(
        [100, 60, 140, 100, 60, 140, 100, 60, 140, 100],
        [80, 140, 60, 80, 140, 60, 80, 140, 60, 80]
      ).slower
    ).toBe(false);
  });

  // p is about 0.03: a rule with alpha loosened toward 0.1 would fail this row.
  it('passes a 20% median slowdown that is not significant at p < 0.01', () => {
    const result = regressionVerdict(base, [80, 80, 80, 80, 80, 80, 102, 101, 99, 100]);
    expect(result.p).toBeGreaterThan(0.01);
    expect(result.p).toBeLessThan(0.05);
    expect(result.slower).toBe(false);
  });

  it('passes a significant slowdown of exactly 15%', () => {
    const result = regressionVerdict(base, times(10, 85));
    expect(result.p).toBeLessThan(0.01);
    expect(result.slower).toBe(false);
  });
});

describe('targetVerdict', () => {
  // Binomial(n, 1/2): 2 P(B <= 3) = 0.0026 for n = 20, 2 P(B <= 0) = 0.0078 for n = 8 and 0.0156 for n = 7.
  it('takes the 99% interval of the median from the binomial order statistics', () => {
    expect([medianIntervalRank(20), medianIntervalRank(8), medianIntervalRank(7)]).toStrictEqual([
      4, 1, 0
    ]);
  });

  it('judges an upper bound (lib/raw)', () => {
    expect(targetVerdict(times(20, 0.5), {max: 1.5})).toStrictEqual({
      median: 0.5,
      low: 0.5,
      high: 0.5,
      result: 'pass'
    });
    expect(targetVerdict(times(20, 2), {max: 1.5}).result).toBe('miss');
    // Ranks 4 and 17 of 20 rounds fall on both sides of the target.
    expect(targetVerdict([...times(10, 1.4), ...times(10, 1.6)], {max: 1.5})).toStrictEqual({
      median: 1.5,
      low: 1.4,
      high: 1.6,
      result: 'noisy'
    });
  });

  it('judges a lower bound (dynamoose/lib)', () => {
    expect(targetVerdict(times(20, 50), {min: 10}).result).toBe('pass');
    expect(targetVerdict(times(20, 5), {min: 10}).result).toBe('miss');
    expect(targetVerdict([...times(10, 9), ...times(10, 11)], {min: 10}).result).toBe('noisy');
  });

  // An acceptance target must not fail open: rounds too few for an interval can never pass.
  it('calls too few rounds noisy, however clear the ratios', () => {
    expect(targetVerdict([0.1, 0.1], {max: 1.5}).result).toBe('noisy');
  });
});

describe('rowVerdict and judge', () => {
  // lib 1000 ops/s, raw 1200 (lib/raw 1.2x), dynamoose 10 (dynamoose/lib 100x).
  const good = {lib: times(20, 1000), raw: times(20, 1200), dynamoose: times(20, 10)};
  const noisy = rowVerdict({lib: [1000, 1000], raw: [1200, 1200], dynamoose: [10, 10]});

  it('fails a row that misses only the dynamoose target', () => {
    // dynamoose/lib 5x: lib/raw and the regression rule both pass.
    expect(rowVerdict({...good, dynamoose: times(20, 200), base: times(20, 1000)})).toMatchObject({
      raw: {result: 'pass'},
      dynamoose: {result: 'miss'},
      regression: {slower: false},
      pass: false
    });
  });

  // A gated row that lost its dynamoose contender must not pass on the other two rules.
  it('fails a row without dynamoose samples', () => {
    expect(rowVerdict({lib: good.lib, raw: good.raw})).toMatchObject({
      dynamoose: undefined,
      pass: false
    });
  });

  it('refuses ratios of rounds that do not pair up', () => {
    expect(() => ratios([1, 2], [1])).toThrow('ratios: the sample counts differ');
  });

  it('skips the regression rule without a base, and fails a row whose base is faster', () => {
    expect(rowVerdict(good)).toMatchObject({regression: undefined, pass: true});
    expect(rowVerdict({...good, base: times(20, 2000)})).toMatchObject({
      regression: {slower: true},
      pass: false
    });
  });

  it('re-runs only the rows that did not pass, and fails a row still noisy on the re-run', async () => {
    const rerun: string[][] = [];
    const failed = await judge(
      [
        {row: 'ok', verdict: rowVerdict(good)},
        {row: 'noisy', verdict: noisy}
      ],
      async (rows) => {
        rerun.push(rows);
        return [noisy];
      }
    );
    expect([rerun, failed]).toStrictEqual([[['noisy']], ['noisy']]);
  });

  it('passes a row that passes on the re-run', async () => {
    expect(
      await judge([{row: 'noisy', verdict: noisy}], async () => [rowVerdict(good)])
    ).toStrictEqual([]);
  });
});

// The CI gate's own wiring, through the built .bench/bench.js.
describe('pnpm bench --gate', () => {
  const gate = (args: string[], env: Record<string, string>) => {
    try {
      const stdout = execFileSync(
        process.execPath,
        ['--expose-gc', join(PACKAGE, '.bench/bench.js'), '--gate', '--quick', ...args],
        {
          encoding: 'utf8',
          stdio: 'pipe',
          env: {...process.env, BASELINE: PACKAGE, ...env}
        }
      );
      return {status: 0, stdout, stderr: ''};
    } catch (error) {
      const e = error as {status: number; stdout: string; stderr: string};
      return {status: e.status, stdout: e.stdout, stderr: e.stderr};
    }
  };

  // Without BASELINE the gate cannot tell a first pull request from a base it was not given.
  it('refuses to run without BASELINE', () => {
    expect(gate([], {BASELINE: ''})).toMatchObject({
      status: 1,
      stderr: expect.stringMatching(/--gate needs BASELINE/)
    });
  });

  // Zero rounds give no samples, and a gate without samples must not pass.
  it('refuses 0 rounds', () => {
    expect(gate(['--rounds', '0'], {})).toMatchObject({
      status: 1,
      stderr: expect.stringMatching(/--rounds must be a positive integer, got "0"/)
    });
  });

  it('skips the regression rule when the base has no bench, and fails rows too noisy to call', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dynotable-base-'));
    try {
      const {status, stdout} = gate(['--rounds', '1'], {BASELINE: empty});
      expect(status).toBe(1);
      expect(stdout).toMatch(/has no bench: the regression rule is skipped/);
      expect(stdout).toMatch(/gate FAILED: order create, order get, order update\n/);
    } finally {
      rmSync(empty, {recursive: true, force: true});
    }
  }, 120_000);

  // This lib's samples scaled to a tenth: every gated row misses lib/raw and is slower than the base, in every round.
  it('fails an end-to-end run at scale 0.1 after the re-run', () => {
    const {status, stdout} = gate(['--rounds', '9'], {BENCH_SCALE_CURRENT: '0.1'});
    expect(status).toBe(1);
    expect(stdout).toMatch(/order create, order get, order update did not pass, running again/);
    const rerun = stdout.split('running again\n')[1]!;
    for (const operation of ['create', 'get', 'update']) {
      expect(rerun).toMatch(new RegExp(`^order +${operation} .* miss .* SLOWER$`, 'm'));
    }
    expect(stdout).toMatch(/gate FAILED: order create, order get, order update\n/);
  }, 300_000);
});
