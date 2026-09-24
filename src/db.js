'use strict';

require('dotenv').config();

// SQLite via @libsql/client — same engine for the local dev file (file: URL)
// and the permanent cloud database on Turso (libsql:/https: URL). See README
// "قاعدة البيانات الدائمة (Turso)" for setup.
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DATA_DIR = path.join(__dirname, '..', 'data');

let client = null;
let initPromise = null;

/**
 * Filesystem path of the local fallback DB (DB_PATH or data/scanner.db).
 */
function localDbPath() {
  return process.env.DB_PATH || path.join(DATA_DIR, 'scanner.db');
}

/**
 * Resolve the connection target:
 *   1. TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) when set → permanent cloud DB;
 *   2. otherwise fall back to the local SQLite file (DB_PATH or data/scanner.db).
 * Resolved inside init() so tests can point DB_PATH at a temp file first.
 */
function resolveUrl() {
  const turso = (process.env.TURSO_DATABASE_URL || '').trim();
  if (turso) return turso;
  return pathToFileURL(localDbPath()).href;
}

/**
 * Scans table keeps one row per (symbol, timeframe) per scan cycle:
 *   scans(id, symbol, timeframe, timestamp, price, ticker_price, rsi, ema_cross,
 *         volume_ok, matched, change_pct, last_candle_ts, change_5m,
 *         change_15m, change_1h, change_4h, higher_tf_warning, cross_price)
 * `last_candle_ts` is the timestamp of the last closed candle used for the
 * indicators — when `matched` it is the candle where the signal was found, so
 * the dashboard can count candles since detection. `cross_price` (matched rows
 * only) is the interpolated EMA cross price stored at detection so the history
 * tab keeps the real signal price even after the alert row is deleted.
 *
 * alerts table stores which (symbol, timeframe) pairs are currently
 * "detected" so we never send a duplicate Telegram message while the signal
 * stays true on that timeframe. `detected_at` records the FIRST match time
 * (shown on the dashboard) regardless of Telegram delivery; `sent` flags
 * whether the alert was actually delivered (0 → retried next cycle);
 * `cross_ts` is the timestamp of the candle where the signal first appeared
 * (set once at detection, never refreshed) so the dashboard can count candles
 * since the detection while the signal keeps matching.
 *
 * state table stores runtime metadata exposed by the dashboard (last/next
 * scan time, status, counters, last error).
 */
