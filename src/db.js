'use strict';

// SQLite via the built-in node:sqlite module (Node >= 22.5).
// No native compilation needed → works on x64 and ARM64 alike.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DB_PATH || path.join(DATA_DIR, 'scanner.db');

let db = null;

/**
 * Scans table keeps one row per (symbol, timeframe) per scan cycle:
 *   scans(id, symbol, timeframe, timestamp, price, rsi, ema_cross,
 *         volume_ok, matched, change_pct, last_candle_ts, change_5m,
 *         change_15m, change_1h, change_4h)
 * `last_candle_ts` is the timestamp of the last closed candle used for the
 * indicators — when `matched` it is the candle where the signal was found, so
 * the dashboard can count candles since detection.
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
function init() {
  if (db) return db;
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');

  db.exec(`
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
  // databases created before these features existed.
  const cols = new Set(
    db.prepare('PRAGMA table_info(scans)').all().map((c) => c.name)
  );
  const add = [
    ['timeframe', "TEXT NOT NULL DEFAULT '4H'"],
    ['change_5m', 'REAL'],
    ['change_15m', 'REAL'],
    ['change_1h', 'REAL'],
    ['change_4h', 'REAL'],
    ['last_candle_ts', 'REAL'],
    ['ticker_price', 'REAL'],
  ];
  for (const [name, type] of add) {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE scans ADD COLUMN ${name} ${type};`);
    }
  }

  // Index on (timeframe, timestamp) is created only after the column is
  // guaranteed to exist so upgrades of pre-timeframe databases succeed.
  db.exec('CREATE INDEX IF NOT EXISTS idx_scans_tf_ts ON scans(timeframe, timestamp DESC);');

  // ---- alerts migrations ----
  // 1) Dedup was previously keyed by symbol only. Re-key by (symbol, timeframe):
  //    existing rows describe matches from the single timeframe then in use, so
  //    migrate them as '4H' (the former default) without losing dedup state.
  // 2) Later adds split "detection recorded" from "message delivered" via `sent`.
  let alertCols = new Set(
    db.prepare('PRAGMA table_info(alerts)').all().map((c) => c.name)
  );
  if (!alertCols.has('timeframe')) {
    db.exec('ALTER TABLE alerts RENAME TO alerts_old;');
    db.exec(`
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
    db.exec(`
      INSERT INTO alerts (symbol, timeframe, detected_at, last_seen_at, sent, cross_ts)
      SELECT symbol, '4H', detected_at, last_seen_at, 1, NULL FROM alerts_old;
    `);
    db.exec('DROP TABLE alerts_old;');
    alertCols = new Set(
      db.prepare('PRAGMA table_info(alerts)').all().map((c) => c.name)
    );
  }
  if (!alertCols.has('sent')) {
    db.exec('ALTER TABLE alerts ADD COLUMN sent INTEGER NOT NULL DEFAULT 1;');
    alertCols = new Set(
      db.prepare('PRAGMA table_info(alerts)').all().map((c) => c.name)
    );
  }
  if (!alertCols.has('cross_ts')) {
    db.exec('ALTER TABLE alerts ADD COLUMN cross_ts REAL;');
    alertCols = new Set(
      db.prepare('PRAGMA table_info(alerts)').all().map((c) => c.name)
    );
  }
  if (!alertCols.has('cross_price')) {
    db.exec('ALTER TABLE alerts ADD COLUMN cross_price REAL;');
  }

  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

// ---------- scans ----------

function insertScan(row) {
  return db
    .prepare(`
      INSERT INTO scans (symbol, timeframe, timestamp, price, ticker_price, rsi, ema_cross, volume_ok, matched,
                         change_pct, last_candle_ts, change_5m, change_15m, change_1h, change_4h)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
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
      row.change_4h == null ? null : row.change_4h
    );
}

function getLatestCycleTs() {
  const row = db.prepare('SELECT MAX(timestamp) AS ts FROM scans').get();
  return row && row.ts != null ? Number(row.ts) : null;
}

/**
 * Rows of the latest completed cycle for one timeframe (or all when omitted),
 * joined with alerts for detected_at.
 */
