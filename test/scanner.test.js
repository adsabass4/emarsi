'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

// Unique temp DB per test-run so we never touch the real data folder.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emarsi-scan-'));
process.env.DB_PATH = path.join(tmpDir, 'scanner.db');
// Each test gets its OWN db file (fresh schema, no state bleed). A counter
// avoids deleting files between tests — on Windows the previous libsql
// handle is released asynchronously (~300ms) and rmSync would throw EBUSY.
let dbSeq = 0;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { readConfig } = require('../src/config');
const db = require('../src/db');
const { runScan } = require('../src/scanner');

const matchCloses = require('./fixtures/match-closes.json');
const nonmatchCloses = require('./fixtures/nonmatch-closes.json');

let telegramSent = [];
const telegramFake = {
  formatAlert: (instId, price, rsv, tf) =>
    `[${instId}@${tf}] rsi=${rsv == null ? 'null' : rsv.toFixed(2)} price=${price}`,
  sendMessage: async (config, text) => {
    telegramSent.push(text);
    return true;
  },
};

// Fake whose deliveries can fail (Telegram unconfigured / API error).
let telegramCalls = 0;
let telegramOk = true;
const flakyTelegram = {
  formatAlert: (instId) => `[${instId}]`,
  sendMessage: async () => {
    telegramCalls++;
    return telegramOk;
  },
};

function candlesFrom(closes, volumes) {
  return closes.map((c, i) => ({
    ts: 1000 + i * 900,
    open: c,
    high: c * 1.001,
    low: c * 0.999,
    close: c,
    volume: volumes ? volumes[i] : 100,
    confirm: 1,
  }));
}

function matchCandles() {
  const vols = matchCloses.map(() => 100);
  vols[vols.length - 1] = 1000; // volume spike on last candle
  return candlesFrom(matchCloses, vols);
}

function nonmatchCandles() {
  return candlesFrom(nonmatchCloses);
}

// Short 5m-like series used for the change windows (60 candles).
function shortCandles() {
  const closes = require('./fixtures/short-closes.json');
  const candles = candlesFrom(closes);
  candles[candles.length - 1].confirm = 0; // latest candle is "forming" → still used as live price
  return candles;
}

function shortFixture() {
  return shortCandles();
}

function fakeOkx(map, opts = {}) {
  const client = {
    fetched: {},
    fetchedBars: {},
    getUsdtInstruments: async () => Object.keys(map),
    getTickers: async () => {
      if (opts.tickersFail) throw new Error('tickers boom');
      const volumes = opts.volumes || {};
      const lasts = opts.tickerLasts || {};
      return Object.keys(map).map((id) => ({
        instId: id,
        volCcy24h: volumes[id] != null ? volumes[id] : 1e9, // default: high enough to pass
        last: lasts[id] != null ? lasts[id] : null,
      }));
    },
    getCandles: async (instId, bar) => {
      client.fetched[instId] = (client.fetched[instId] || 0) + 1;
      client.fetchedBars[`${instId}@${bar}`] = (client.fetchedBars[`${instId}@${bar}`] || 0) + 1;
      if (opts.fail && opts.fail.includes(instId)) throw new Error(`boom ${instId}`);
      if (opts.failBar && opts.failBar[instId] === bar) throw new Error(`boom ${instId}@${bar}`);
      const entry = map[instId];
      if (!entry) throw new Error(`no data for ${instId}`);
      if (Array.isArray(entry)) return entry;
      const c = entry[bar];
      if (!c) throw new Error(`no data for ${instId}@${bar}`);
      return c;
    },
  };
  return client;
}

function baseConfig() {
  return readConfig({
    scanIntervalMinutes: 15,
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    rsiMin: 45,
    rsiMax: 65,
    volumeSma: 20,
    candlesLimit: 120,
    timeframe: '4H',
    changeBar: '5m',
    retentionDays: 0,
    telegramBotToken: 'BOT',
    telegramChatId: 'CHAT',
  });
}

before(async () => {
  await db.init();
});

beforeEach(async () => {
  telegramSent = [];
  telegramCalls = 0;
  telegramOk = true;
  db.close();
  dbSeq += 1;
  process.env.DB_PATH = path.join(tmpDir, `scanner-${dbSeq}.db`);
  await db.init();
});