async function init() {
  if (client) return client;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const url = resolveUrl();
    const token = (process.env.TURSO_AUTH_TOKEN || '').trim();

    if (url.startsWith('file:')) {
      const dir = path.dirname(localDbPath());
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    client = token ? createClient({ url, authToken: token }) : createClient({ url });

    // WAL only makes sense (and is only safe) on a local file.
    if (url.startsWith('file:')) {
      try {
        await client.execute('PRAGMA journal_mode = WAL;');
        await client.execute('PRAGMA synchronous = NORMAL;');
      } catch (_) {
        // Non-fatal: continue with default journal mode.
      }
    }

    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS scans (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol      TEXT    NOT NULL,
        timeframe   TEXT    NOT NULL DEFAULT '4H',
        timestamp   INTEGER NOT NULL,
        price       REAL,
        ticker_price REAL,
        rsi         REAL,
        ema_cross   INTEGER DEFAULT 0,
        volume_ok   INTEGER DEFAULT 0,
        matched     INTEGER DEFAULT 0,
        change_pct  REAL,
        last_candle_ts REAL,
        change_5m   REAL,
        change_15m  REAL,
        change_1h   REAL,
        change_4h   REAL
      );
      CREATE INDEX IF NOT EXISTS idx_scans_symbol_ts ON scans(symbol, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_scans_ts ON scans(timestamp DESC);

      CREATE TABLE IF NOT EXISTS alerts (
        symbol        TEXT NOT NULL,
        timeframe     TEXT NOT NULL DEFAULT '4H',
        detected_at   INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        sent          INTEGER NOT NULL DEFAULT 1,
        cross_ts      REAL,
        cross_price   REAL,
        PRIMARY KEY (symbol, timeframe)
      );

      CREATE TABLE IF NOT EXISTS state (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // ---- scans migrations ----
    // Add the timeframe column, then the per-period change columns, to
    // databases created before these features existed. Fresh Turso databases
    // get every column from CREATE above... higher_tf_warning is still
    // added here because it is not part of the base CREATE block.
    const cols = new Set(await columnNames('scans'));
    const add = [
      ['timeframe', "TEXT NOT NULL DEFAULT '4H'"],
      ['change_5m', 'REAL'],
      ['change_15m', 'REAL'],
      ['change_1h', 'REAL'],
      ['change_4h', 'REAL'],
      ['last_candle_ts', 'REAL'],
      ['ticker_price', 'REAL'],
      ['higher_tf_warning', 'TEXT'],
      ['cross_price', 'REAL'],
    ];
    for (const [name, type] of add) {
      if (!cols.has(name)) {
        await client.execute(`ALTER TABLE scans ADD COLUMN ${name} ${type}`);
      }
    }

    // Index on (timeframe, timestamp) is created only after the column is
    // guaranteed to exist so upgrades of pre-timeframe databases succeed.
    await client.execute('CREATE INDEX IF NOT EXISTS idx_scans_tf_ts ON scans(timeframe, timestamp DESC)');

    // ---- alerts migrations ----
    // 1) Dedup was previously keyed by symbol only. Re-key by (symbol, timeframe):
    //    existing rows describe matches from the single timeframe then in use, so
    //    migrate them as '4H' (the former default) without losing dedup state.
    // 2) Later adds split "detection recorded" from "message delivered" via `sent`.
    let alertCols = new Set(await columnNames('alerts'));
    if (!alertCols.has('timeframe')) {
      await client.execute('ALTER TABLE alerts RENAME TO alerts_old');
      await client.executeMultiple(`
        CREATE TABLE alerts (
          symbol        TEXT NOT NULL,
          timeframe     TEXT NOT NULL DEFAULT '4H',
          detected_at   INTEGER NOT NULL,
          last_seen_at  INTEGER NOT NULL,
          sent          INTEGER NOT NULL DEFAULT 1,
          cross_ts      REAL,
          cross_price   REAL,
          PRIMARY KEY (symbol, timeframe)
        );
      `);
      await client.execute(`
        INSERT INTO alerts (symbol, timeframe, detected_at, last_seen_at, sent, cross_ts)
        SELECT symbol, '4H', detected_at, last_seen_at, 1, NULL FROM alerts_old
      `);
      await client.execute('DROP TABLE alerts_old');
      alertCols = new Set(await columnNames('alerts'));
    }
    if (!alertCols.has('sent')) {
      await client.execute('ALTER TABLE alerts ADD COLUMN sent INTEGER NOT NULL DEFAULT 1');
      alertCols = new Set(await columnNames('alerts'));
    }
    if (!alertCols.has('cross_ts')) {
      await client.execute('ALTER TABLE alerts ADD COLUMN cross_ts REAL');
      alertCols = new Set(await columnNames('alerts'));
    }
    if (!alertCols.has('cross_price')) {
      await client.execute('ALTER TABLE alerts ADD COLUMN cross_price REAL');
    }

    return client;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

/** Column names of a table via the pragma table-valued function (works over HTTP too). */
async function columnNames(table) {
  const rs = await client.execute(
    `SELECT name FROM pragma_table_info(?)`,
    [table]
  );
  return rs.rows.map((r) => r.name);
}

/** Require an initialized client (every public helper awaits this). */
async function conn() {
  if (!client) await init();
  return client;
}

function close() {
  if (client) {
    try {
      client.close();
    } catch (_) {
      // Already closed / no-op transport — safe to ignore.
    }
    client = null;
  }
}

// ---------- scans ----------

async function insertScan(row) {
  const c = await conn();
  await c.execute(
    `INSERT INTO scans (symbol, timeframe, timestamp, price, ticker_price, rsi, ema_cross, volume_ok, matched,
                       change_pct, last_candle_ts, change_5m, change_15m, change_1h, change_4h, higher_tf_warning,
                       cross_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.symbol,
      row.timeframe,
      row.timestamp,
      row.price == null ? null : row.price,
      row.ticker_price == null ? null : row.ticker_price,
      row.rsi == null ? null : row.rsi,
      row.ema_cross ? 1 : 0,
      row.volume_ok ? 1 : 0,
      row.matched ? 1 : 0,
      row.change_pct == null ? null : row.change_pct,
      row.last_candle_ts == null ? null : row.last_candle_ts,
      row.change_5m == null ? null : row.change_5m,
      row.change_15m == null ? null : row.change_15m,
      row.change_1h == null ? null : row.change_1h,
      row.change_4h == null ? null : row.change_4h,
      row.higher_tf_warning == null ? null : row.higher_tf_warning,
      row.cross_price == null ? null : row.cross_price,
    ]
  );
}

async function getLatestCycleTs() {
  const c = await conn();
  const rs = await c.execute('SELECT MAX(timestamp) AS ts FROM scans');
  const row = rs.rows[0];
  return row && row.ts != null ? Number(row.ts) : null;
}

/**
 * Rows of the latest completed cycle for one timeframe (or all when omitted),
 * joined with alerts for detected_at.
 */
async function newestRows(timeframe) {
  const c = await conn();
  const base = `
    SELECT s.timeframe, s.symbol, s.price, s.ticker_price, s.rsi, s.ema_cross, s.volume_ok, s.matched, s.change_pct,
           s.last_candle_ts, s.timestamp AS scan_at,
           s.change_5m, s.change_15m, s.change_1h, s.change_4h,
           s.higher_tf_warning,
           a.detected_at, a.cross_ts, a.cross_price
    FROM scans s
    LEFT JOIN alerts a ON a.symbol = s.symbol AND a.timeframe = s.timeframe
    WHERE s.timestamp = (SELECT MAX(timestamp) FROM scans)
  `;
  const rs = timeframe
    ? await c.execute(`${base} AND s.timeframe = ? ORDER BY a.detected_at DESC, s.symbol ASC`, [timeframe])
    : await c.execute(`${base} ORDER BY a.detected_at DESC, s.symbol ASC`);
  return rs.rows;
}

async function countMatched(timeframe) {
  const rows = await newestRows(timeframe);
  return rows.filter((r) => r.matched === 1).length;
}

/** Distinct symbols present in the latest cycle (a symbol can have ≥1 timeframe rows). */
async function countSymbolsInLastCycle() {
  const ts = await getLatestCycleTs();
  if (!ts) return 0;
  const c = await conn();
  const rs = await c.execute(
    'SELECT COUNT(DISTINCT symbol) AS n FROM scans WHERE timestamp = ?',
    [ts]
  );
  return rs.rows[0].n;
}

async function pruneScans(olderThanMs) {
  const c = await conn();
  const rs = await c.execute('DELETE FROM scans WHERE timestamp < ?', [olderThanMs]);
  return rs.rowsAffected;
}

/**
 * Signal history for the dashboard's "سجل الإشارات" tab, built from `scans`
 * (alerts are deleted when a signal ends — scans keep the past).
 *
 * Groups CONSECUTIVE matched cycles of the same (symbol, timeframe) into one
 * signal "episode": a new episode starts when the previous row for that pair
 * is matched=0 (or the series begins) — exactly the rule that ends an alert,
 * so the history mirrors what was actually alerted. Missing cycles (fetch
 * errors / filtered pairs) write no row and therefore do NOT split an episode,
 * same as deleteStaleAlerts behaviour.
 *
 * Each episode reports its FIRST cycle's values (detection time, signal
 * price, cross-candle RSI, daily-context warning) plus the live price from
 * the symbol's LATEST scan row for retrospective % calculation.
 *
 * @param sinceMs    only episodes detected at/after this timestamp (7-day window)
 * @param timeframe  array of timeframe tokens to keep, or [] / null for all
 * @param limit      max episodes returned, newest first (cap enforced by caller)
 */
async function signalHistory({ sinceMs, timeframe, limit }) {
  const c = await conn();
  const tfList = Array.isArray(timeframe) ? timeframe.filter((t) => typeof t === 'string' && t) : [];
  const params = [sinceMs == null ? 0 : sinceMs];
  let tfClause = '';
  if (tfList.length > 0) {
    tfClause = ` AND timeframe IN (${tfList.map(() => '?').join(', ')})`;
    params.push(...tfList);
  }
  const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 300;
  params.push(lim);

  const rs = await c.execute(
    `WITH win AS (
       SELECT symbol, timeframe, timestamp, matched, price, rsi, last_candle_ts,
              higher_tf_warning, cross_price,
              LAG(matched) OVER (PARTITION BY symbol, timeframe ORDER BY timestamp) AS prev_matched
       FROM scans
       WHERE timestamp >= ?${tfClause}
     ),
     episodes AS (
       SELECT symbol, timeframe, timestamp, price, rsi, last_candle_ts,
              higher_tf_warning, cross_price,
              SUM(CASE WHEN prev_matched IS NULL OR prev_matched = 0 THEN 1 ELSE 0 END)
                OVER (PARTITION BY symbol, timeframe ORDER BY timestamp) AS ep
       FROM win
       WHERE matched = 1
     ),
     final AS (
       SELECT symbol, timeframe, ep, MIN(timestamp) AS detected_at, COUNT(*) AS cycles
       FROM episodes
       GROUP BY symbol, timeframe, ep
     ),
     latest AS (
       SELECT s.symbol, MAX(s.ticker_price) AS live_ticker_price, MAX(s.price) AS live_price
       FROM scans s
       INNER JOIN (SELECT symbol, MAX(timestamp) AS mt FROM scans GROUP BY symbol) m
         ON m.symbol = s.symbol AND m.mt = s.timestamp
       GROUP BY s.symbol
     )
     SELECT f.symbol, f.timeframe, f.detected_at, f.cycles,
            e.last_candle_ts, e.price, e.cross_price, e.rsi, e.higher_tf_warning,
            l.live_ticker_price, l.live_price
     FROM final f
     JOIN episodes e
       ON e.symbol = f.symbol AND e.timeframe = f.timeframe
      AND e.ep = f.ep AND e.timestamp = f.detected_at
     LEFT JOIN latest l ON l.symbol = f.symbol
     ORDER BY f.detected_at DESC
     LIMIT ?`,
    params
  );
  return rs.rows;
}

// ---------- alerts (dedup state, keyed by symbol + timeframe) ----------

async function getAlert(symbol, timeframe) {
  const c = await conn();
  const rs = await c.execute(
    'SELECT * FROM alerts WHERE symbol = ? AND timeframe = ?',
    [symbol, timeframe]
  );
  return rs.rows.length === 0 ? undefined : rs.rows[0];
}

/**
 * Insert a detection (or refresh last_seen for a still-matching one). On
 * conflict only `last_seen_at` is updated, so `detected_at` (first match time),
 * `cross_ts` (the detection candle) and `cross_price` (the signal candle's
 * close at first detection) are preserved across cycles.
 */
async function insertAlert(symbol, timeframe, detectedAt, lastSeenAt, sent, crossTs, crossPrice) {
  const c = await conn();
  await c.execute(
    `INSERT INTO alerts (symbol, timeframe, detected_at, last_seen_at, sent, cross_ts, cross_price)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, timeframe) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    [symbol, timeframe, detectedAt, lastSeenAt, sent ? 1 : 0,
     crossTs == null ? null : crossTs, crossPrice == null ? null : crossPrice]
  );
}

/** Mark a previously-recorded detection as delivered to Telegram. */
async function markSent(symbol, timeframe, lastSeenAt) {
  const c = await conn();
  await c.execute(
    'UPDATE alerts SET sent = 1, last_seen_at = ? WHERE symbol = ? AND timeframe = ?',
    [lastSeenAt, symbol, timeframe]
  );
}

/** Fill in cross_price only when still null (backfill for pre-column alerts). */
async function backfillCrossPrice(symbol, timeframe, price) {
  const c = await conn();
  await c.execute(
    'UPDATE alerts SET cross_price = ? WHERE symbol = ? AND timeframe = ? AND cross_price IS NULL',
    [price == null ? null : price, symbol, timeframe]
  );
}

async function deleteAlert(symbol, timeframe) {
  const c = await conn();
  await c.execute('DELETE FROM alerts WHERE symbol = ? AND timeframe = ?', [symbol, timeframe]);
}

// ---------- state ----------

async function setState(key, value) {
  const c = await conn();
  await c.execute(
    `INSERT INTO state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

/**
 * Delete alerts for (symbol, timeframe) pairs where the most recent scan
 * results show it is no longer matching.
 */
async function deleteStaleAlerts() {
  const c = await conn();
  const rs = await c.execute(`
    DELETE FROM alerts
    WHERE (symbol, timeframe) IN (
      SELECT a.symbol, a.timeframe
      FROM alerts a
      INNER JOIN (
        /* Get the most recent scan for every symbol+tf */
        SELECT symbol, timeframe, matched, MAX(timestamp)
        FROM scans
        GROUP BY symbol, timeframe
      ) s ON s.symbol = a.symbol AND s.timeframe = a.timeframe
      WHERE s.matched = 0
    )
  `);
  return rs.rowsAffected;
}

async function getState(key) {
  const c = await conn();
  const rs = await c.execute('SELECT value FROM state WHERE key = ?', [key]);
  return rs.rows.length === 0 ? null : rs.rows[0].value;
}

module.exports = {
  init,
  close,
  insertScan,
  getLatestCycleTs,
  newestRows,
  countMatched,
  countSymbolsInLastCycle,
  pruneScans,
  signalHistory,
  getAlert,
  insertAlert,
  markSent,
  backfillCrossPrice,
  deleteAlert,
  deleteStaleAlerts,
  setState,
  getState,
};
