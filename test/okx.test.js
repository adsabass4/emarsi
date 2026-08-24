'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const http = require('http');
const { OkxClient } = require('../src/okx');

// ---------- fake OKX server ----------

let server;
let base;
let maxActive = 0;
let activeNow = 0;
let counters = {};
let retryFlag = true;

const INSTRUMENTS = [
  { instId: 'BTC-USDT', state: 'live', quoteCcy: 'USDT', baseCcy: 'BTC' },
  { instId: 'ETH-USDT', state: 'live', quoteCcy: 'USDT', baseCcy: 'ETH' },
  { instId: 'BTC-EUR', state: 'live', quoteCcy: 'EUR', baseCcy: 'BTC' },   // skip: not USDT
  { instId: 'DOGE-USDT', state: 'suspended', quoteCcy: 'USDT', baseCcy: 'DOGE' }, // skip: not live
  { instId: 'SOL-USDT', state: 'live', quoteCcy: 'USDT', baseCcy: 'SOL' },
];

const CANDLES = [
  { ts: 1000, open: 1, high: 2, low: 1, close: 3, volume: 5, confirm: 1 },
  { ts: 2000, open: 3, high: 4, low: 3, close: 5, volume: 7, confirm: 1 },
  { ts: 3000, open: 5, high: 6, low: 5, close: 6, volume: 9, confirm: 0 },  // forming
];

function candleRow(c) {
  return [
    String(c.ts), String(c.open), String(c.high), String(c.low),
    String(c.close), String(c.volume),
    String(c.volume), String(c.volume * c.close),
    String(c.confirm),
  ];
}

function write(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = url.pathname;
    counters[key] = (counters[key] || 0) + 1;

    if (key === '/public/instruments') {
      return write(res, 200, { code: '0', msg: '', data: INSTRUMENTS });
    }
    if (key === '/market/candles') {
      // transient error on the first attempt of this specific instId
      const inst = url.searchParams.get('instId');
      if (inst === 'RETRY-USDT' && retryFlag) {
        retryFlag = false;
        return write(res, 500, { code: '500', msg: 'internal error', data: [] });
      }
      activeNow++;
      maxActive = Math.max(maxActive, activeNow);
      await new Promise((r) => setTimeout(r, 30));
      activeNow--;
      return write(res, 200, {
        code: '0',
        msg: '',
        data: [candleRow(CANDLES[2]), candleRow(CANDLES[1]), candleRow(CANDLES[0])], // newest first
      });
    }
    if (key === '/market/badcode') {
      return write(res, 200, { code: '50052', msg: 'bad symbol', data: [] });
    }
    return write(res, 404, { code: '0', data: [] });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function client(overrides = {}) {
  return new OkxClient({
    okxBaseUrl: base,
    timeout: 5000,
    retryDelayMs: 10,
    concurrency: 6,
    requestsPer2s: 100,
    ...overrides,
  });
}

test('getUsdtInstruments keeps only live USDT-quoted pairs', async () => {
  const list = await client().getUsdtInstruments();
  assert.deepStrictEqual(list, ['BTC-USDT', 'ETH-USDT', 'SOL-USDT']);
});

test('getCandles maps fields, parses numbers, returns oldest-first, keeps confirm', async () => {
  const candles = await client().getCandles('BTC-USDT', '4H', 120);
  assert.strictEqual(candles.length, 3);
  assert.strictEqual(candles[0].ts, 1000);
  assert.strictEqual(candles[candles.length - 1].ts, 3000);
  assert.strictEqual(candles[0].close, 3);
  assert.strictEqual(candles[1].volume, 7);
  assert.strictEqual(candles[2].confirm, 0);
  assert.strictEqual(candles[0].confirm, 1);
});

test('error codes from OKX throw, and ApiError carries code', async () => {
  await assert.rejects(() => client().fetchJson('/market/badcode'), /50052/);
});

test('retry succeeds after a transient 500', async () => {
  retryFlag = true;
  const candles = await client().getCandles('RETRY-USDT', '4H', 120);
  assert.strictEqual(candles.length, 3);
  assert.strictEqual(counters['/market/candles'] >= 2, true); // retried at least once
});

test('concurrency never exceeds the configured limit', async () => {
  maxActive = 0;
  const client = new OkxClient({ okxBaseUrl: base, timeout: 5000, retryDelayMs: 1, concurrency: 2, requestsPer2s: 1000 });
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => client.getCandles(`PAIR${i}-USDT`, '4H', 120))
  );
  assert.ok(maxActive <= 2, `maxActive was ${maxActive}`);
});

test('instruments response filtered even when extra junk is present', async () => {
  const list = await client().getUsdtInstruments();
  assert.ok(list.every((s) => s.endsWith('-USDT')));
});