// The verdicts of the CI benchmark gate. Samples are ops/s, one per interleaved round.
//
// Absolute targets (lib against raw and against dynamoose) are judged on the median of the per-round
// ratios, with a distribution-free confidence interval of that median: the target passes only when the
// whole interval meets it. An interval that straddles the target is too noisy to call. The gate re-runs
// a row that does not pass once, and fails it when the re-run does not pass either, so a target never
// passes by default. Only the regression rule (lib against the base build) uses a significance test.

export const GATE = {
  schemas: ['order'],
  operations: ['create', 'get', 'update'],
  /** lib CPU at most this multiple of raw: the raw ops/s over the lib ops/s, per round. */
  maxRawRatio: 1.5,
  /** lib at least this many times faster than dynamoose: the lib ops/s over the dynamoose ops/s, per round. */
  minDynamooseRatio: 10,
  maxSlowdownPercent: 15,
  alpha: 0.01
} as const;

export const isGated = (schema: string, operation: string): boolean =>
  (GATE.schemas as readonly string[]).includes(schema) &&
  (GATE.operations as readonly string[]).includes(operation);

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function normalCdf(z: number): number {
  // Abramowitz and Stegun 7.1.26, error below 1.5e-7.
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const erf =
    1 -
    t *
      (0.254829592 +
        t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
      Math.exp((-z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * One-sided Mann-Whitney U test, normal approximation with tie and continuity correction: the probability
 * that samples `a` rank this low against samples `b` by chance.
 */
export function mannWhitneyLess(a: readonly number[], b: readonly number[]): number {
  const all = [
    ...a.map((value) => ({value, fromA: true})),
    ...b.map((value) => ({value, fromA: false}))
  ].sort((x, y) => x.value - y.value);
  let rankSumA = 0;
  let tieTerm = 0;
  for (let start = 0; start < all.length;) {
    let end = start;
    while (end + 1 < all.length && all[end + 1]!.value === all[start]!.value) end++;
    const ties = end - start + 1;
    tieTerm += ties ** 3 - ties;
    for (let i = start; i <= end; i++) if (all[i]!.fromA) rankSumA += (start + end) / 2 + 1;
    start = end + 1;
  }
  const n = all.length;
  const u = rankSumA - (a.length * (a.length + 1)) / 2;
  const mean = (a.length * b.length) / 2;
  const sd = Math.sqrt(((a.length * b.length) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  return sd === 0 ? 1 : normalCdf((u - mean + 0.5) / sd);
}

export interface RegressionVerdict {
  /** Percent change of the median ops/s against the base. */
  change: number;
  p: number;
  slower: boolean;
}

export function regressionVerdict(
  baseSamples: readonly number[],
  currentSamples: readonly number[]
): RegressionVerdict {
  const base = median(baseSamples);
  const current = median(currentSamples);
  const p = mannWhitneyLess(currentSamples, baseSamples);
  // Compared as a product, not through `change`: (85 / 100 - 1) * 100 is -15.000000000000002.
  return {
    change: (current / base - 1) * 100,
    p,
    slower: current < base * (1 - GATE.maxSlowdownPercent / 100) && p < GATE.alpha
  };
}

/**
 * The order-statistic ranks [k, n + 1 - k] (1-based) of a two-sided confidence interval of the median at
 * level 1 - alpha, from the binomial distribution; k is 0 when n rounds are too few for one.
 */
export function medianIntervalRank(n: number, alpha: number = GATE.alpha): number {
  let k = 0;
  let below = 0; // P(B <= k - 1), B ~ Binomial(n, 1/2)
  let term = 0.5 ** n; // P(B = k)
  while (k < n / 2 && 2 * (below + term) <= alpha) {
    below += term;
    term = (term * (n - k)) / (k + 1);
    k++;
  }
  return k;
}

export type TargetResult = 'pass' | 'miss' | 'noisy';

export interface TargetVerdict {
  median: number;
  /** The confidence interval of the median; NaN when there are too few rounds for one. */
  low: number;
  high: number;
  result: TargetResult;
}

/** Per-round ratios against a target: at most `max` or at least `min`. */
export function targetVerdict(
  ratios: readonly number[],
  target: {max: number} | {min: number}
): TargetVerdict {
  const sorted = [...ratios].sort((a, b) => a - b);
  const k = medianIntervalRank(sorted.length);
  const low = k ? sorted[k - 1]! : Number.NaN;
  const high = k ? sorted[sorted.length - k]! : Number.NaN;
  const meets = (x: number) => ('max' in target ? x <= target.max : x >= target.min);
  const result: TargetResult =
    k === 0 || meets(low) !== meets(high) ? 'noisy' : meets(low) ? 'pass' : 'miss';
  return {median: median(sorted), low, high, result};
}

/** Per-round ratios of two contenders' ops/s samples, `numerator[i] / denominator[i]`. */
export function ratios(numerator: readonly number[], denominator: readonly number[]): number[] {
  if (numerator.length !== denominator.length) throw new Error('ratios: the sample counts differ');
  return numerator.map((x, i) => x / denominator[i]!);
}

export interface RowSamples {
  lib: readonly number[];
  raw: readonly number[];
  /** Absent where dynamoose cannot do the same work (`update-nested`). */
  dynamoose?: readonly number[];
  /** Absent when the base has no bench. */
  base?: readonly number[];
}

export interface RowVerdict {
  /** lib CPU over raw CPU, per round. */
  raw: TargetVerdict;
  /** dynamoose CPU over lib CPU, per round; absent without dynamoose samples, and then the row cannot pass. */
  dynamoose?: TargetVerdict;
  regression?: RegressionVerdict;
  pass: boolean;
}

export function rowVerdict(s: RowSamples): RowVerdict {
  const raw = targetVerdict(ratios(s.raw, s.lib), {max: GATE.maxRawRatio});
  const dynamoose =
    s.dynamoose && targetVerdict(ratios(s.lib, s.dynamoose), {min: GATE.minDynamooseRatio});
  const regression = s.base && regressionVerdict(s.base, s.lib);
  return {
    raw,
    dynamoose,
    regression,
    pass: raw.result === 'pass' && dynamoose?.result === 'pass' && !regression?.slower
  };
}

/** Re-runs once every row that did not pass; returns the rows whose re-run did not pass either. */
export async function judge<R>(
  first: ReadonlyArray<{row: R; verdict: RowVerdict}>,
  rerun: (rows: R[]) => Promise<RowVerdict[]>
): Promise<R[]> {
  const again = first.filter((x) => !x.verdict.pass).map((x) => x.row);
  if (again.length === 0) return [];
  const verdicts = await rerun(again);
  return again.filter((_, i) => !verdicts[i]!.pass);
}
