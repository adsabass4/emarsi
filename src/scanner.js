'use strict';

const logger = require('./logger');
const { ema, sma, rsi, lastCrossIndex } = require('./indicators');

// Change windows shown in the dashboard (minutes → stored column name).
const CHANGE_WINDOWS = [
  { field: 'change_5m', minutes: 5 },
  { field: 'change_15m', minutes: 15 },
  { field: 'change_1h', minutes: 60 },
  { field: 'change_4h', minutes: 240 },
];

/** Convert an OKX bar token ("5m", "4H", "1D") to milliseconds, or null. */
function barToMs(bar) {
  const m = /^(\d+)([mHhDdWw])$/.exec(String(bar || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const unitMs =
    unit === 'm' ? 60 * 1000 : unit === 'h' ? 3600 * 1000 : unit === 'd' ? 86400 * 1000 : 7 * 86400 * 1000;
  return n * unitMs;
}

/**
 * "Change over period" for each window. The reference "now" price is the close
 * of the most recent candle in the series (includes the currently-forming
 * candle → as live as the API allows). Older prices come from N candles back.
 */
function computeChanges(candles, barMs) {
  const res = { change_5m: null, change_15m: null, change_1h: null, change_4h: null };
  if (!candles || candles.length < 2 || !barMs) return res;
  const closes = candles.map((c) => c.close);
  const now = closes[closes.length - 1];
  if (!Number.isFinite(now) || now <= 0) return res;
  for (const w of CHANGE_WINDOWS) {
    const barsBack = Math.round(((w.minutes * 60 * 1000) / barMs));
    const idx = closes.length - 1 - barsBack;
    if (barsBack < 1 || idx < 0 || !Number.isFinite(closes[idx]) || closes[idx] <= 0) continue;
    const pct = ((now - closes[idx]) / closes[idx]) * 100;
    res[w.field] = Math.round(pct * 100) / 100;
  }
  return res;
}

/**
 * Approximate the price where EMA9 crossed above EMA21 (the "green triangle"
 * on a chart): the fast/slow gaps are interpolated linearly between the two
 * closed candles straddling the cross, and the cross price is read at the
 * interpolation point on the line between their closes.
 *
 * @param closed  array of CLOSED candles ({ts, close})
 * @param fast    EMA-fast series over the same candles
 * @param slow    EMA-slow series over the same candles
 * @param crossTs ts of the detection candle (optional; otherwise the last
 *                upward cross in the series is used)
 * @returns interpolated cross price, or null if no usable upcross is found
 */
function emaCrossPrice(closed, fast, slow, crossTs) {
  if (!Array.isArray(closed) || closed.length < 2 || !Array.isArray(fast) || !Array.isArray(slow)) return null;
  const n = closed.length;
  let j = -1;
  if (crossTs != null) {
    for (let i = 1; i < n; i++) {
      if (closed[i].ts === crossTs) {
        j = i;
        break;
      }
    }
  }
  if (j < 0) {
    // Fallback: the last upward EMA cross in the fetched window.
    for (let i = n - 1; i >= 1; i--) {
      if (fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]) {
        j = i;
        break;
      }
    }
  }
  if (j < 1) return null;
  if (!(fast[j] > slow[j] && fast[j - 1] <= slow[j - 1])) return null;
  const c0 = closed[j - 1].close;
  const c1 = closed[j].close;
  if (!Number.isFinite(c0) || !Number.isFinite(c1)) return null;
  const g0 = fast[j - 1] - slow[j - 1];
  const g1 = fast[j] - slow[j];
  const denom = g0 - g1;
  if (denom === 0) return c1;
  const t = Math.min(1, Math.max(0, g0 / denom));
  return Math.round((c0 + t * (c1 - c0)) * 1e10) / 1e10;
}

/**
 * Run one full scan cycle:
 *   1. fetch all live USDT spot instruments
 *   2. liquidity-filter symbols by 24h USD volume (single tickers request)
 *   3. for each symbol and each enabled timeframe (TIMEFRAMES): fetch candles,
 *      compute EMA fast/slow, RSI, volume SMA, evaluate the 3-condition match
 *   4. persist one row per (symbol, timeframe)
 *   5. send a Telegram alert per newly matched (symbol, timeframe), deduped
 *
 * `deps` allows injecting fakes in tests: { okx, db, telegram, OkxClient }.
 */
async function runScan(config, deps = {}) {
  const { OkxClient } = deps.OkxClient ? { OkxClient: deps.OkxClient } : require('./okx');
  const okx = deps.okx || new OkxClient(config);
  const dbm = deps.db || require('./db');
  const telegram = deps.telegram || require('./telegram');

  const now = Date.now();
  dbm.setState('status', 'running');
  dbm.setState('last_scan_start_ms', String(now));

  const stats = { instruments: 0, filtered: 0, candlesOk: 0, errors: 0, matched: 0, notEnough: 0 };

  const retentionDays = config.retentionDays || 0;
  if (retentionDays > 0) {
    try {
      dbm.pruneScans(now - retentionDays * 24 * 3600 * 1000);
    } catch (err) {
      logger.warn(`Scans pruning failed: ${err.message}`);
    }
  }

  try {
    const instruments = await okx.getUsdtInstruments();
    if (!Array.isArray(instruments)) throw new Error('getUsdtInstruments returned non-array');
    stats.instruments = instruments.length;

    // Tickers are fetched ONCE per cycle: they drive the liquidity filter AND
    // supply the live "current price" for every symbol. If the request fails,
    // the filter is skipped and live prices are stored as null.
    let filtered = instruments;
    const tickers = new Map();
    try {
      const list = await okx.getTickers();
      for (const t of list) tickers.set(t.instId, t);
      if (config.minVolumeUsd24h > 0) {
        filtered = instruments.filter((id) => (tickers.get(id)?.volCcy24h || 0) >= config.minVolumeUsd24h);
        stats.filtered = instruments.length - filtered.length;
        logger.info(
          `Liquidity filter: ${filtered.length}/${instruments.length} USDT pairs kept (≥ ${config.minVolumeUsd24h} USDT/24h; excluded ${stats.filtered})`
        );
      }
    } catch (err) {
      logger.warn(`Tickers fetch failed (${err.message}) — liquidity filter skipped this cycle`);
    }

    dbm.setState('last_cycle_total', String(stats.instruments));
    dbm.setState('last_cycle_after_filter', String(filtered.length));
    logger.info(`Scan cycle started: ${filtered.length}/${instruments.length} USDT pairs`);

    // Change-window series (a short timeframe like 5m is enough to cover all
    // windows up to 4h with a single extra request per symbol).
    const changeBarMs = barToMs(config.changeBar);
    if (!changeBarMs) {
      logger.error(`Unrecognized CHANGE_BAR "${config.changeBar}" → falling back to 5m`);
    }
    const barMs = changeBarMs || 5 * 60 * 1000;
    const changeLimit = Math.min(300, Math.max(10, Math.ceil((240 * 60 * 1000) / barMs) + 5));

    for (const instId of filtered) {
      // The short "change" series is independent of the analysis timeframe →
      // fetch it once per symbol and derive all change windows. Failures only
      // blank the change values; they never kill the symbol or a timeframe.
      let changes = { change_5m: null, change_15m: null, change_1h: null, change_4h: null };
      try {
        const short = await okx.getCandles(instId, config.changeBar || '5m', changeLimit);
        changes = computeChanges(short, barMs);
      } catch (err) {
        logger.warn(`Change series unavailable for ${instId}: ${err.message}`);
      }

      // Indicators + matching are computed independently per timeframe, so a
      // symbol can match on 1H only, 4H only, or both at the same time.
      for (const tf of config.timeframes) {
        let candles;
        try {
          candles = await okx.getCandles(instId, tf, config.candlesLimit);
        } catch (err) {
          stats.errors++;
          logger.warn(`Skip ${instId}@${tf} (candles fetch failed): ${err.message}`);
          continue;
        }

        const closed = candles.filter((c) => c && c.confirm === 1);
        if (closed.length < Math.max(config.emaSlow, config.rsiPeriod, config.volumeSma) + 3) {
          stats.notEnough++;
          logger.warn(`Skip ${instId}@${tf}: not enough closed candles (${closed.length})`);
          continue;
        }

        const closes = closed.map((c) => c.close);
        const fast = ema(closes, config.emaFast);
        const slow = ema(closes, config.emaSlow);
        const rsiSeries = rsi(closes, config.rsiPeriod);
        const volumes = closed.map((c) => c.volume);
        const avgVol = sma(volumes, config.volumeSma);
        const last = closed[closed.length - 1];
        const prev = closed[closed.length - 2];

        // Find crossover with max lookback of 10 candles and verify current state is bullish.
        const crossIdx = lastCrossIndex(fast, slow, 10);
        const emaCross = crossIdx >= 0;
        
        // Current RSI (for DB storage and dashboard display).
        const rsiCurrent = rsiSeries ? rsiSeries[closes.length - 1] : null;

        const changePct =
          prev && prev.close ? ((last.close - prev.close) / prev.close) * 100 : null;

        let volumeOk = false;
        let rsiOk = false;
        let matched = false;
        let crossTs = last.ts;
        let crossPrice = last.close;
        let crossRsi = null;

        if (emaCross) {
          // Check RSI and volume on the CROSS candle, not the last candle.
          crossRsi = rsiSeries[crossIdx];
          const crossVol = closed[crossIdx].volume;
          volumeOk = avgVol !== null && avgVol > 0 && crossVol > avgVol;
          rsiOk = crossRsi !== null && crossRsi >= config.rsiMin && crossRsi <= config.rsiMax;
          matched = volumeOk && rsiOk;
          crossTs = closed[crossIdx].ts;
          crossPrice = closed[crossIdx].close;
        }

        dbm.insertScan({
          symbol: instId,
          timeframe: tf,
          timestamp: now,
          price: last.close,
          ticker_price: tickers.get(instId)?.last ?? null,
          rsi: rsiCurrent === null ? null : Math.round(rsiCurrent * 100) / 100,
          ema_cross: emaCross ? 1 : 0,
          volume_ok: volumeOk ? 1 : 0,
          matched: matched ? 1 : 0,
          change_pct: changePct === null ? null : Math.round(changePct * 10000) / 100,
          last_candle_ts: last.ts,
          ...changes,
        });

        stats.candlesOk++;

        if (matched) {
          stats.matched++;
          // Interpolated cross price for storage.
          const prevAlert = dbm.getAlert(instId, tf);
          const crossRef = prevAlert && prevAlert.cross_ts != null ? prevAlert.cross_ts : crossTs;
          const signalPrice = emaCrossPrice(closed, fast, slow, crossRef);
          await handleMatch(config, dbm, telegram, instId, tf, last.close, crossRsi, crossTs, signalPrice, crossPrice);
        } else if (dbm.getAlert(instId, tf)) {
          // This timeframe stopped matching → allow a future re-match to alert
          // again for this timeframe only.
          dbm.deleteAlert(instId, tf);
          logger.info(`Alert cleared for ${instId}@${tf} (no longer matching)`);
        }
      }
    }

    dbm.setState('status', 'idle');
    dbm.setState('last_scan_ms', String(now));
    dbm.setState('last_scan_start_ms', '');
    dbm.setState('last_scan_count', String(stats.candlesOk));
    dbm.setState('last_scan_matched', String(stats.matched));
    dbm.setState('last_scan_duration_ms', String(Date.now() - now));
    dbm.setState('last_error', '');

    logger.info(
      `Scan done in ${Date.now() - now}ms | symbols=${stats.candlesOk} errors=${stats.errors} ` +
        `notEnough=${stats.notEnough} matched=${stats.matched} excludedByLiquidity=${stats.filtered}`
    );
    return { ok: true, stats };
  } catch (err) {
    dbm.setState('status', 'error');
    dbm.setState('last_error', err.message);
    dbm.setState('last_scan_start_ms', '');
    logger.error(`Scan cycle failed: ${err.message}`);
    return { ok: false, error: err.message, stats };
  }
}

/**
 * Alert dedup (per symbol + timeframe):
 *  - always records the FIRST detection time (detected_at) on match, so the
 *    dashboard's "وقت الاكتشاف" works even if Telegram is not configured or
 *    the send fails;
 *  - `crossTs` is the candle where the signal first appeared — stored once and
 *    never refreshed, so "الشموع منذ الاكتشاف" grows while the signal stays
 *    matching (an old signal shows a bigger number);
 *  - `alerts.sent` flags whether the message was delivered: 0 → retried on
 *    the next cycle, 1 → deduped (only last_seen_at refreshed).
 */
async function handleMatch(config, dbm, telegram, instId, timeframe, price, rsv, crossTs, signalPrice, crossPrice) {
  const existing = dbm.getAlert(instId, timeframe);
  const msg = telegram.formatAlert(instId, price, rsv, timeframe, crossPrice);

  if (existing) {
    // Backfill the signal price for alerts created before the column existed
    // (kept null-checked so it never overwrites a stored value).
    if (existing.cross_price == null && signalPrice != null) {
      dbm.backfillCrossPrice(instId, timeframe, signalPrice);
    }
    if (existing.sent) {
      dbm.insertAlert(instId, timeframe, existing.detected_at, Date.now(), 1, existing.cross_ts, existing.cross_price);
      return { newAlert: false };
    }
    // Detection already recorded but the message was never delivered → retry.
    if (config.dryRun) {
      logger.info(`[DRY-RUN] would send Telegram alert: ${msg}`);
      dbm.markSent(instId, timeframe, Date.now());
      return { newAlert: true, dryRun: true };
    }
    const sent = await telegram.sendMessage(config, msg);
    if (!sent) return { newAlert: false, sent: false };
    dbm.markSent(instId, timeframe, Date.now());
    return { newAlert: true, sent: true };
  }

  // First detection on this (symbol, timeframe): record immediately. `price`
  // is the current signal close; `signalPrice` is the interpolated EMA cross
  // price stored once as `cross_price` so the dashboard can show the real move
  // since the signal while it stays matching.
  if (config.dryRun) {
    logger.info(`[DRY-RUN] would send Telegram alert: ${msg}`);
    dbm.insertAlert(instId, timeframe, Date.now(), Date.now(), 1, crossTs, signalPrice);
    return { newAlert: true, dryRun: true };
  }

  dbm.insertAlert(instId, timeframe, Date.now(), Date.now(), 0, crossTs, signalPrice);
  const sent = await telegram.sendMessage(config, msg);
  if (sent) dbm.markSent(instId, timeframe, Date.now());
  return { newAlert: true, sent };
}

module.exports = { runScan, handleMatch };