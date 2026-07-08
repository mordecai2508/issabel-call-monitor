'use strict';

const DEFAULT_TIMEOUT_MS  = 5_000;
const DEFAULT_INTERVAL_MS = 15_000;

/**
 * Factory for the PBX connection health service (feature #14 — pbx_health).
 *
 * Maintains an in-memory snapshot of the connectivity status to the Issabel
 * MySQL database (`{ connected, lastCheck, lastError, latencyMs }`), updated
 * via a lightweight `SELECT 1` probe with a bounded timeout. On status
 * transitions it broadcasts a `pbx_status` SSE event via the provided
 * `broadcast` function (R11/R12/R13).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {(event: string, data: any) => void} broadcast
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{
 *   check: () => Promise<object>,
 *   getStatus: () => object,
 *   ensureChecked: () => Promise<object>,
 *   start: (intervalMs?: number) => () => void,
 * }}
 */
module.exports = function createPbxHealthService(pool, broadcast, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  let state = {
    connected: false,
    lastCheck: null,
    lastError: null,
    latencyMs: null,
  };

  let hasCheckedOnce = false;

  function getStatus() {
    return { ...state };
  }

  async function check() {
    const startedAt = Date.now();
    const previousConnected = state.connected;
    const wasFirstCheck = !hasCheckedOnce;

    let connected = false;
    let lastError = null;
    let timeoutHandle;

    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_resolve, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Timeout al verificar la conexión')), timeoutMs);
        }),
      ]);
      connected = true;
    } catch (err) {
      connected = false;
      lastError = err.message;
    } finally {
      clearTimeout(timeoutHandle);
    }

    const latencyMs = Date.now() - startedAt;

    state = {
      connected,
      lastCheck: new Date().toISOString(),
      lastError,
      latencyMs,
    };

    hasCheckedOnce = true;

    if (!wasFirstCheck && connected !== previousConnected) {
      broadcast('pbx_status', getStatus());
    }

    return getStatus();
  }

  async function ensureChecked() {
    if (state.lastCheck === null) {
      return check();
    }
    return getStatus();
  }

  function start(intervalMs = DEFAULT_INTERVAL_MS) {
    const timer = setInterval(() => {
      check().catch(err => console.error('[pbxHealth] check:', err.message));
    }, intervalMs);

    return function stop() {
      clearInterval(timer);
    };
  }

  return { check, getStatus, ensureChecked, start };
};
