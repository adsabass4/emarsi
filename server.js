'use strict';

const path = require('path');
const express = require('express');

const config = require('./src/config').readConfig();
const db = require('./src/db');
const logger = require('./src/logger');
const { runScan } = require('./src/scanner');
const scheduler = require('./src/scheduler');

const SCAN_ONCE = process.argv.includes('--scan-once');

// Process-level safety net: never die silently. Log loudly, then exit so the
// supervisor (Docker `restart: unless-stopped`, systemd, pm2, ...) restarts us.
process.on('uncaughtException', (err) => {
  logger.error(`UNCAUGHT_EXCEPTION — exiting: ${err.stack || err.message}`);
  try { db.close(); } catch (_) {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error(
    `UNHANDLED_REJECTION — exiting: ${reason instanceof Error ? reason.stack : String(reason)}`
  );
  try { db.close(); } catch (_) {}
  process.exit(1);
});

function scanFn() {
  return runScan(config);
}

// ---------- Express app ----------

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  const lastScan = db.getLatestCycleTs();
  const lastScanAgeMs = lastScan == null ? null : Date.now() - lastScan;
  res.json({
    ok: true,
    uptime: process.uptime(),
    now: Date.now(),
    lastScanAgeMs,
    stale: scheduler.isStaleScan(lastScan, config),
  });
});

// Pick the requested timeframe from the query string; otherwise the default.
function pickTimeframe(raw) {
  const q = String(raw || '');
  return config.timeframes.includes(q) ? q : config.timeframe;
}

app.get('/api/overview', (req, res) => {
  const tf = pickTimeframe(req.query.timeframe);
  const lastScan = db.getLatestCycleTs();
  const lastScanAgeMs = lastScan == null ? null : Date.now() - lastScan;
  const nextScan = Number(db.getState('next_scan_ms')) || null;
  res.json({
    status: db.getState('status') || 'idle',
    lastScanAt: lastScan,
    lastScanAgeMs,
    stale: scheduler.isStaleScan(lastScan, config),
    nextScanAt: nextScan,
    lastScanDurationMs: Number(db.getState('last_scan_duration_ms')) || null,
    scanCron: config.scanCron || `*/${config.scanIntervalMinutes} * * * *`,
    scanIntervalMinutes: config.scanIntervalMinutes,
    timeframe: tf,
    timeframes: config.timeframes,
    instrumentsLastCycle: db.countSymbolsInLastCycle(),
    // liquidity filter: total USDT pairs vs pairs kept after the 24h-volume filter
    volumeFilterTotal: Number(db.getState('last_cycle_total')) || null,
    volumeFilterKept: Number(db.getState('last_cycle_after_filter')) || null,
    minVolumeUsd24h: config.minVolumeUsd24h,
    matchedCount: db.countMatched(tf),
    lastError: db.getState('last_error') || null,
    // echo strategy config so the dashboard can render it
    emaFast: config.emaFast,
    emaSlow: config.emaSlow,
    rsiMin: config.rsiMin,
    rsiMax: config.rsiMax,
    volumeSma: config.volumeSma,
    updatedAt: Date.now(),
  });
});

app.get('/api/symbols', (req, res) => {
  const tf = pickTimeframe(req.query.timeframe);
  const rows = db.newestRows(tf);
  const only = String(req.query.matched || '');
  let symbols = rows;
  if (only === 'true' || only === '1') symbols = rows.filter((r) => r.matched === 1);
  else if (only === 'false' || only === '0') symbols = rows.filter((r) => r.matched === 0);
  res.json({ symbols, timeframe: tf, asOf: Date.now() });
});

app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- startup ----------

function shutdown() {
  logger.info('Shutting down...');
  scheduler.stop();
  try {
    db.close();
  } catch (_) {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (SCAN_ONCE) {
  db.init();
  logger.info('Running a single scan (--scan-once)...');
  runScan(config)
    .then((res) => {
      logger.info(res.ok ? 'scan-once finished OK' : `scan-once finished with error: ${res.error}`);
    })
    .catch((err) => logger.error(`scan-once crashed: ${err.message}`))
    .finally(() => shutdown());
} else {
  db.init();
  logger.info(`Starting web server on port ${config.port}`);
  app.listen(config.port, () => {
    logger.info(`Dashboard ready: http://localhost:${config.port}`);
    try {
      scheduler.schedule(config, scanFn);
    } catch (err) {
      logger.error(`Invalid SCAN_CRON "${config.scanCron}" — scheduling disabled: ${err.message}`);
    }
    // Kick off an immediate first scan so the dashboard has data right away.
    setImmediate(() => {
      scheduler
        .runCycle(config, scanFn)
        .then((r) => {
          if (r.started === false) {
            logger.warn('Startup scan skipped because a cycle was already running');
          }
        });
    });
  });
}