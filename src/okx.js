'use strict';

const logger = require('./logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * OKX public market-data client.
 *
 * Implements a rate limiter suitable for scanning hundreds of symbols:
 *  - a concurrency limit (max parallel in-flight requests)
 *  - a sliding window that prevents starting more than `requestsPer2s`
 *    requests per 2 seconds (OKX public limit is ~20 req / 2s per IP,
 *    we keep a safety margin, default 16).
 */
class OkxClient {
  constructor(config) {
    this.base = config.okxBaseUrl;
    this.timeout =
      config.requestTimeoutMs != null
        ? config.requestTimeoutMs
        : config.timeout != null
        ? config.timeout
        : 10000;
    this.concurrency = config.concurrency;
    this.reqsPerWindow = config.requestsPer2s;
    this.windowMs = 2000;
    this.retryDelayMs = config.retryDelayMs || 600;

    this.active = 0;
    this.recentStarts = [];
  }

  _pruneWindow(now) {
    const cutoff = now - this.windowMs;
    while (this.recentStarts.length && this.recentStarts[0] < cutoff) {
      this.recentStarts.shift();
    }
  }

  async _reserveSlot() {
    // Poll until both the concurrency slot and the time window allow a request.
    for (;;) {
      const now = Date.now();
      this._pruneWindow(now);
      if (this.active < this.concurrency && this.recentStarts.length < this.reqsPerWindow) {
        this.active++;
        this.recentStarts.push(now);
        return;
      }
      await sleep(150);
    }
  }

  async _fetchJson(path) {
    const url = `${this.base}${path}`;
    await this._reserveSlot();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      });
      let body;
      try {
        body = await res.json();
      } catch (_) {
        throw new Error(`non-JSON response (HTTP ${res.status}) for ${path}`);
      }
      if (!res.ok || !body || body.code !== '0') {
        throw new Error(
          `OKX error: HTTP ${res.status} code=${body && body.code} msg=${body && body.msg} for ${path}`
        );
      }
      return body.data;
    } finally {
      clearTimeout(timer);
      this.active--;
    }
  }

  /**
   * Fetch with one retry + small backoff for transient failures (network / 429).
   */
  async fetchJson(path, retries = 1) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this._fetchJson(path);
      } catch (err) {
        lastErr = err;
        logger.warn(`OKX request failed (${err.message}) attempt ${attempt + 1}/${retries + 1}`);
        if (attempt < retries) await sleep(this.retryDelayMs * (attempt + 1));
      }
    }
    throw lastErr;
  }

  /** All live UDST-quoted SPOT instruments, e.g. ["BTC-USDT", "ETH-USDT", ...]. */
  async getUsdtInstruments() {
    const data = await this.fetchJson('/public/instruments?instType=SPOT');
    if (!Array.isArray(data)) throw new Error('Unexpected instruments response');
    return data
      .filter((inst) => inst.state === 'live' && inst.quoteCcy === 'USDT')
      .map((inst) => inst.instId);
  }

  /**
   * Tickers for all SPOT pairs (single request). Returns objects with
   * `instId`, `volCcy24h` (24h volume in quote currency, i.e. USD for USDT
   * pairs) and `last` (last traded price) — used by the liquidity filter and
   * the dashboard's live "current price" column.
   */
  async getTickers() {
    const data = await this.fetchJson('/market/tickers?instType=SPOT');
    if (!Array.isArray(data)) throw new Error('Unexpected tickers response');
    return data.map((t) => ({
      instId: t.instId,
      volCcy24h: Number(t.volCcy24h) || 0,
      last: Number(t.last) || null,
    }));
  }

  /**
   * Candles for a symbol, oldest → newest.
   * Each candle: { ts, open, high, low, close, volume, confirm }
   * `confirm === 1` means the candle is closed/complete (OKX field).
   */
  async getCandles(instId, bar, limit) {
    const path = `/market/candles?instId=${encodeURIComponent(instId)}&bar=${encodeURIComponent(bar)}&limit=${limit}`;
    const data = await this.fetchJson(path);
    if (!Array.isArray(data)) throw new Error(`Unexpected candles response for ${instId}`);
    return data
      .map((row) => ({
        ts: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        confirm: Number(row[8]),
      }))
      .reverse(); // OKX returns newest first → flip to oldest first
  }
}

module.exports = { OkxClient };