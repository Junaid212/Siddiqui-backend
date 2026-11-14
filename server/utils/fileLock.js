/**
 * fileLock.js — a cross-PROCESS mutex for one machine, with no database change.
 *
 * Creating a directory is atomic on the local file system: exactly one process succeeds, the others see EEXIST and
 * wait. Combined with the in-process queue in payhipController this makes duplicate webhook deliveries safe even when
 * the API runs as several processes (e.g. PM2 cluster mode) on the SAME server. It does not cover several servers
 * sharing one database; that still needs the unique index documented in docs/STAGE0-SECURITY.md.
 *
 * A lock whose owner died is reclaimed after `staleMs`, so a crash can never block payments for long.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const baseDir = () => process.env.WEBHOOK_LOCK_DIR || path.join(os.tmpdir(), 'siddiqui-webhook-locks');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withFileLock(name, fn, { timeoutMs = 30000, staleMs = 60000, pollMs = 25 } = {}) {
  const dir = baseDir();
  fs.mkdirSync(dir, { recursive: true });
  // the name is hashed: an attacker-controlled transaction id can never become a path
  const lockPath = path.join(dir, crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 40) + '.lock');
  const started = Date.now();

  for (;;) {
    try {
      fs.mkdirSync(lockPath); // atomic: only one process gets past this line
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) { // owner presumably crashed
          fs.rmdirSync(lockPath);
          continue;
        }
      } catch { /* released between our checks: just retry */ }
      if (Date.now() - started > timeoutMs) {
        const e = new Error('Could not obtain the transaction lock in time');
        e.code = 'LOCK_TIMEOUT';
        throw e;
      }
      await sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.rmdirSync(lockPath); } catch { /* already reclaimed as stale */ }
  }
}

module.exports = { withFileLock };
