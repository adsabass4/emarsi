'use strict';

/**
 * Pure indicator functions. All functions expect arrays ordered oldest → newest.
 * No external dependencies so they are easy to unit test.
 */

/**
 * Exponential Moving Average aligned with the input array.
 * Seeded with the SMA of the first `period` values (standard convention).
 * Entries before enough data exists are null.
 */
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!period || period < 1 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Simple Moving Average of the last `period` values, or null if not enough data. */
function sma(values, period) {
  if (!period || period < 1 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/**
 * RSI with Wilder's smoothing.
 * Returns array of RSI values aligned with input (first `period` entries are null).
 * If average loss is zero the RSI is 100 (all gains).
 * Last element (index closes.length - 1) equals the traditional single-value RSI.
 */
function rsi(closes, period = 14) {
  if (!period || period < 1 || closes.length <= period) return null;
  const out = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss += -d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * True when fast crossed above slow on the LAST element of both arrays
 * (i.e. fast[last] > slow[last] while fast[prev] <= slow[prev]).
 * Returns false when data is insufficient or contains nulls.
 */
function crossedAbove(fast, slow) {
  const n = fast.length;
  if (n < 2 || slow.length !== n) return false;
  const i = n - 1;
  const j = n - 2;
  if ([fast[i], slow[i], fast[j], slow[j]].some((v) => v === null || v === undefined)) {
    return false;
  }
  return fast[i] > slow[i] && fast[j] <= slow[j];
}

/**
 * Find the index of the LAST upward crossover in the series.
 * Scans from newest to oldest: returns the index where fast[i] > slow[i]
 * and fast[i-1] <= slow[i-1], or -1 if no crossover exists.
 * Unlike crossedAbove (which only checks the last pair), this finds
 * crossovers that happened many candles ago.
 * 
 * @param fast     fast EMA series
 * @param slow     slow EMA series
 * @param maxLookback  max candles to look back (default Infinity = no limit)
 *                     Only returns a crossover if found within this window
 *                     from the most recent candle.
 * @returns index of crossover candle, or -1 if none found within lookback
 *          or if fast is not currently above slow.
 */
function lastCrossIndex(fast, slow, maxLookback = Infinity) {
  const n = fast.length;
  if (n < 2 || slow.length !== n) return -1;
  
  // ✅ التحقق: الوضع الحالي لازم يكون صاعد (fast > slow على آخر شمعة)
  const last = n - 1;
  if (fast[last] === null || slow[last] === null || fast[last] <= slow[last]) {
    return -1;
  }
  
  // ✅ حد البحث للخلف
  const start = Math.max(1, n - maxLookback);
  for (let i = n - 1; i >= start; i--) {
    if (fast[i] === null || slow[i] === null || fast[i - 1] === null || slow[i - 1] === null) {
      continue;
    }
    if (fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]) {
      return i;
    }
  }
  return -1;
}

module.exports = { ema, sma, rsi, crossedAbove, lastCrossIndex };