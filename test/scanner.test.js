'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

// Unique temp DB per test-run so we never touch the real data folder.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emarsi-scan-'));
process.env.DB_PATH = path.join(tmpDir, 'scanner.db');

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

before(() => {
  db.init();
});

beforeEach(() => {
  telegramSent = [];
  telegramCalls = 0;
  telegramOk = true;
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.DB_PATH = path.join(tmpDir, 'scanner.db');
  db.init();
});

after(() => {
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

function rowsByTf(tf) {
  const rows = db.newestRows(tf);
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

  const r4 = rowsByTf('4H')['BOTH-USDT'];
  const r1 = rowsByTf('1H')['BOTH-USDT'];
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
  assert.strictEqual(db.getState('status'), 'idle');
  assert.strictEqual(Number(db.getState('last_scan_count')), 2);
  assert.strictEqual(Number(db.getState('last_scan_matched')), 2);
});

test('match on 4H only → single alert tagged (4H); 1H row stored unmatched', async () => {
  const okx = fakeOkx({
    'H4-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });

  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(telegramSent.length, 1);
  assert.ok(telegramSent[0].includes('@4H'));

  assert.strictEqual(rowsByTf('4H')['H4-USDT'].matched, 1);
  assert.strictEqual(rowsByTf('1H')['H4-USDT'].matched, 0);
});

test('match on 1H only → single alert tagged (1H); 4H row stored unmatched', async () => {
  const okx = fakeOkx({
    'H1-USDT': { '4H': nonmatchCandles(), '1H': matchCandles(), '5m': shortFixture() },
  });

  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(telegramSent.length, 1);
  assert.ok(telegramSent[0].includes('@1H'));

  assert.strictEqual(rowsByTf('4H')['H1-USDT'].matched, 0);
  assert.strictEqual(rowsByTf('1H')['H1-USDT'].matched, 1);
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
  assert.ok(db.getAlert('X-USDT', '4H'));
  assert.ok(db.getAlert('X-USDT', '1H'));

  // 4H stops matching → its alert is cleared; 1H keeps matching → stays silent.
  await runScan(cfg, { okx: okxH1, telegram: telegramFake });
  assert.strictEqual(telegramSent.length, 2, 'no new alert while 1H keeps matching');
  assert.strictEqual(rowsByTf('4H')['X-USDT'].matched, 0);
  assert.strictEqual(db.getAlert('X-USDT', '4H'), undefined, '4H alert cleared on unmatch');
  assert.ok(db.getAlert('X-USDT', '1H'), '1H alert kept');

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

  assert.ok(rowsByTf('4H')['PART-USDT'], '4H still scanned');
  assert.strictEqual(rowsByTf('4H')['PART-USDT'].matched, 1);
  assert.strictEqual(rowsByTf('1H')['PART-USDT'], undefined, '1H skipped');
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

  const r = rowsByTf('4H')['SHORT-USDT'];
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
  assert.strictEqual(db.countSymbolsInLastCycle(), 2, '2 symbols, though 4 rows exist');
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

  assert.ok(rowsByTf('4H')['BIG-USDT'], 'big symbol scanned');
  assert.strictEqual(rowsByTf('4H')['SMALL-USDT'], undefined, 'small symbol excluded');
  assert.strictEqual(okx.fetched['SMALL-USDT'], undefined, 'no candle request for excluded symbol');
  assert.strictEqual(Number(db.getState('last_cycle_total')), 2);
  assert.strictEqual(Number(db.getState('last_cycle_after_filter')), 1);
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

  const rows = db.newestRows();
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
  assert.ok(db.getAlert('BOTH-USDT', '4H'), 'dedup state still tracked (4H)');
  assert.ok(db.getAlert('BOTH-USDT', '1H'), 'dedup state still tracked (1H)');

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
  assert.strictEqual(db.getState('status'), 'error');
  assert.ok(db.getState('last_error').includes('instruments endpoint unreachable'));
});

test('symbol-less cycle still records 0 symbols cleanly', async () => {
  const okx = fakeOkx({});
  const res = await runScan(baseConfig(), { okx, telegram: telegramFake });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(Number(db.getState('last_scan_count')), 0);
  assert.strictEqual(db.getState('status'), 'idle');
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

  db.init();
  const migrated = db.getAlert('BTC-USDT', '4H');
  assert.strictEqual(migrated.detected_at, 111, 'legacy row migrated as 4H');
  assert.strictEqual(migrated.sent, 1, 'legacy rows treated as already sent');
  assert.strictEqual(migrated.cross_ts, null, 'legacy rows have no cross_ts → dashboard falls back to detected_at');
  assert.strictEqual(migrated.cross_price, null, 'legacy rows have no cross_price → dashboard shows —');
  assert.strictEqual(db.getAlert('BTC-USDT', '1H'), undefined);
});

test('last_candle_ts stores the timestamp of the match candle itself', async () => {
  // matchCandles(): 120 candles, all closed, ts = 1000 + i*900 → last = 108100.
  const okx = fakeOkx({
    'X-USDT': { '4H': matchCandles(), '1H': nonmatchCandles(), '5m': shortFixture() },
  });

  await runScan(baseConfig(), { okx, telegram: telegramFake });

  const r = rowsByTf('4H')['X-USDT'];
  assert.strictEqual(r.matched, 1);
  assert.strictEqual(r.last_candle_ts, 108100, 'candle ts of the crossover row, not scan time');
  assert.ok(r.scan_at > 0, 'scan_at exposed so the dashboard can show scan age');
  assert.strictEqual(r.cross_ts, 108100, 'cross_ts = the detection candle, exposed to the dashboard');
  assert.ok(Math.abs(r.cross_price - 189.2622499) < 1e-6, 'cross_price = interpolated EMA cross price, exposed to the dashboard');
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
  const first = db.getAlert('X-USDT', '4H');
  assert.ok(first, 'detection recorded despite failed delivery');
  assert.strictEqual(first.sent, 0, 'flagged for retry');
  assert.strictEqual(first.detected_at > 0, true, 'detected_at populated');
  assert.strictEqual(first.cross_ts, 108100, 'detection candle ts stored on first match');
  assert.ok(Math.abs(first.cross_price - 189.2622499) < 1e-6, 'signal price stored on first match');
  assert.ok(rowsByTf('4H')['X-USDT'].detected_at, 'dashboard row exposes detected_at');

  // Cycle 2: same signal, delivery now succeeds → retried, still one detection.
  telegramOk = true;
  await runScan(cfg, { okx, telegram: flakyTelegram });
  assert.strictEqual(telegramCalls, 2, 'retried once');
  const second = db.getAlert('X-USDT', '4H');
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
  db.insertAlert('X-USDT', '4H', Date.now() - 3600e3, Date.now() - 3600e3, 1, 108100, null);
  assert.strictEqual(db.getAlert('X-USDT', '4H').cross_price, null);

  // Still matching → next scan backfills the interpolated cross price.
  await runScan(cfg, { okx, telegram: telegramFake });
  assert.ok(Math.abs(db.getAlert('X-USDT', '4H').cross_price - 189.2622499) < 1e-6, 'cross_price backfilled from candles');
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

test('scanner detects crossover within lookback window but not on last pair', async () => {
  // Build candle data where EMA cross happened at candle ~113 (within 10-candle
  // lookback but NOT on the last pair). Gentle oscillation keeps RSI in range.
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

  const r = rowsByTf('4H')['LATE-USDT'];
  assert.ok(r, 'row stored for late-cross symbol');
  assert.strictEqual(r.matched, 1, 'detected the cross within lookback window');

  // cross_ts should point to the actual cross candle, not the last candle
  assert.ok(r.last_candle_ts > r.cross_ts, 'cross_ts is earlier than last_candle_ts');
});

test('Telegram alert shows cross-candle RSI (the one that satisfied rsiMin..rsiMax)', async () => {
  // Same late-cross data as above: cross at index 114 where RSI is in range,
  // while the CURRENT (last candle) RSI differs. The alert must show the
  // cross-candle RSI — the value the match decision was actually based on.
  const closes = [];
  for (let i = 0; i < 120; i++) {
    if (i < 90) closes.push(100 + Math.sin(i * 0.3) * 2);
    else if (i < 108) closes.push(100 - (i - 90) * 0.15);
    else if (i >= 108 && i < 116) closes.push(97.3 + (i - 108) * 0.4);
    else if (i % 3 === 0) closes.push(100.5 + (i - 116) * 0.05);
    else if (i % 3 === 1) closes.push(100.5 + (i - 116) * 0.05 - 0.5);
    else closes.push(100.5 + (i - 116) * 0.05 + 0.1);
  }
  const vols = closes.map(() => 100);
  vols[114] = 500;

  const candles = closes.map((c, i) => ({
    ts: 1000 + i * 3600,
    open: c, high: c * 1.001, low: c * 0.999, close: c,
    volume: vols[i], confirm: 1,
  }));

  // Capture the RSI value passed to formatAlert.
  const captured = [];
  const tg = {
    formatAlert: (instId, price, rsv, tf, crossPrice) => {
      captured.push({ rsv, tf, crossPrice });
      return `[${instId}@${tf}]`;
    },
    sendMessage: async () => true,
  };

  const okx = fakeOkx({
    'LATE-USDT': { '4H': candles, '1H': candles, '5m': shortFixture() },
  });

  const cfg = baseConfig();
  const res = await runScan(cfg, { okx, telegram: tg });
  assert.strictEqual(res.ok, true);

  // Same candles on both timeframes → both may match; assert on the 4H one.
  const hit = captured.find((c) => c.tf === '4H');
  assert.ok(hit, '4H alert sent');
  const { rsv } = hit;
  assert.ok(rsv != null, 'RSI value passed to formatAlert');
  assert.ok(rsv >= cfg.rsiMin && rsv <= cfg.rsiMax, `alert RSI (${rsv}) within [${cfg.rsiMin}, ${cfg.rsiMax}] — same condition as the match`);

  // The displayed RSI must be the CROSS candle's RSI, not the current one.
  const { ema, rsi: rsiFn, lastCrossIndex } = require('../src/indicators');
  const closedCandles = candles; // all confirm=1
  const fast = ema(closedCandles.map((c) => c.close), cfg.emaFast);
  const slow = ema(closedCandles.map((c) => c.close), cfg.emaSlow);
  const series = rsiFn(closedCandles.map((c) => c.close), cfg.rsiPeriod);
  const crossIdx = lastCrossIndex(fast, slow, 10);
  const expectedCrossRsi = series[crossIdx]; // scanner passes the raw series value
  const currentRsi = series[series.length - 1];
  assert.strictEqual(rsv, expectedCrossRsi, 'alert shows cross-candle RSI');
  assert.notStrictEqual(currentRsi, expectedCrossRsi, 'sanity: current RSI differs in this fixture');
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

  const r = rowsByTf('4H')['OLD-USDT'];
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
