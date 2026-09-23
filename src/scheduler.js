'use strict';

const cron = require('node-cron');
const logger = require('./logger');
const db = require('./db');

let task = null;

// Single-flight latch shared by the cron schedule and the startup scan.
let busy = false;
let cycleStartedAt = 0; // 0 = no cycle in flight
let cycleId = 0; // generation counter: a finishing cycle may only release the
// latch if it is still the owner (a force-released/restarted cycle must not
// clobber the new owner's latch).
let busySkips = 0; // consecutive ticks skipped because a cycle was still running

/**
 * Next minute-boundary firing time for an N-minute cron schedule
 * (the N-minute interval pattern fired by node-cron).
 */
function nextCronBoundaryMs(minutes, from = Date.now()) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  const next = (Math.floor(d.getMinutes() / minutes) + 1) * minutes;
  d.setMinutes(next);
  return d.getTime();
}

function cronExpressionFor(config, now = new Date()) {
  const expr = `*/${config.scanIntervalMinutes} * * * *`;
  return { expr, nextMs: nextCronBoundaryMs(config.scanIntervalMinutes, now.getTime()) };
}

/** Watchdog limit for a single scan cycle (ms). */
function maxCycleMs(config) {
  const minutes =
    config.cycleTimeoutMinutes > 0
      ? config.cycleTimeoutMinutes
      : Math.max(config.scanIntervalMinutes || 15, 25);
  return minutes * 60 * 1000;
}

/** Staleness window: a scan older than this is considered "stale". */
function staleAfterMs(config, now = Date.now()) {
  const factor = config.staleFactor && config.staleFactor > 0 ? config.staleFactor : 1.5;
  return factor * (config.scanIntervalMinutes || 15) * 60 * 1000;
}

function isStaleScan(lastScanTs, config, now = Date.now()) {
  return lastScanTs != null && now - lastScanTs > staleAfterMs(config, now);
}

function nextScanMs(config) {
  return config.scanCron
    ? Date.now() + config.scanIntervalMinutes * 60 * 1000
    : nextCronBoundaryMs(config.scanIntervalMinutes, Date.now());
}

/**
 * Run one scan cycle under the single-flight latch.
 *
 * Guarantees:
 *  - the latch is ALWAYS released when the cycle finishes, even if scanFn
 *    throws or a storage write in the cleanup path fails;
 *  - a genuinely stuck cycle (longer than maxCycleMs) is force-released so
 *    the following tick starts a fresh cycle instead of skipping forever;
 *  - the finishing cycle only releases the latch if it still owns it, so a
 *    force-restarted cycle cannot be unlatched by the stale one it replaced.
 *
 * Resolves { started, error } and never rejects.
 */
async function runCycle(config, scanFn) {
  const limit = maxCycleMs(config);
  if (busy) {
    const age = cycleStartedAt ? Date.now() - cycleStartedAt : 0;
    if (age > limit) {
      busySkips = 0;
      logger.error(
        `Previous scan cycle has been running ${Math.round(age / 1000)}s ` +
          `(limit ${Math.round(limit / 1000)}s) — forcing release so a new cycle can start`
      );
      busy = false;
    } else {
      busySkips++;
      logger.warn(
        `Previous scan cycle still running — skipping this scheduled tick (consecutive skips: ${busySkips})`
      );
      return { started: false, error: null };
    }
  }

  const token = ++cycleId;
  const startedAt = Date.now();
  busy = true;
  cycleStartedAt = startedAt;
  const next = nextScanMs(config);

  let error = null;
  try {
    await scanFn();
  } catch (err) {
    error = err;
    logger.error(`Scan cycle threw: ${err.stack || err.message}`);
  } finally {
    // Release first (unconditionally), then persist the bookkeeping — a failed
    // storage write must never re-latch the scheduler forever.
    if (cycleId === token) {
      busy = false;
      cycleStartedAt = 0;
      busySkips = 0;
    }
    try {
      await db.setState('next_scan_ms', String(next));
    } catch (err2) {
      logger.error(`Failed to persist next_scan_ms: ${err2.message}`);
    }
  }
  return { started: true, error };
}

/**
 * Schedule periodic scans.
 * - Runs a full scan on the given cron expression.
 * - Never lets two scans overlap (skips the tick if one is still running),
 *   unless the running one has exceeded maxCycleMs (watchdog force-release).
 * - Updates state.next_scan_ms based on the schedule.
 */
function schedule(config, scanFn) {
  const expr = config.scanCron || `*/${config.scanIntervalMinutes} * * * *`;

  db.setState('next_scan_ms', String(nextScanMs(config))).catch((err) => {
    logger.error(`Failed to persist next_scan_ms: ${err.message}`);
  });

  task = cron.schedule(expr, () => {
    // Deliberately not awaited: runCycle owns all error handling + the latch.
    runCycle(config, scanFn);
  });

  logger.info(`Scan scheduler started: cron "${expr}"`);
  return { task, nextMs: async () => Number(await db.getState('next_scan_ms')) || null };
}

function isBusy() {
  return busy;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = {
  schedule,
  runCycle,
  stop,
  isBusy,
  nextCronBoundaryMs,
  isStaleScan,
  staleAfterMs,
  maxCycleMs,
};