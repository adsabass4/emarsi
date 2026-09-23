'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ema, sma, smaBefore, rsi, crossedAbove, lastCrossIndex } = require('../src/indicators');

test('sma returns the average of the last N values', () => {
  assert.strictEqual(sma([1, 2, 3, 4, 5], 3), 4);
  assert.strictEqual(sma([10, 20, 30], 2), 25);
  assert.strictEqual(sma([1, 2], 3), null);
  assert.strictEqual(sma([], 5), null);
});

test('sma of a single value equals that value', () => {
  assert.strictEqual(sma([42], 1), 42);
});

// ---------- smaBefore (volume reference window) ----------

test('smaBefore averages exactly the 20 values before idx (Test 3: 1500 > 1000 → true)', () => {
  // 20 previous candles average 1000; the signal candle (at idx) holds 1500.
  const volumes = new Array(20).fill(1000);
  volumes.push(1500); // idx = 20 (the signal candle)
  const ref = smaBefore(volumes, 20, 20);
  assert.strictEqual(ref, 1000, 'reference average is the previous-20 mean');
  const volumeOk = volumes[20] > ref;
  assert.strictEqual(volumeOk, true, '1500 > 1000 → volumeOk = true');
});

test('smaBefore never includes the value at idx itself (Test 4)', () => {
  // If the current volume leaked into the average, this huge value would
  // pull the mean up and change the result. Construct a case where the
  // two windows differ:
  //   previous-20 (t-20..t-1) mean = 1500, vol[t] = 1500  → new: false (not >)
  //   old sma window (t-19..t)     mean = 1475             → old: true (wrong)
  const volumes = [2000]; // t-20
  for (let i = 0; i < 19; i++) volumes.push((28000 / 19)); // t-19..t-1 → sum(prev20)=30000
  volumes.push(1500); // t (signal candle)
  const t = 20;

  const ref = smaBefore(volumes, 20, t);
  assert.ok(Math.abs(ref - 1500) < 1e-9, `reference = mean(t-20..t-1) = 1500, got ${ref}`);

  // Window INCLUDING the current value (the old buggy shape: t-19..t).
  let oldSum = 0;
  for (let i = t - 19; i <= t; i++) oldSum += volumes[i];
  const oldAvg = oldSum / 20;
  assert.ok(oldAvg < 1500, `sanity: buggy window avg ${oldAvg} would wrongly pass`);

  assert.strictEqual(volumes[t] > ref, false, 'correct check: signal vol NOT > prev-20 avg');
  assert.strictEqual(volumes[t] > oldAvg, true, 'buggy check would have passed — proving the window differs');
});

test('smaBefore is anchored at idx: appending future volumes does not change it (Test 5)', () => {
  const prefix = [];
  for (let i = 0; i < 40; i++) prefix.push(500 + (i % 7) * 10);
  const t = 39;

  const refWithoutFuture = smaBefore(prefix, 20, t);

  // Append extreme future volumes — must not affect the window at t.
  const withFuture = prefix.concat([999999, 1, 888888, 2, 777777]);
  const refWithFuture = smaBefore(withFuture, 20, t);

  assert.strictEqual(refWithoutFuture, refWithFuture,
    'future volumes must not change the reference average at t');
  // Also: manually computed expected value = mean(prefix[t-20..t-1]).
  let sum = 0;
  for (let i = t - 20; i < t; i++) sum += prefix[i];
  assert.strictEqual(refWithoutFuture, sum / 20, 'equals mean of t-20..t-1');
});

test('smaBefore returns null when there are not enough prior values', () => {
  assert.strictEqual(smaBefore([1, 2, 3], 20, 3), null, 'idx < period');
  assert.strictEqual(smaBefore([1, 2, 3], 20, 0), null);
  assert.strictEqual(smaBefore([], 20, 0), null);
  assert.strictEqual(smaBefore([1, 2, 3], 0, 3), null, 'invalid period');
  assert.strictEqual(smaBefore([1, 2, 3], 20, 1.5), null, 'non-integer idx');
});

