'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ema, sma, rsi, crossedAbove, lastCrossIndex } = require('../src/indicators');

test('sma returns the average of the last N values', () => {
  assert.strictEqual(sma([1, 2, 3, 4, 5], 3), 4);
  assert.strictEqual(sma([10, 20, 30], 2), 25);
  assert.strictEqual(sma([1, 2], 3), null);
  assert.strictEqual(sma([], 5), null);
});

test('sma of a single value equals that value', () => {
  assert.strictEqual(sma([42], 1), 42);
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