after(() => {
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

async function rowsByTf(tf) {
  const rows = await db.newestRows(tf);
  return Object.fromEntries(rows.map((r) => [r.symbol, r]));
}

test('match on BOTH timeframes → two separate alerts tagged (4H) and (1H)', async () => {
  const okx = fakeOkx({
    'BOTH-USDT': { '4H': matchCandles(), '1H': matchCandles(), '5m': shortFixture() },
  });

  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(telegramSent.length, 2, 'one alert per matching timeframe');
  assert.ok(telegramSent.some((m) => m.includes('@4H')));
  assert.ok(telegramSent.some((m) => m.includes('@1H')));

  const r4 = (await rowsByTf('4H'))['BOTH-USDT'];
  const r1 = (await rowsByTf('1H'))['BOTH-USDT'];
  assert.ok(r4, '4H row stored');
  assert.ok(r1, '1H row stored');
  assert.strictEqual(r4.matched, 1);
  assert.strictEqual(r1.matched, 1);
  assert.strictEqual(r4.ema_cross, 1);
  assert.strictEqual(r4.volume_ok, 1);
  assert.ok(Math.abs(r4.rsi - 56.04) < 0.02, `rsi=${r4.rsi}`);
  assert.ok(Math.abs(r4.price - 189.46) < 1e-8, `price=${r4.price}`);
  assert.ok(Math.abs(r4.change_pct - 30.71) < 0.02, `change=${r4.change_pct}`);

  // change windows are identical on both timeframe rows (shared 5m series)
  assert.ok(Math.abs(r4.change_4h - 11.68) < 0.01, `change_4h=${r4.change_4h}`);
  assert.strictEqual(r4.change_4h, r1.change_4h);

  // state counts rows (both timeframes)
  assert.strictEqual(await db.getState('status'), 'idle');
  assert.strictEqual(Number(await db.getState('last_scan_count')), 2);
  assert.strictEqual(Number(await db.getState('last_scan_matched')), 2);
});

test('match on 4H only → single alert tagged (4H); 1H row stored unmatched', async () => {
  const okx = fakeOkx({
    'H4-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });

  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(telegramSent.length, 1);
  assert.ok(telegramSent[0].includes('@4H'));

  assert.strictEqual((await rowsByTf('4H'))['H4-USDT'].matched, 1);
  assert.strictEqual((await rowsByTf('1H'))['H4-USDT'].matched, 0);
});

test('match on 1H only → single alert tagged (1H); 4H row stored unmatched', async () => {
  const okx = fakeOkx({
    'H1-USDT': { '4H': nonmatchCandles(), '1H': matchCandles(), '5m': shortFixture() },
  });

  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(telegramSent.length, 1);
  assert.ok(telegramSent[0].includes('@1H'));

  assert.strictEqual((await rowsByTf('4H'))['H1-USDT'].matched, 0);
  assert.strictEqual((await rowsByTf('1H'))['H1-USDT'].matched, 1);
});

test('second scan with identical data sends no duplicate alert on either timeframe', async () => {
  const cfg = baseConfig();
  const okx = fakeOkx({
    'BOTH-USDT': { '4H': matchCandles(), '1H': matchCandles(), '5m': shortFixture() },
  });

  await runScan(cfg, { okx, telegram: telegramFake });
  assert.strictEqual(telegramSent.length, 2);

  await runScan(cfg, { okx, telegram: telegramFake });
  assert.strictEqual(telegramSent.length, 2, 'must not re-alert while still matching');
});

test('alert cleared per timeframe; re-match re-alerts only that timeframe', async () => {
  const cfg = baseConfig();
  const okxBoth = fakeOkx({
    'X-USDT': { '4H': matchCandles(), '1H': matchCandles(), '5m': shortFixture() },
  });
  const okxH1 = fakeOkx({
    'X-USDT': { '4H': nonmatchCandles(), '1H': matchCandles(), '5m': shortFixture() },
  });

  await runScan(cfg, { okx: okxBoth, telegram: telegramFake });
  assert.strictEqual(telegramSent.length, 2);
  assert.ok(await db.getAlert('X-USDT', '4H'));
  assert.ok(await db.getAlert('X-USDT', '1H'));

  // 4H stops matching → its alert is cleared; 1H keeps matching → stays silent.
  await runScan(cfg, { okx: okxH1, telegram: telegramFake });
  assert.strictEqual(telegramSent.length, 2, 'no new alert while 1H keeps matching');
  assert.strictEqual((await rowsByTf('4H'))['X-USDT'].matched, 0);
  assert.strictEqual(await db.getAlert('X-USDT', '4H'), undefined, '4H alert cleared on unmatch');
  assert.ok(await db.getAlert('X-USDT', '1H'), '1H alert kept');

  // 4H starts matching again → only 4H re-alerts (1H never duplicates).
  await runScan(cfg, { okx: okxBoth, telegram: telegramFake });
  assert.strictEqual(telegramSent.length, 3, 'new alert on 4H re-match only');
  assert.ok(telegramSent[2].includes('@4H'));
  assert.ok(!telegramSent[2].includes('@1H'));
});

test('short change series (5m) is fetched once per symbol even with two timeframes', async () => {
  const client = fakeOkx({
    'X-USDT': { '4H': matchCandles(), '1H': matchCandles(), '5m': shortFixture() },
  });

  await runScan(baseConfig(), { okx: client, telegram: telegramFake });

  assert.strictEqual(client.fetchedBars['X-USDT@5m'], 1, 'change series fetched once');
  assert.strictEqual(client.fetchedBars['X-USDT@4H'], 1);
  assert.strictEqual(client.fetchedBars['X-USDT@1H'], 1);
});

test('candle failure on one timeframe still processes the other timeframe', async () => {
  const okx = fakeOkx({
    'PART-USDT': { '4H': matchCandles(), '1H': matchCandles(), '5m': shortFixture() },
  }, { failBar: { 'PART-USDT': '1H' } });

  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);

  assert.ok((await rowsByTf('4H'))['PART-USDT'], '4H still scanned');
  assert.strictEqual((await rowsByTf('4H'))['PART-USDT'].matched, 1);
  assert.strictEqual((await rowsByTf('1H'))['PART-USDT'], undefined, '1H skipped');
  assert.strictEqual(telegramSent.length, 1);
  assert.ok(telegramSent[0].includes('@4H'));
});

test('change windows are null when the short series is too short', async () => {
  // Only 3 short bars: 5m window (1 bar back) is computable, the rest are null.
  const short3 = shortCandles().slice(0, 3); // closes 100, 100.25, 100.5
  const okx = fakeOkx({
    'SHORT-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': short3 },
  });

  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);

  const r = (await rowsByTf('4H'))['SHORT-USDT'];
  assert.ok(Math.abs(r.change_5m - 0.25) < 0.01, `change_5m=${r.change_5m}`);
  // 15m / 1h / 4h need more bars than available → null
  ['change_15m', 'change_1h', 'change_4h'].forEach((f) => {
    assert.strictEqual(r[f], null, `${f} should be null`);
  });
});

test('countSymbolsInLastCycle counts distinct symbols, not timeframe rows', async () => {
  const okx = fakeOkx({
    'A-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
    'B-USDT': { '4H': nonmatchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });

  await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(await db.countSymbolsInLastCycle(), 2, '2 symbols, though 4 rows exist');
});

test('liquidity filter excludes low-volume symbols before any candle request', async () => {
  const cfg = baseConfig();
  cfg.minVolumeUsd24h = 300000;
  const okx = fakeOkx(
    {
      'BIG-USDT': { '4H': matchCandles(), '1H': matchCandles(), '5m': shortFixture() },
      'SMALL-USDT': { '4H': matchCandles(), '1H': matchCandles(), '5m': shortFixture() },
    },
    { volumes: { 'BIG-USDT': 1e9, 'SMALL-USDT': 1000 } }
  );

  const res = await runScan(cfg, { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);

  assert.ok((await rowsByTf('4H'))['BIG-USDT'], 'big symbol scanned');
  assert.strictEqual((await rowsByTf('4H'))['SMALL-USDT'], undefined, 'small symbol excluded');
  assert.strictEqual(okx.fetched['SMALL-USDT'], undefined, 'no candle request for excluded symbol');
  assert.strictEqual(Number(await db.getState('last_cycle_total')), 2);
  assert.strictEqual(Number(await db.getState('last_cycle_after_filter')), 1);
});

test('live ticker price is stored per symbol and exposed by newestRows', async () => {
  const okx = fakeOkx(
    {
      'X-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
      'Y-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
    },
    { tickerLasts: { 'X-USDT': 111.5 } }
  );

  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);

  const rows = await db.newestRows();
  const x = rows.find((r) => r.symbol === 'X-USDT');
  const y = rows.find((r) => r.symbol === 'Y-USDT');
  assert.strictEqual(x.ticker_price, 111.5, 'live price stored from ticker');
  assert.strictEqual(y.ticker_price, null, 'no ticker last → null, not crash');
});

test('dry-run mode logs instead of sending and still dedups per timeframe', async () => {
  const cfg = baseConfig();
  cfg.dryRun = true;
  const okx = fakeOkx({
    'BOTH-USDT': { '4H': matchCandles(), '1H': matchCandles(), '5m': shortFixture() },
  });

  await runScan(cfg, { okx, telegram: telegramFake });
  assert.strictEqual(telegramSent.length, 0, 'nothing actually sent');
  assert.ok(await db.getAlert('BOTH-USDT', '4H'), 'dedup state still tracked (4H)');
  assert.ok(await db.getAlert('BOTH-USDT', '1H'), 'dedup state still tracked (1H)');

  await runScan(cfg, { okx, telegram: telegramFake });
  assert.strictEqual(telegramSent.length, 0);
});

test('instruments failure marks the cycle as error without crashing', async () => {
  const okx = {
    getUsdtInstruments: async () => {
      throw new Error('instruments endpoint unreachable');
    },
    getCandles: async () => [],
  };
  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(await db.getState('status'), 'error');
  assert.ok((await db.getState('last_error')).includes('instruments endpoint unreachable'));
});

test('symbol-less cycle still records 0 symbols cleanly', async () => {
  const okx = fakeOkx({});
  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(Number(await db.getState('last_scan_count')), 0);
  assert.strictEqual(await db.getState('status'), 'idle');
});

test('legacy alerts table (symbol-only PK) migrates to (symbol, timeframe) without losing rows', async () => {
  db.close();
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(process.env.DB_PATH);
  raw.exec('DROP TABLE IF EXISTS alerts;');
  raw.exec(`
    CREATE TABLE alerts (
      symbol      TEXT PRIMARY KEY,
      detected_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
  `);
  raw.prepare('INSERT INTO alerts (symbol, detected_at, last_seen_at) VALUES (?, ?, ?)')
    .run('BTC-USDT', 111, 222);
  raw.close();

  await db.init();
  const migrated = await db.getAlert('BTC-USDT', '4H');
  assert.strictEqual(migrated.detected_at, 111, 'legacy row migrated as 4H');
  assert.strictEqual(migrated.sent, 1, 'legacy rows treated as already sent');
  assert.strictEqual(migrated.cross_ts, null, 'legacy rows have no cross_ts → dashboard falls back to detected_at');
  assert.strictEqual(migrated.cross_price, null, 'legacy rows have no cross_price → dashboard shows —');
  assert.strictEqual(await db.getAlert('BTC-USDT', '1H'), undefined);
});

test('last_candle_ts stores the timestamp of the match candle itself', async () => {
  // matchCandles(): 120 candles, all closed, ts = 1000 + i*900 → last = 108100.
  const okx = fakeOkx({
    'X-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });

  await runScan(baseConfig(), { okx, telegram: telegramFake });

  const r = (await rowsByTf('4H'))['X-USDT'];
  assert.strictEqual(r.matched, 1);
  assert.strictEqual(r.last_candle_ts, 108100, 'candle ts of the crossover row, not scan time');
  assert.ok(r.scan_at > 0, 'scan_at exposed so the dashboard can show scan age');
  assert.strictEqual(r.cross_ts, 108100, 'cross_ts = the detection candle, exposed to the dashboard');
  assert.ok(Math.abs(r.cross_price - 189.2622499) < 1e-6, 'cross_price = interpolated EMA cross price, exposed to the dashboard');

  // The same cross price must be stored on the SCANS row too, so the history
  // tab keeps the real signal price after the alert is deleted.
  const hist = await db.signalHistory({ sinceMs: 0, timeframe: null, limit: 10 });
  assert.strictEqual(hist.length, 1, 'one historical episode for the matched row');
  assert.ok(Math.abs(hist[0].cross_price - 189.2622499) < 1e-6, 'cross_price stored on scans for history');
});

test('detection time is recorded even when Telegram delivery fails, then retried', async () => {
  const cfg = baseConfig();
  const okx = fakeOkx({
    'X-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });

  // Cycle 1: message fails to deliver → detection is still recorded (sent=0).
  telegramOk = false;
  await runScan(cfg, { okx, telegram: flakyTelegram });
  assert.strictEqual(telegramCalls, 1, 'send attempted once');
  const first = await db.getAlert('X-USDT', '4H');
  assert.ok(first, 'detection recorded despite failed delivery');
  assert.strictEqual(first.sent, 0, 'flagged for retry');
  assert.strictEqual(first.detected_at > 0, true, 'detected_at populated');
  assert.strictEqual(first.cross_ts, 108100, 'detection candle ts stored on first match');
  assert.ok(Math.abs(first.cross_price - 189.2622499) < 1e-6, 'signal price stored on first match');
  assert.ok((await rowsByTf('4H'))['X-USDT'].detected_at, 'dashboard row exposes detected_at');

  // Cycle 2: same signal, delivery now succeeds → retried, still one detection.
  telegramOk = true;
  await runScan(cfg, { okx, telegram: flakyTelegram });
  assert.strictEqual(telegramCalls, 2, 'retried once');
  const second = await db.getAlert('X-USDT', '4H');
  assert.strictEqual(second.sent, 1, 'delivered on retry');
  assert.strictEqual(second.detected_at, first.detected_at, 'first detection time preserved');
  assert.strictEqual(second.cross_ts, first.cross_ts, 'cross_ts preserved across retry');
  assert.strictEqual(second.cross_price, first.cross_price, 'cross_price preserved across retry');

  // Cycle 3: still matching + delivered → fully deduped, no further sends.
  await runScan(cfg, { okx, telegram: flakyTelegram });
  assert.strictEqual(telegramCalls, 2, 'no extra send while still matching');
});

test('cross_price is backfilled for alerts created before the column existed', async () => {
  const cfg = baseConfig();
  const okx = fakeOkx({
    'X-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });

  // Pre-existing alert (as if created before cross_price existed) → null.
  await db.insertAlert('X-USDT', '4H', Date.now() - 3600e3, Date.now() - 3600e3, 1, 108100, null);
  assert.strictEqual((await db.getAlert('X-USDT', '4H')).cross_price, null);

  // Still matching → next scan backfills the interpolated cross price.
  await runScan(cfg, { okx, telegram: telegramFake });
  assert.ok(Math.abs((await db.getAlert('X-USDT', '4H')).cross_price - 189.2622499) < 1e-6, 'cross_price backfilled from candles');
});

test('lastCrossIndex finds crossover even when it happened many candles ago', async () => {
  const { lastCrossIndex } = require('../src/indicators');

  // Simulate: fast crossed above slow at index 50, then stayed above.
  const n = 120;
  const fast = new Array(n).fill(null);
  const slow = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i < 20) { fast[i] = 90; slow[i] = 100; }       // fast below slow
    else if (i < 50) { fast[i] = 95; slow[i] = 100; }   // fast still below
    else if (i === 50) { fast[i] = 101; slow[i] = 100; } // CROSS at index 50
    else { fast[i] = 105; slow[i] = 100; }               // fast stays above
  }

  const idx = lastCrossIndex(fast, slow);
  assert.strictEqual(idx, 50, 'finds crossover at index 50, not the last pair');

  // crossedAbove would return false here (last pair: both above, no new cross)
  const { crossedAbove } = require('../src/indicators');
  assert.strictEqual(crossedAbove(fast, slow), false, 'crossedAbove misses old cross');
});

test('lastCrossIndex returns -1 when no crossover exists', () => {
  const { lastCrossIndex } = require('../src/indicators');

  // Fast always above slow → no crossover
  const fast = [90, 91, 92, 93, 94];
  const slow = [80, 81, 82, 83, 84];
  assert.strictEqual(lastCrossIndex(fast, slow), -1);

  // Fast always below slow → no crossover
  assert.strictEqual(lastCrossIndex([80, 81, 82], [90, 91, 92]), -1);

  // Too few elements
  assert.strictEqual(lastCrossIndex([1], [1]), -1);
  assert.strictEqual(lastCrossIndex([], []), -1);
});

test('lastCrossIndex returns the LATEST crossover when multiple exist', () => {
  const { lastCrossIndex } = require('../src/indicators');

  // Cross at index 2 (up), then back down at 4, then cross again at 6
  const fast = [80, 85, 95, 90, 85, 88, 95, 96];
  const slow = [90, 90, 90, 90, 90, 90, 90, 90];
  // Index 0: fast=80 < slow=90
  // Index 1: fast=85 < slow=90
  // Index 2: fast=95 > slow=90, prev=85 <= 90 → CROSS at 2
  // Index 3: fast=90 == slow=90
  // Index 4: fast=85 < slow=90
  // Index 5: fast=88 < slow=90
  // Index 6: fast=95 > slow=90, prev=88 <= 90 → CROSS at 6

  assert.strictEqual(lastCrossIndex(fast, slow), 6, 'returns the latest cross, not the first');
});

test('scanner ignores crossover that is not on the last closed candle (Test 2: old cross → no signal)', async () => {
  // Build candle data where EMA cross happened at candle ~114 (a few candles
  // BEFORE the last closed candle). Gentle oscillation keeps RSI in range.
  // Under the corrected rule this must NOT be a signal.
  const closes = [];
  for (let i = 0; i < 120; i++) {
    if (i < 90) closes.push(100 + Math.sin(i * 0.3) * 2);       // sideways ~98-102
    else if (i < 108) closes.push(100 - (i - 90) * 0.15);       // decline to ~97.3
    else if (i >= 108 && i < 116) closes.push(97.3 + (i - 108) * 0.4);  // very gentle rise (cross here)
    else if (i % 3 === 0) closes.push(100.5 + (i - 116) * 0.05);  // oscillation after cross
    else if (i % 3 === 1) closes.push(100.5 + (i - 116) * 0.05 - 0.5);
    else closes.push(100.5 + (i - 116) * 0.05 + 0.1);
  }
  const vols = closes.map(() => 100);
  vols[114] = 500; // volume spike on cross candle

  const candles = closes.map((c, i) => ({
    ts: 1000 + i * 3600,
    open: c, high: c * 1.001, low: c * 0.999, close: c,
    volume: vols[i], confirm: 1,
  }));

  const okx = fakeOkx({
    'LATE-USDT': { '4H': candles, '1H': candles, '5m': shortFixture() },
  });

  const cfg = baseConfig();
  const res = await runScan(cfg, { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);

  const r = (await rowsByTf('4H'))['LATE-USDT'];
  assert.ok(r, 'row stored for late-cross symbol');
  assert.strictEqual(r.ema_cross, 0, 'cross a few candles ago is NOT a crossover signal now');
  assert.strictEqual(r.matched, 0, 'old cross → no match (cross must be on the last closed candle)');
  assert.ok(r.cross_ts == null, 'no alert cross_ts — no alert created for an old cross');
});

test('Telegram alert shows RSI of the signal candle (the last closed candle)', async () => {
  // With cross-only-on-last-candle detection, the signal candle IS the last
  // closed candle — so the alert RSI must equal that candle's RSI (the value
  // the match decision was based on), within rsiMin..rsiMax.
  const okx = fakeOkx({
    'LATE-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });

  // Capture the RSI value passed to formatAlert.
  const captured = [];
  const tg = {
    formatAlert: (instId, price, rsv, tf, crossPrice) => {
      captured.push({ rsv, tf, crossPrice });
      return `[${instId}@${tf}]`;
    },
    sendMessage: async () => true,
  };

  const cfg = baseConfig();
  const res = await runScan(cfg, { okx, telegram: tg });
  assert.strictEqual(res.ok, true);

  const hit = captured.find((c) => c.tf === '4H');
  assert.ok(hit, '4H alert sent');
  const { rsv } = hit;
  assert.ok(rsv != null, 'RSI value passed to formatAlert');
  assert.ok(rsv >= cfg.rsiMin && rsv <= cfg.rsiMax, `alert RSI (${rsv}) within [${cfg.rsiMin}, ${cfg.rsiMax}] — same condition as the match`);

  // The displayed RSI must be the RSI of the LAST closed candle (= signal candle).
  const { ema, rsi: rsiFn, crossedAbove } = require('../src/indicators');
  const closes = matchCloses;
  const fast = ema(closes, cfg.emaFast);
  const slow = ema(closes, cfg.emaSlow);
  assert.strictEqual(crossedAbove(fast, slow), true, 'fixture crosses on the last closed candle');
  const series = rsiFn(closes, cfg.rsiPeriod);
  const signalRsi = series[series.length - 1];
  assert.strictEqual(rsv, signalRsi, 'alert shows the signal (last closed) candle RSI');
});

test('scanner ignores crossover beyond maxLookback of 10 candles', async () => {
  // Cross happened at candle 100 (20 candles ago, beyond lookback).
  // Scanner should NOT match.
  const closes = [];
  for (let i = 0; i < 120; i++) {
    if (i < 80) closes.push(100 + Math.sin(i * 0.3) * 2);
    else if (i < 100) closes.push(100 - (i - 80) * 0.3);
    else if (i === 100) closes.push(94 + 7);                     // spike at 100
    else if (i % 2 === 0) closes.push(102 + (i - 100) * 0.15);  // oscillation
    else closes.push(102 + (i - 100) * 0.15 - 0.8);
  }
  const vols = closes.map(() => 100);
  vols[119] = 500;

  const candles = closes.map((c, i) => ({
    ts: 1000 + i * 3600,
    open: c, high: c * 1.001, low: c * 0.999, close: c,
    volume: vols[i], confirm: 1,
  }));

  const okx = fakeOkx({
    'OLD-USDT': { '4H': candles, '1H': candles, '5m': shortFixture() },
  });

  const cfg = baseConfig();
  const res = await runScan(cfg, { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);

  const r = (await rowsByTf('4H'))['OLD-USDT'];
  assert.ok(r, 'row stored');
  assert.strictEqual(r.matched, 0, 'cross beyond lookback window is ignored');
});

test('Telegram message includes crossover price when different from current price', async () => {
  const sent = [];
  const tg = {
    formatAlert: (instId, price, rsv, tf, crossPrice) => {
      sent.push({ instId, price, rsv, tf, crossPrice });
      return `[${instId}@${tf}] price=${price} cross=${crossPrice}`;
    },
    sendMessage: async () => true,
  };

  const okx = fakeOkx({
    'X-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });

  await runScan(baseConfig(), { okx, telegram: tg });
  assert.strictEqual(sent.length, 1);
  // crossPrice should be passed to formatAlert
  assert.ok(sent[0].crossPrice != null, 'crossPrice is passed to formatAlert');
});

test('Telegram message omits cross price line when crossPrice equals current price', () => {
  const { formatAlert } = require('../src/telegram');

  // Same price → no cross price line
  const msg1 = formatAlert('BTC-USDT', 100, 55, '4H', 100);
  assert.ok(!msg1.includes('سعر التقاطع'), 'no cross price line when prices match');

  // Different price → cross price line shown
  const msg2 = formatAlert('BTC-USDT', 105, 55, '4H', 100);
  assert.ok(msg2.includes('سعر التقاطع: 100'), 'cross price line shown when different');
  assert.ok(msg2.includes('السعر: 105'), 'current price still shown');
});

// --- Higher Timeframe Context (HTF) tests ---

/** Build daily candles: 60 candles with steady uptrend for high RSI + large EMA distance. */
function dailyCandlesHighRsi(startPrice, growthPerCandle) {
  const closes = [];
  for (let i = 0; i < 60; i++) {
    closes.push(startPrice + i * growthPerCandle);
  }
  return closes.map((c, i) => ({
    ts: Date.now() - (60 - i) * 86400000,
    open: c * 0.998,
    high: c * 1.005,
    low: c * 0.995,
    close: c,
    volume: 1000,
    confirm: 1,
  }));
}

/** Build daily candles with a flat base then a sharp spike → high EMA distance. */
function dailyCandlesSpike(basePrice, spikeTarget) {
  const closes = [];
  for (let i = 0; i < 60; i++) {
    if (i < 40) closes.push(basePrice);
    else closes.push(basePrice + (spikeTarget - basePrice) * ((i - 39) / 20));
  }
  return closes.map((c, i) => ({
    ts: Date.now() - (60 - i) * 86400000,
    open: c * 0.998,
    high: c * 1.005,
    low: c * 0.995,
    close: c,
    volume: 1000,
    confirm: 1,
  }));
}

/** Build daily candles: 60 candles with flat/slightly up trend for normal RSI. */
function dailyCandlesNormal(startPrice) {
  const closes = [];
  for (let i = 0; i < 60; i++) {
    closes.push(startPrice + Math.sin(i * 0.2) * 2);
  }
  return closes.map((c, i) => ({
    ts: Date.now() - (60 - i) * 86400000,
    open: c * 0.998,
    high: c * 1.005,
    low: c * 0.995,
    close: c,
    volume: 1000,
    confirm: 1,
  }));
}

test('higherTfWarning set when daily RSI >= 70', async () => {
  const tgCaptured = [];
  const tg = {
    formatAlert: (instId, price, rsv, tf, crossPrice, higherTfWarning) => {
      tgCaptured.push({ instId, tf, higherTfWarning });
      return `[${instId}@${tf}]`;
    },
    sendMessage: async () => true,
  };

  // Steep daily uptrend → RSI will be well above 70
  const dailyHigh = dailyCandlesHighRsi(100, 2);

  const okx = fakeOkx({
    'WARN-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '1D': dailyHigh, '5m': shortFixture() },
  });

  const cfg = baseConfig();
  const res = await runScan(cfg, { okx, telegram: tg });
  assert.strictEqual(res.ok, true);

  const r = (await rowsByTf('4H'))['WARN-USDT'];
  assert.ok(r, 'row stored');
  assert.ok(r.higher_tf_warning != null, 'higherTfWarning is set');
  assert.ok(r.higher_tf_warning.includes('تشبع شرائي يومي'), 'warning mentions overbought');
  assert.ok(r.higher_tf_warning.includes('RSI:'), 'warning includes RSI value');

  const alert = tgCaptured.find((c) => c.tf === '4H');
  assert.ok(alert, '4H alert sent');
  assert.ok(alert.higherTfWarning != null, 'higherTfWarning passed to formatAlert');
  assert.ok(alert.higherTfWarning.includes('تشبع شرائي يومي'), 'telegram warning includes overbought');
});

test('higherTfWarning set when daily distance > 25% from EMA21', async () => {
  const tgCaptured = [];
  const tg = {
    formatAlert: (instId, price, rsv, tf, crossPrice, higherTfWarning) => {
      tgCaptured.push({ instId, tf, higherTfWarning });
      return `[${instId}@${tf}]`;
    },
    sendMessage: async () => true,
  };

  // Flat then spike → price far above EMA21
  const dailySpike = dailyCandlesSpike(50, 300);

  const okx = fakeOkx({
    'DIST-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '1D': dailySpike, '5m': shortFixture() },
  });

  const cfg = baseConfig();
  const res = await runScan(cfg, { okx, telegram: tg });
  assert.strictEqual(res.ok, true);

  const r = (await rowsByTf('4H'))['DIST-USDT'];
  assert.ok(r, 'row stored');
  assert.ok(r.higher_tf_warning != null, 'higherTfWarning is set');
  assert.ok(r.higher_tf_warning.includes('امتداد'), 'warning mentions distance');
});

test('higherTfWarning is null when daily conditions are normal', async () => {
  const tgCaptured = [];
  const tg = {
    formatAlert: (instId, price, rsv, tf, crossPrice, higherTfWarning) => {
      tgCaptured.push({ instId, tf, higherTfWarning });
      return `[${instId}@${tf}]`;
    },
    sendMessage: async () => true,
  };

  // Flat daily trend → normal RSI, small distance from EMA21
  const dailyNormal = dailyCandlesNormal(100);

  const okx = fakeOkx({
    'SAFE-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '1D': dailyNormal, '5m': shortFixture() },
  });

  const cfg = baseConfig();
  const res = await runScan(cfg, { okx, telegram: tg });
  assert.strictEqual(res.ok, true);

  const r = (await rowsByTf('4H'))['SAFE-USDT'];
  assert.ok(r, 'row stored');
  assert.strictEqual(r.higher_tf_warning, null, 'no warning for normal daily');

  const alert = tgCaptured.find((c) => c.tf === '4H');
  assert.ok(alert, '4H alert sent');
  assert.strictEqual(alert.higherTfWarning, null, 'no warning in telegram message');
});

test('higherTfWarning gracefully skipped when 1D candles fetch fails', async () => {
  const okx = fakeOkx(
    {
      'FAIL-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
    },
    { failBar: { 'FAIL-USDT': '1D' } }
  );

  const cfg = baseConfig();
  const res = await runScan(cfg, { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);

  const r = (await rowsByTf('4H'))['FAIL-USDT'];
  assert.ok(r, 'row stored despite 1D failure');
  assert.strictEqual(r.matched, 1, 'still matched');
  assert.strictEqual(r.higher_tf_warning, null, 'no warning when 1D fetch fails');
});

test('Telegram message includes warning line when higherTfWarning is set', () => {
  const { formatAlert } = require('../src/telegram');

  const msg = formatAlert('BTC-USDT', 100, 55, '4H', 95, 'تشبع شرائي يومي (RSI: 78) + امتداد +42% عن المتوسط اليومي');
  assert.ok(msg.includes('⚠️ تحذير:'), 'warning line present');
  assert.ok(msg.includes('تشبع شرائي يومي (RSI: 78)'), 'warning details present');
  assert.ok(msg.includes('امتداد +42%'), 'distance info present');

  const msgNoWarn = formatAlert('BTC-USDT', 100, 55, '4H', 95, null);
  assert.ok(!msgNoWarn.includes('⚠️ تحذير:'), 'no warning line when null');
});

test('higherTfWarning stored in DB and returned by newestRows', async () => {
  const dailyHigh = dailyCandlesHighRsi(100, 2);

  const okx = fakeOkx({
    'DBWARN-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '1D': dailyHigh, '5m': shortFixture() },
  });

  const cfg = baseConfig();
  await runScan(cfg, { okx, telegram: telegramFake });

  const r = (await rowsByTf('4H'))['DBWARN-USDT'];
  assert.ok(r, 'row stored');
  assert.ok(typeof r.higher_tf_warning === 'string', 'higher_tf_warning is a string in DB');
  assert.ok(r.higher_tf_warning.length > 0, 'higher_tf_warning is non-empty');
});

test('ASTER scenario: match -> unmatch -> re-match gets new cross_ts', async () => {
  // Step 1: initial match with cross at index 114 (default matchCandles)
  const okx1 = fakeOkx({
    'ASTER-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });
  await runScan(baseConfig(), { okx: okx1, telegram: telegramFake });
  const alert1 = await db.getAlert('ASTER-USDT', '4H');
  assert.ok(alert1, 'alert created on first match');
  const firstCrossTs = alert1.cross_ts;
  assert.ok(firstCrossTs != null, 'first cross_ts set');

  // Step 2: no match -> alert should be deleted
  const okx2 = fakeOkx({
    'ASTER-USDT': { '4H': nonmatchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });
  await runScan(baseConfig(), { okx: okx2, telegram: telegramFake });
  assert.strictEqual(await db.getAlert('ASTER-USDT', '4H'), undefined, 'alert deleted on unmatch');

  // Step 3: re-match with different candles (offset time slightly) -> new alert with new cross_ts
  const closes = matchCloses.slice();
  const vols = closes.map(() => 100);
  vols[vols.length - 1] = 1000;
  const newCandles = closes.map((c, i) => ({
    ts: 5000 + i * 900, // different base timestamp
    open: c, high: c * 1.001, low: c * 0.999, close: c,
    volume: vols[i], confirm: 1,
  }));

  const { ema: emaFn, crossedAbove: crossedAboveFn } = require('../src/indicators');
  const closes3 = newCandles.map(c => c.close);
  const fast3 = emaFn(closes3, baseConfig().emaFast);
  const slow3 = emaFn(closes3, baseConfig().emaSlow);
  assert.strictEqual(crossedAboveFn(fast3, slow3), true, 'fixture crosses on its last closed candle');

  const okx3 = fakeOkx({
    'ASTER-USDT': { '4H': newCandles, '1H': nonmatchCandles(), '5m': shortFixture() },
  });
  await runScan(baseConfig(), { okx: okx3, telegram: telegramFake });
  const alert3 = await db.getAlert('ASTER-USDT', '4H');
  assert.ok(alert3, 'alert re-created on re-match');
  assert.notStrictEqual(alert3.cross_ts, firstCrossTs, 'new cross_ts is different from original');
  assert.strictEqual(alert3.cross_ts, newCandles[newCandles.length - 1].ts, 'cross_ts = last closed candle (the cross candle)');
});

// ===================== Signal Engine correctness =====================

test('Test 1: genuine cross ON the last closed candle → signal = true', async () => {
  const { ema, crossedAbove } = require('../src/indicators');
  const cfg = baseConfig();

  const closes = matchCloses;
  const fast = ema(closes, cfg.emaFast);
  const slow = ema(closes, cfg.emaSlow);
  const n = closes.length;

  // Previous closed candle: EMA9 <= EMA21. Current: EMA9 > EMA21.
  assert.ok(fast[n - 1] > slow[n - 1], 'current: EMA9 > EMA21');
  assert.ok(fast[n - 2] <= slow[n - 2], 'previous: EMA9 <= EMA21');
  assert.strictEqual(crossedAbove(fast, slow), true, 'cross detected on last pair');

  // The same series truncated one candle earlier must NOT be a signal.
  const fastPrev = ema(closes.slice(0, n - 1), cfg.emaFast);
  const slowPrev = ema(closes.slice(0, n - 1), cfg.emaSlow);
  assert.strictEqual(crossedAbove(fastPrev, slowPrev), false, 'no cross one candle earlier');

  // End-to-end: scanner stores ema_cross=1 and matched=1.
  const okx = fakeOkx({
    'SIG-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });
  const res = await runScan(cfg, { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);
  const r = (await rowsByTf('4H'))['SIG-USDT'];
  assert.ok(r, 'row stored');
  assert.strictEqual(r.ema_cross, 1, 'cross on last closed candle → ema_cross = 1');
  assert.strictEqual(r.matched, 1, 'full conditions met → matched = 1');
});

test('Test 3: signal volume 1500 > previous-20 average 1000 → volume_ok = true (scanner)', async () => {
  // matchCloses crosses on the last candle with RSI in range.
  // Previous 20 volumes = 100 each (avg 100); signal volume = 1500.
  const vols = matchCloses.map(() => 100);
  vols[vols.length - 1] = 1500;
  const candles = matchCloses.map((c, i) => ({
    ts: 1000 + i * 900,
    open: c, high: c * 1.001, low: c * 0.999, close: c,
    volume: vols[i], confirm: 1,
  }));

  const okx = fakeOkx({
    'VOL-USDT': { '4H': candles, '1H': nonmatchCandles(), '5m': shortFixture() },
  });
  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);
  const r = (await rowsByTf('4H'))['VOL-USDT'];
  assert.ok(r, 'row stored');
  assert.strictEqual(r.ema_cross, 1, 'cross on last candle');
  assert.strictEqual(r.volume_ok, 1, '1500 > avg(previous 20) = 100');
  assert.strictEqual(r.matched, 1, 'signal matches');
});

test('Test 4: volume reference excludes the signal candle itself (scanner discriminator)', async () => {
  // Craft volumes where the OLD window (t-19..t, including the signal candle)
  // gives a different answer than the CORRECT window (t-20..t-1):
  //   v[t-20] = 2000, v[t-19..t-1] sum = 28000, v[t] = 1500
  //   correct ref = mean(t-20..t-1) = 30000/20 = 1500 → 1500 > 1500 = FALSE
  //   old window  = mean(t-19..t)  = 29500/20 = 1475 → 1500 > 1475 = TRUE (wrong)
  const n = matchCloses.length; // 120, cross on last candle (t = 119)
  const t = n - 1;
  const vols = new Array(n);
  vols[t - 20] = 2000;
  for (let i = t - 19; i < t; i++) vols[i] = 28000 / 19;
  for (let i = 0; i < t - 20; i++) vols[i] = 100;
  vols[t] = 1500;

  const candles = matchCloses.map((c, i) => ({
    ts: 1000 + i * 900,
    open: c, high: c * 1.001, low: c * 0.999, close: c,
    volume: vols[i], confirm: 1,
  }));

  const okx = fakeOkx({
    'SELFVOL-USDT': { '4H': candles, '1H': nonmatchCandles(), '5m': shortFixture() },
  });
  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);
  const r = (await rowsByTf('4H'))['SELFVOL-USDT'];
  assert.ok(r, 'row stored');
  assert.strictEqual(r.ema_cross, 1, 'cross exists on the last candle');
  assert.ok(r.rsi >= 45 && r.rsi <= 65, `RSI in range (rsi=${r.rsi}) — volume is the only blocker`);
  assert.strictEqual(r.volume_ok, 0,
    'signal volume NOT > previous-20 avg (window must be t-20..t-1, excluding the signal candle)');
  assert.strictEqual(r.matched, 0, 'volume filter blocks the signal');
});

test('Test 5: future data cannot change the signal (forming candles with extreme volumes are ignored)', async () => {
  // Run A: normal matchCandles.
  const okxA = fakeOkx({
    'FUT-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });
  const resA = await runScan(baseConfig(), { okx: okxA, telegram: telegramFake });
  assert.strictEqual(resA.ok, true);
  const rA = (await rowsByTf('4H'))['FUT-USDT'];
  assert.ok(rA, 'row A stored');
  assert.strictEqual(rA.matched, 1, 'Run A matches');

  // Run B: identical closed candles + extra FORMING (confirm=0) candles with
  // absurd volumes after the signal candle. They are not closed → they must
  // not enter any indicator or the volume window.
  const withFuture = matchCandles().concat([
    { ts: 999900, open: 1, high: 1, low: 1, close: 1, volume: 999999999, confirm: 0 },
    { ts: 999990, open: 1, high: 1, low: 1, close: 1, volume: 1, confirm: 0 },
  ]);
  const okxB = fakeOkx({
    'FUT-USDT': { '4H': withFuture, '1H': nonmatchCandles(), '5m': shortFixture() },
  });
  const resB = await runScan(baseConfig(), { okx: okxB, telegram: telegramFake });
  assert.strictEqual(resB.ok, true);
  const rB = (await rowsByTf('4H'))['FUT-USDT'];
  assert.ok(rB, 'row B stored');

  assert.strictEqual(rB.matched, rA.matched, 'matched unchanged by future forming candles');
  assert.strictEqual(rB.ema_cross, rA.ema_cross, 'ema_cross unchanged');
  assert.strictEqual(rB.volume_ok, rA.volume_ok, 'volume_ok unchanged by future volumes');
  assert.strictEqual(rB.rsi, rA.rsi, 'RSI unchanged');
});
