'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const scheduler = require('../src/scheduler');
const db = require('../src/db');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
const baseCfg = { scanIntervalMinutes: 15, scanCron: '', cycleTimeoutMinutes: 0, staleFactor: 1.5 };

function initDb() {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.DB_PATH = path.join(tmpDir, 'sched.db');
  db.init();
}

test('runCycle releases the latch when scanFn throws → next cycle starts', async () => {
  initDb();
  let calls = 0;
  const scanFn = async () => {
    calls++;
    if (calls === 1) throw new Error('boom');
  };
  const r1 = await scheduler.runCycle(baseCfg, scanFn);
  assert.strictEqual(r1.started, true);
  assert.ok(r1.error instanceof Error);
  const r2 = await scheduler.runCycle(baseCfg, scanFn);
  assert.strictEqual(r2.started, true, 'latch was released after the throw');
  assert.strictEqual(r2.error, null);
  assert.strictEqual(scheduler.isBusy(), false);
  assert.strictEqual(calls, 2);
});

test('runCycle releases the latch when scanFn rejects (async error)', async () => {
  initDb();
  let calls = 0;
  const scanFn = async () => {
    calls++;
    if (calls === 1) return Promise.reject(new Error('async boom'));
  };
  await scheduler.runCycle(baseCfg, scanFn);
  const r2 = await scheduler.runCycle(baseCfg, scanFn);
  assert.strictEqual(r2.started, true);
  assert.strictEqual(calls, 2);
});

test('runCycle skips while a cycle is in flight, then runs once it completes', async () => {
  initDb();
  let release;
  const gate = new Promise((r) => { release = r; });
  const scanFn = async () => { await gate; };
  const first = scheduler.runCycle(baseCfg, scanFn);
  // Give the first cycle time to acquire the latch.
  await new Promise((r) => setTimeout(r, 20));
  const skipped = await scheduler.runCycle(baseCfg, scanFn);
  assert.strictEqual(skipped.started, false, 'second cycle skipped while first in flight');
  release();
  await first;
  assert.strictEqual(scheduler.isBusy(), false);
  const after = await scheduler.runCycle(baseCfg, scanFn);
  assert.strictEqual(after.started, true, 'runs again after the first completes');
});

test('watchdog force-releases a stuck cycle so the next tick starts fresh', async () => {
  initDb();
  const cfgFast = { ...baseCfg, cycleTimeoutMinutes: 1 / 600 }; // 100ms limit
  let stuck = true;
  const stuckFn = async () => { while (stuck) await new Promise((r) => setTimeout(r, 10)); };

  const first = scheduler.runCycle(cfgFast, stuckFn);
  await new Promise((r) => setTimeout(r, 250)); // exceed the 100ms limit
  const rescuedP = scheduler.runCycle(cfgFast, stuckFn); // force-release + start fresh
  await new Promise((r) => setTimeout(r, 30)); // let the new cycle acquire the latch
  assert.strictEqual(scheduler.isBusy(), true, 'new cycle holds the latch');
  stuck = false; // let both cycles finish
  const rescued = await rescuedP;
  assert.strictEqual(rescued.started, true, 'watchdog force-released the stuck latch');
  await first;
  assert.strictEqual(scheduler.isBusy(), false, 'stale cycle did not clobber the new latch');
});

test('isStaleScan flags an old scan and not a fresh one', () => {
  const now = Date.now();
  assert.strictEqual(scheduler.isStaleScan(null, baseCfg, now), false, 'no scan yet → not stale');
  assert.strictEqual(
    scheduler.isStaleScan(now - 10 * 60 * 1000, baseCfg, now),
    false,
    '10 min old with 15 min interval → fresh'
  );
  assert.strictEqual(
    scheduler.isStaleScan(now - 60 * 60 * 1000, baseCfg, now),
    true,
    '60 min old with 15 min interval → stale'
  );
});

test('maxCycleMs defaults to at least the scan interval (min 25 min)', () => {
  assert.strictEqual(scheduler.maxCycleMs(baseCfg), 25 * 60 * 1000, '15-min interval → min 25');
  assert.strictEqual(
    scheduler.maxCycleMs({ ...baseCfg, scanIntervalMinutes: 30 }),
    30 * 60 * 1000
  );
  assert.strictEqual(
    scheduler.maxCycleMs({ ...baseCfg, cycleTimeoutMinutes: 5 }),
    5 * 60 * 1000,
    'explicit cycleTimeoutMinutes wins'
  );
});

test('nextCronBoundaryMs lands on the next interval boundary', () => {
  const from = new Date('2026-08-13T10:06:30.000Z').getTime();
  const next = scheduler.nextCronBoundaryMs(15, from);
  assert.strictEqual(new Date(next).toISOString(), '2026-08-13T10:15:00.000Z');
});

after(() => {
  db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});