'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const MAX_SIZE = 5 * 1024 * 1024; // rotate when > 5MB

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function rotateIfNeeded() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch (_) {
    /* ignore rotation errors */
  }
}

function write(line) {
  try {
    ensureDir();
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {
    /* never let logging crash the app */
  }
}

function levelToConsole(level, line) {
  // Always mirror to stdout/stderr so `docker compose logs` works too.
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

function log(level, msg, extra) {
  const suffix = extra !== undefined ? ` | ${JSON.stringify(extra)}` : '';
  const line = `${new Date().toISOString()} [${level}] ${msg}${suffix}`;
  write(line);
  levelToConsole(level, line);
}

module.exports = {
  info: (msg, extra) => log('INFO', msg, extra),
  warn: (msg, extra) => log('WARN', msg, extra),
  error: (msg, extra) => log('ERROR', msg, extra),
};