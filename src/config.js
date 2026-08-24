'use strict';

require('dotenv').config();

const env = process.env;

function int(name, def, { min, max } = {}) {
  let raw = env[name];
  if (raw === undefined || raw === '') raw = def;
  let v = Number(raw);
  if (!Number.isFinite(v)) v = def;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return Math.floor(v);
}

function num(name, def, { min, max } = {}) {
  let raw = env[name];
  if (raw === undefined || raw === '') raw = def;
  let v = Number(raw);
  if (!Number.isFinite(v)) v = def;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

function bool(name, def = false) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** Normalize an OKX bar token: "1h" → "1H", "4H", "5m", "1D", etc. Returns null on junk. */
function normalizeBar(bar) {
  const m = /^(\d+)([mhHdDwW])$/.exec(String(bar || '').trim());
  if (!m) return null;
  const n = m[1];
  const u = m[2].toLowerCase();
  return `${n}${u === 'm' ? 'm' : u.toUpperCase()}`;
}

/** Parse "1H,4H" into a validated, deduped array of OKX bars. */
function parseTimeframes(raw) {
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const norm = normalizeBar(part);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

/**
 * Build configuration from environment variables (.env file).
 * Every value can be overridden via `overrides` (used by tests / DI).
 */
function readConfig(overrides = {}) {
  // Enabled timeframes scanned every cycle (TIMEFRAMES, comma-separated).
  const cfgTimeframes = (() => {
    const parsed = parseTimeframes(env.TIMEFRAMES);
    return parsed.length ? parsed : ['1H', '4H'];
  })();
  // The timeframe initially selected on the dashboard. Must exist in the
  // enabled list, otherwise fall back to the first enabled one.
  let timeframe = normalizeBar(env.TIMEFRAME) || '4H';
  if (!cfgTimeframes.includes(timeframe)) timeframe = cfgTimeframes[0];

  const cfg = {
    port: int('PORT', 3000, { min: 1, max: 65535 }),
    okxBaseUrl: (env.OKX_BASE_URL || 'https://www.okx.com/api/v5').replace(/\/+$/, ''),
    timeframe,
    timeframes: cfgTimeframes,
    candlesLimit: int('CANDLES_LIMIT', 120, { min: 2, max: 300 }),
    // Resolution of the series used to compute the dashboard's
    // "change over 5m / 15m / 1h / 4h" windows (default: 5-minute candles).
    changeBar: (env.CHANGE_BAR || '5m').trim(),
    scanIntervalMinutes: int('SCAN_INTERVAL_MINUTES', 15, { min: 1, max: 59 }),
    scanCron: env.SCAN_CRON || '',
    // Watchdog: if a scan cycle runs longer than this (minutes) the scheduler
    // force-releases its single-flight latch so the next tick can start fresh
    // instead of skipping forever. Default: at least the scan interval (min 25).
    cycleTimeoutMinutes: int('CYCLE_TIMEOUT_MINUTES', 0, { min: 0 }),
    // Marks the dashboard/API "stale" when the last successful scan is older
    // than this many multiples of the scan interval.
    staleFactor: num('STALE_FACTOR', 1.5, { min: 1 }),
    emaFast: int('EMA_FAST', 9, { min: 1 }),
    emaSlow: int('EMA_SLOW', 21, { min: 1 }),
    rsiPeriod: int('RSI_PERIOD', 14, { min: 2 }),
    rsiMin: num('RSI_MIN', 45),
    rsiMax: num('RSI_MAX', 65),
    volumeSma: int('VOLUME_SMA', 20, { min: 1 }),
    // Liquidity filter: symbols with 24h USD volume (volCcy24h) below this are
    // skipped before any candle request. 0 disables the filter.
    minVolumeUsd24h: num('MIN_VOLUME_USD_24H', 300000, { min: 0 }),
    concurrency: int('CONCURRENCY', 6, { min: 1, max: 50 }),
    requestsPer2s: int('REQUESTS_PER_2S', 16, { min: 1 }),
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 10000, { min: 1000, max: 120000 }),
    retryDelayMs: int('RETRY_DELAY_MS', 600, { min: 0, max: 60000 }),
    retentionDays: int('RETENTION_DAYS', 30, { min: 0 }),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',
    dryRun: bool('DRY_RUN', false),
  };

  const merged = { ...cfg, ...overrides };
  if (merged.emaSlow <= merged.emaFast) {
    merged.emaSlow = merged.emaFast + 1;
  }
  if (merged.rsiMax < merged.rsiMin) {
    const t = merged.rsiMin;
    merged.rsiMin = merged.rsiMax;
    merged.rsiMax = t;
  }
  return merged;
}

module.exports = { readConfig };