test('smaBefore basic arithmetic', () => {
  assert.strictEqual(smaBefore([10, 20, 30], 2, 3), 25, 'mean of [20, 30]');
  assert.strictEqual(smaBefore([1, 2], 1, 2), 2, 'period 1 → value at idx-1');
});

test('ema value at index t is unchanged when future candles are appended', () => {
  // EMA is a forward-only recursion: ema(long)[t] must equal ema(prefix)[t].
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.4) * 3);
  const t = 45;
  const prefix = closes.slice(0, t + 1);
  const longer = closes.concat([200, 50, 300, 20, 999]);

  const emaPrefix = ema(prefix, 9);
  const emaLonger = ema(longer, 9);
  assert.strictEqual(emaPrefix[t], emaLonger[t], 'EMA at t ignores future closes');

  const rsiPrefix = rsi(prefix, 14);
  const rsiLonger = rsi(longer, 14);
  assert.strictEqual(rsiPrefix[t], rsiLonger[t], 'RSI at t ignores future closes');
});

test('ema is seeded with SMA and smooths a linear series by (period-1)/2', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const out = ema(values, 3);
  // seed = SMA(1,2,3) = 2 ; k = 0.5
  assert.strictEqual(out[0], null);
  assert.strictEqual(out[1], null);
  assert.strictEqual(out[2], 2);
  assert.strictEqual(out[3], 3);
  assert.strictEqual(out[4], 4);
  assert.strictEqual(out[5], 5);
  assert.strictEqual(out[9], 9);
});

test('ema for period 2 on linear series', () => {
  const out = ema([1, 2, 3, 4], 2);
  assert.strictEqual(out[0], null);
  assert.strictEqual(out[1], 1.5);
  // k=2/3 → 3*2/3 + 1.5*1/3 = 2.5
  assert.ok(Math.abs(out[2] - 2.5) < 1e-12);
  // 4*2/3 + 2.5*1/3 = 3.5
  assert.ok(Math.abs(out[3] - 3.5) < 1e-12);
});

test('ema returns all nulls when input is shorter than period', () => {
  const out = ema([1, 2], 5);
  assert.deepStrictEqual(out, [null, null]);
});

test('rsi returns null with insufficient data', () => {
  assert.strictEqual(rsi([1, 2, 3], 14), null);
});

test('rsi series: nulls for first period, then valid values', () => {
  const closes = Array.from({ length: 30 }, (_, i) => i + 1);
  const series = rsi(closes, 14);
  assert.ok(Array.isArray(series), 'returns an array');
  assert.strictEqual(series.length, 30);
  // First 14 entries are null (not enough data)
  for (let i = 0; i < 14; i++) {
    assert.strictEqual(series[i], null, `series[${i}] should be null`);
  }
  // Last entry is the traditional RSI value
  assert.strictEqual(series[29], 100);
});

test('rsi is 100 when prices only rise', () => {
  const closes = Array.from({ length: 30 }, (_, i) => i + 1);
  const series = rsi(closes, 14);
  assert.strictEqual(series[29], 100);
});

test('rsi is 0 when prices only fall', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 30 - i);
  const series = rsi(closes, 14);
  assert.strictEqual(series[29], 0);
});

test('rsi matches a hand-computed Wilder example (period 2)', () => {
  // closes [1,2,3,2,3]:
  // seed: gains on (1→2)=+1, (2→3)=+1 → avgGain=1, avgLoss=0 → 100 first
  // i=3: d=-1 → avgGain=(1+0)/2=0.5, avgLoss=(0+1)/2=0.5
  // i=4: d=+1 → avgGain=(0.5+1)/2=0.75, avgLoss=(0.5+0)/2=0.25
  // RS=3 → RSI=100-100/4=75
  const series = rsi([1, 2, 3, 2, 3], 2);
  assert.strictEqual(series[4], 75);
  // Earlier values
  assert.strictEqual(series[0], null);
  assert.strictEqual(series[1], null);
  assert.strictEqual(series[2], 100);  // seed: all gains
  assert.strictEqual(series[3], 50);   // after the drop
});

test('rsi series has correct length matching input', () => {
  const closes = [10, 11, 12, 11, 13, 14, 12, 15, 16, 14];
  const series = rsi(closes, 3);
  assert.strictEqual(series.length, closes.length);
  assert.strictEqual(series[0], null);
  assert.strictEqual(series[1], null);
  assert.strictEqual(series[2], null);
  // series[3] onwards are valid
  assert.ok(typeof series[3] === 'number');
});

