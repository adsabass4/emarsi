'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

// Unique temp DB per test-run so we never touch the real data folder.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emarsi-signals-'));
process.env.DB_PATH = path.join(tmpDir, 'signals.db');
// Each test gets its OWN db file (fresh schema, no state bleed). A counter
// avoids deleting files between tests — on Windows the previous libsql
// handle is released asynchronously (~300ms) and rmSync would throw EBUSY.
let dbSeq = 0;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');

const DAY = 24 * 3600 * 1000;
const T0 = Date.now() - 2 * DAY; // base inside the 7-day window

before(async () => {
  await db.init();
});

beforeEach(async () => {
  db.close();
  dbSeq += 1;
  process.env.DB_PATH = path.join(tmpDir, `signals-${dbSeq}.db`);
  await db.init();
});

after(() => {
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

async function scan(over = {}) {
  await db.insertScan({
    symbol: 'AAA-USDT',
    timeframe: '4H',
    timestamp: T0,
    price: 100,
    ticker_price: 101,
    rsi: 55,
    ema_cross: 1,
    volume_ok: 1,
    matched: 1,
    change_pct: 1,
    last_candle_ts: T0 - 1000,
    change_5m: null,
    change_15m: null,
    change_1h: null,
    change_4h: null,
    higher_tf_warning: null,
    cross_price: 99.5,
    ...over,
  });
}

test('consecutive matched cycles group into ONE signal (first-cycle values kept)', async () => {
  await scan({ timestamp: T0, rsi: 55.2, price: 100, cross_price: 99.5 });
  await scan({ timestamp: T0 + 900000, rsi: 57.1, price: 102, cross_price: 103.9 });
  await scan({ timestamp: T0 + 1800000, rsi: 58.4, price: 104, cross_price: 104.1 });

  const rows = await db.signalHistory({ sinceMs: T0 - DAY, timeframe: null, limit: 300 });
  assert.strictEqual(rows.length, 1, 'three consecutive cycles = one signal');
  const s = rows[0];
  assert.strictEqual(s.symbol, 'AAA-USDT');
  assert.strictEqual(s.timeframe, '4H');
  assert.strictEqual(s.detected_at, T0, 'detected at the FIRST matching cycle');
  assert.strictEqual(s.cycles, 3, 'all three cycles counted');
  assert.strictEqual(s.rsi, 55.2, 'RSI from the first cycle (cross candle), not the last');
  assert.strictEqual(s.price, 100, 'price from the first cycle');
  assert.strictEqual(s.cross_price, 99.5, 'signal price from the first cycle');
});

test('a matched=0 cycle splits the series into two signals', async () => {
  await scan({ timestamp: T0, cross_price: 99.5 });
  await scan({ timestamp: T0 + 900000, matched: 0, ema_cross: 0, volume_ok: 0, cross_price: null });
  await scan({ timestamp: T0 + 1800000, cross_price: 105.2 });

  const rows = await db.signalHistory({ sinceMs: T0 - DAY, timeframe: null, limit: 300 });
  assert.strictEqual(rows.length, 2, 'unmatch breaks the episode');
  assert.strictEqual(rows[0].detected_at, T0 + 1800000, 'newer signal first (DESC order)');
  assert.strictEqual(rows[0].cross_price, 105.2, 'second episode keeps its own signal price');
  assert.strictEqual(rows[0].cycles, 1);
  assert.strictEqual(rows[1].detected_at, T0, 'older signal second');
  assert.strictEqual(rows[1].cross_price, 99.5);
  assert.strictEqual(rows[1].cycles, 1, 'the matched=0 cycle does not count');
});

test('episodes stay separate per symbol and per timeframe', async () => {
  await scan({ symbol: 'AAA-USDT', timeframe: '4H', timestamp: T0 });
  await scan({ symbol: 'AAA-USDT', timeframe: '1H', timestamp: T0 + 1 });
  await scan({ symbol: 'BBB-USDT', timeframe: '4H', timestamp: T0 + 2 });

  const rows = await db.signalHistory({ sinceMs: T0 - DAY, timeframe: null, limit: 300 });
  assert.strictEqual(rows.length, 3, 'no merging across symbols or timeframes');
  const keys = rows.map((r) => `${r.symbol}@${r.timeframe}`).sort();
  assert.deepStrictEqual(keys, ['AAA-USDT@1H', 'AAA-USDT@4H', 'BBB-USDT@4H']);
});

test('timeframe filter: single, both, and empty selection', async () => {
  await scan({ symbol: 'AAA-USDT', timeframe: '4H', timestamp: T0 });
  await scan({ symbol: 'AAA-USDT', timeframe: '1H', timestamp: T0 + 1 });

  const h1 = await db.signalHistory({ sinceMs: T0 - DAY, timeframe: ['1H'], limit: 300 });
  assert.strictEqual(h1.length, 1, 'only 1H');
  assert.strictEqual(h1[0].timeframe, '1H');

  const both = await db.signalHistory({ sinceMs: T0 - DAY, timeframe: ['1H', '4H'], limit: 300 });
  assert.strictEqual(both.length, 2, 'explicit both');

  const all = await db.signalHistory({ sinceMs: T0 - DAY, timeframe: [], limit: 300 });
  assert.strictEqual(all.length, 2, 'empty filter = all timeframes');
});

test('window (sinceMs) excludes older rows; limit caps; newest first', async () => {
  await scan({ symbol: 'OLD-USDT', timeframe: '4H', timestamp: T0 - 10 * DAY });
  await scan({ symbol: 'A-USDT', timeframe: '4H', timestamp: T0 });
  await scan({ symbol: 'B-USDT', timeframe: '4H', timestamp: T0 + 1000 });
  await scan({ symbol: 'C-USDT', timeframe: '4H', timestamp: T0 + 2000 });

  const rows = await db.signalHistory({ sinceMs: T0 - DAY, timeframe: null, limit: 300 });
  assert.strictEqual(rows.length, 3, 'row outside the window excluded');
  assert.ok(!rows.some((r) => r.symbol === 'OLD-USDT'), 'OLD-USDT is older than sinceMs');
  assert.deepStrictEqual(rows.map((r) => r.symbol), ['C-USDT', 'B-USDT', 'A-USDT'], 'newest first');

  const capped = await db.signalHistory({ sinceMs: T0 - DAY, timeframe: null, limit: 2 });
  assert.strictEqual(capped.length, 2, 'LIMIT respected');
  assert.strictEqual(capped[0].symbol, 'C-USDT', 'limit keeps the newest');
});

test('live price comes from the LATEST scan row (even matched=0) for % since signal', async () => {
  await scan({
    symbol: 'AAA-USDT', timeframe: '4H', timestamp: T0,
    matched: 1, cross_price: 99.5, price: 100, ticker_price: 100.5,
    higher_tf_warning: 'تشبع شرائي يومي (RSI: 74)', rsi: 55.5,
  });
  // Later cycle: the signal ended, a newer live price arrived.
  await scan({
    symbol: 'AAA-USDT', timeframe: '4H', timestamp: T0 + 900000,
    matched: 0, ema_cross: 0, volume_ok: 0, cross_price: null,
    price: 110, ticker_price: 111.25, higher_tf_warning: null, rsi: 70,
  });

  const rows = await db.signalHistory({ sinceMs: T0 - DAY, timeframe: null, limit: 300 });
  assert.strictEqual(rows.length, 1, 'still ONE historical signal after unmatch');
  const s = rows[0];
  assert.strictEqual(s.detected_at, T0, 'detection time = first matched cycle');
  assert.strictEqual(s.cross_price, 99.5, 'signal price kept from episode start (not null after unmatch)');
  assert.strictEqual(s.rsi, 55.5, 'cross RSI kept from episode start');
  assert.strictEqual(s.higher_tf_warning, 'تشبع شرائي يومي (RSI: 74)', 'daily warning kept from episode start');
  assert.strictEqual(s.cycles, 1, 'only matched cycles count');
  assert.strictEqual(s.live_ticker_price, 111.25, 'live ticker from the latest row');
  assert.strictEqual(s.live_price, 110, 'live candle price from the latest row');
});