function newestRows(timeframe) {
  const base = `
    SELECT s.timeframe, s.symbol, s.price, s.ticker_price, s.rsi, s.ema_cross, s.volume_ok, s.matched, s.change_pct,
           s.last_candle_ts, s.timestamp AS scan_at,
           s.change_5m, s.change_15m, s.change_1h, s.change_4h,
           a.detected_at, a.cross_ts, a.cross_price
    FROM scans s
    LEFT JOIN alerts a ON a.symbol = s.symbol AND a.timeframe = s.timeframe
    WHERE s.timestamp = (SELECT MAX(timestamp) FROM scans)
  `;
  const sql = timeframe
    ? `${base} AND s.timeframe = ? ORDER BY a.detected_at DESC, s.symbol ASC`
    : `${base} ORDER BY a.detected_at DESC, s.symbol ASC`;
  return timeframe ? db.prepare(sql).all(timeframe) : db.prepare(sql).all();
}

function countMatched(timeframe) {
  return newestRows(timeframe).filter((r) => r.matched === 1).length;
}

/** Distinct symbols present in the latest cycle (a symbol can have ≥1 timeframe rows). */
function countSymbolsInLastCycle() {
  const ts = getLatestCycleTs();
  if (!ts) return 0;
  return db.prepare('SELECT COUNT(DISTINCT symbol) AS n FROM scans WHERE timestamp = ?').get(ts).n;
}

function pruneScans(olderThanMs) {
  return db.prepare('DELETE FROM scans WHERE timestamp < ?').run(olderThanMs).changes;
}

// ---------- alerts (dedup state, keyed by symbol + timeframe) ----------

function getAlert(symbol, timeframe) {
  const row = db.prepare('SELECT * FROM alerts WHERE symbol = ? AND timeframe = ?').get(symbol, timeframe);
  return row === undefined ? undefined : row;
}

/**
 * Insert a detection (or refresh last_seen for a still-matching one). On
 * conflict only `last_seen_at` is updated, so `detected_at` (first match time),
 * `cross_ts` (the detection candle) and `cross_price` (the signal candle's
 * close at first detection) are preserved across cycles.
 */
function insertAlert(symbol, timeframe, detectedAt, lastSeenAt, sent, crossTs, crossPrice) {
  db.prepare(`
    INSERT INTO alerts (symbol, timeframe, detected_at, last_seen_at, sent, cross_ts, cross_price)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, timeframe) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(
    symbol,
    timeframe,
    detectedAt,
    lastSeenAt,
    sent ? 1 : 0,
    crossTs == null ? null : crossTs,
    crossPrice == null ? null : crossPrice
  );
}

/** Mark a previously-recorded detection as delivered to Telegram. */
function markSent(symbol, timeframe, lastSeenAt) {
  db.prepare('UPDATE alerts SET sent = 1, last_seen_at = ? WHERE symbol = ? AND timeframe = ?')
    .run(lastSeenAt, symbol, timeframe);
}

/** Fill in cross_price only when still null (backfill for pre-column alerts). */
function backfillCrossPrice(symbol, timeframe, price) {
  db.prepare(
    'UPDATE alerts SET cross_price = ? WHERE symbol = ? AND timeframe = ? AND cross_price IS NULL'
  ).run(price == null ? null : price, symbol, timeframe);
}

function deleteAlert(symbol, timeframe) {
  db.prepare('DELETE FROM alerts WHERE symbol = ? AND timeframe = ?').run(symbol, timeframe);
}

// ---------- state ----------

function setState(key, value) {
  db.prepare(`
    INSERT INTO state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function getState(key) {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key);
  return row === undefined ? null : row.value;
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
  getAlert,
  insertAlert,
  markSent,
  backfillCrossPrice,
  deleteAlert,
  setState,
  getState,
};