test('crossedAbove detects a real crossover on the last bar only', () => {
  // fast crosses above slow exactly on the last element
  const fast = [5, 5.5, 6.0, 6.5, 7.0];   // kept rising
  const slow = [5.2, 5.4, 5.6, 6.8, 6.4]; // was above till previous bar, then below
  assert.strictEqual(crossedAbove(fast, slow), true);
});

test('crossedAbove is false when already above for more than one bar', () => {
  const fast = [5, 5.5, 6.0, 7.0, 7.5];
  const slow = [4, 4.5, 5.0, 6.9, 7.4];
  // previous bar: 7.0 > 6.9 already above → not a new cross
  assert.strictEqual(crossedAbove(fast, slow), false);
});

test('crossedAbove is false when never above', () => {
  const fast = [5, 5.5, 6.0, 6.5, 7.0];
  const slow = [6, 6.5, 7.0, 7.5, 8.0];
  assert.strictEqual(crossedAbove(fast, slow), false);
});

test('crossedAbove handles nulls and mismatched lengths', () => {
  assert.strictEqual(crossedAbove([1, 2, 3], [1, 2]), false);
  assert.strictEqual(crossedAbove([null, 2, 3], [1, 2, 3]), false);
  assert.strictEqual(crossedAbove([], []), false);
  assert.strictEqual(crossedAbove([1], [1]), false);
});

// ---------- lastCrossIndex ----------

test('lastCrossIndex finds the latest upward crossover', () => {
  const fast = [80, 85, 95, 90, 85, 88, 95, 96];
  const slow = [90, 90, 90, 90, 90, 90, 90, 90];
  // Cross at index 2 and index 6
  assert.strictEqual(lastCrossIndex(fast, slow), 6);
});

test('lastCrossIndex returns -1 when fast is not above slow on last candle', () => {
  // Cross at index 2, but fast[4] < slow[4]
  const fast = [80, 85, 95, 88, 85];
  const slow = [90, 90, 90, 90, 90];
  assert.strictEqual(lastCrossIndex(fast, slow), -1);
});

test('lastCrossIndex returns -1 when no crossover exists', () => {
  assert.strictEqual(lastCrossIndex([90, 91, 92], [80, 81, 82]), -1);
  assert.strictEqual(lastCrossIndex([80, 81, 82], [90, 91, 92]), -1);
  assert.strictEqual(lastCrossIndex([1], [1]), -1);
  assert.strictEqual(lastCrossIndex([], []), -1);
});

test('lastCrossIndex respects maxLookback limit', () => {
  // Cross at index 2, fast stays above till end
  const fast = [80, 85, 95, 96, 97, 98, 99, 100];
  const slow = [90, 90, 90, 90, 90, 90, 90, 90];
  // With maxLookback=3, only checks indices 5,6,7 → no cross found
  assert.strictEqual(lastCrossIndex(fast, slow, 3), -1);
  // With maxLookback=5, checks indices 3,4,5,6,7 → no cross
  assert.strictEqual(lastCrossIndex(fast, slow, 5), -1);
  // With maxLookback=6, checks indices 2,3,4,5,6,7 → cross at 2
  assert.strictEqual(lastCrossIndex(fast, slow, 6), 2);
  // No limit → finds cross at 2
  assert.strictEqual(lastCrossIndex(fast, slow), 2);
});

test('lastCrossIndex returns -1 when fast <= slow on last candle even with old cross', () => {
  // Cross at index 2, but fast drops back below at index 4
  const fast = [80, 85, 95, 92, 88, 85, 84, 83];
  const slow = [90, 90, 90, 90, 90, 90, 90, 90];
  assert.strictEqual(lastCrossIndex(fast, slow), -1);
});

test('lastCrossIndex handles nulls in series', () => {
  const fast = [null, null, 85, 95, 96, 97];
  const slow = [null, null, 90, 90, 90, 90];
  assert.strictEqual(lastCrossIndex(fast, slow), 3);
});