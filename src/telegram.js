'use strict';

const logger = require('./logger');

/**
 * Send a text message to the configured Telegram chat.
 * Returns true on success, false otherwise (never throws).
 */
async function sendMessage(config, text) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    logger.warn('Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID); skipping alert');
    return false;
  }
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: String(config.telegramChatId),
        text,
        disable_web_page_preview: true,
      }),
    });
    let body;
    try {
      body = await res.json();
    } catch (_) {
      body = {};
    }
    if (!res.ok || !body.ok) {
      logger.error(`Telegram API rejected message: HTTP ${res.status} ${JSON.stringify(body)}`);
      return false;
    }
    logger.info(`Telegram alert sent: ${text}`);
    return true;
  } catch (err) {
    logger.error(`Telegram send exception: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function formatAlert(instId, price, rsiVal, timeframe, crossPrice, higherTfWarning) {
  const rs = Number.isFinite(rsiVal) ? Math.round(rsiVal * 100) / 100 : '-';
  const p = Number.isFinite(price) ? price : '-';
  const cp = Number.isFinite(crossPrice) ? crossPrice : null;
  const tf = timeframe ? ` (${timeframe})` : '';
  const priceLine = cp !== null && cp !== p ? ` | سعر التقاطع: ${cp}` : '';
  const warningLine = higherTfWarning ? `\n⚠️ تحذير: ${higherTfWarning}` : '';
  return `🔔 ${instId} — تقاطع صاعد${tf} | RSI: ${rs} | السعر: ${p}${priceLine}${warningLine}`;
}

module.exports = { sendMessage, formatAlert };