'use strict';

const AsteriskManager = require('asterisk-manager');

const DEFAULT_TIMEOUT_MS  = 5_000;
const DEFAULT_INTERVAL_MS = 30_000;

// Only chan_sip peers whose ObjectName is purely numeric are treated as
// extensions; alphanumeric/underscore names (e.g. `ENT_LIWA`,
// `NET2_ENT_6076854970`, `VIRTUAL_TRUNK_SALIENTE`) are trunks and are
// excluded entirely (R23).
const EXTENSION_NAME_RE = /^\d+$/;

const EMPTY_STATE = Object.freeze({
  total: 0,
  active: 0,
  extensions: [],
  available: false,
});

// Trunk peers are non-numeric SIP peers (e.g. ENT_LIWA, NET2_TRUNK).
// status: 'up' when AMI reports OK/LAGGED, 'down' otherwise.
const EMPTY_TRUNK_STATE = Object.freeze({ trunks: [], available: false });

/**
 * Factory for the AMI extensions status service (feature #18 —
 * dashboard_extensions_status — corrected for chan_sip by #19 —
 * dashboard_extensions_chan_sip_fix).
 *
 * Maintains an in-memory snapshot of chan_sip peer registration status
 * (`{ total, active, extensions: [{ extension, status }], available }`),
 * refreshed periodically via the read-only AMI action `SIPpeers`.
 *
 * - If `amiConfig` is missing or incomplete (R1/R2), the integration is
 *   treated as "not configured": no AMI connection is ever attempted and
 *   `getStatus()` always returns the empty/unavailable state.
 * - On connection/query failure, the previously cached successful result is
 *   retained if one exists (R10); otherwise the empty/unavailable state is
 *   kept. Failures are logged via `console.error` without exposing
 *   credentials (R11/R20).
 * - Only read-only AMI actions are issued (R5/R19).
 *
 * @param {{ host?: string, port?: number, username?: string, password?: string }|undefined|null} amiConfig
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{
 *   check: () => Promise<object>,
 *   getStatus: () => object,
 *   start: (intervalMs?: number) => () => void,
 * }}
 */
module.exports = function createAmiExtensionsService(amiConfig, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  const configured = Boolean(
    amiConfig &&
    amiConfig.host &&
    amiConfig.port &&
    amiConfig.username &&
    amiConfig.password,
  );

  let state = { ...EMPTY_STATE };
  let trunkState = { ...EMPTY_TRUNK_STATE };
  let hasSucceededOnce = false;
  let ami = null;

  if (configured) {
    ami = new AsteriskManager(amiConfig.port, amiConfig.host, amiConfig.username, amiConfig.password, false);
    // Prevent unhandled 'error' events from crashing the process (R11).
    ami.on('error', (err) => {
      console.error('[ami] connection error:', err.message);
    });
  }

  function getStatus() {
    return { ...state, extensions: state.extensions.map(e => ({ ...e })) };
  }

  /**
   * Returns a snapshot of non-numeric SIP peers (trunks).
   * Each entry: { trunk: string, status: 'up'|'down', rawStatus: string }
   * `available: false` when AMI has never returned a successful result.
   */
  function getTrunksStatus() {
    return { available: trunkState.available, trunks: trunkState.trunks.map(t => ({ ...t })) };
  }

  /**
   * Returns the status for a single trunk peer name (the part after SIP/).
   * Returns null when AMI hasn't succeeded yet or the trunk isn't known.
   * @param {string} peerName
   */
  function getTrunkStatus(peerName) {
    return trunkState.trunks.find(t => t.trunk === peerName) || null;
  }

  function isConfigured() {
    return configured;
  }

  /**
   * Sends the `SIPpeers` AMI action and accumulates the `PeerEntry` events
   * (one per chan_sip peer) until `PeerlistComplete`.
   *
   * Field mapping (R22, verified against Asterisk chan_sip AMI output):
   * - `extension`: `ObjectName` field of each `PeerEntry` event — the
   *   chan_sip peer name as configured (without the `/user` suffix).
   * - `status`: derived from the `Status` field (raw string, e.g.
   *   `'OK (230 ms)'`, `'UNKNOWN'`, `'UNREACHABLE'`, `'Unmonitored'`, or
   *   absent/empty). Normalized to uppercase: values starting with `'OK'`
   *   or `'LAGGED'` map to `'active'`; any other value (including
   *   `UNKNOWN`, `UNREACHABLE`, `Unmonitored`, or absent/empty) maps to
   *   `'inactive'` (R24).
   *
   * Peer filtering (R23): only peers whose `ObjectName` is purely numeric
   * (`EXTENSION_NAME_RE`) are treated as extensions and included in the
   * result; peers with non-numeric names (typically trunks, e.g.
   * `ENT_LIWA`, `NET2_ENT_6076854970`, `VIRTUAL_TRUNK_SALIENTE`) are
   * discarded entirely.
   */
  // Returns { promise, cleanup } so the caller can always remove the listener,
  // including when a timeout wins the Promise.race (the listener would otherwise
  // accumulate on every timeout, triggering MaxListenersExceededWarning).
  function queryPeers() {
    const extensions = [];
    const trunks = [];
    let onManagerEvent;

    function cleanup() {
      if (onManagerEvent) ami.removeListener('managerevent', onManagerEvent);
    }

    const promise = new Promise((resolve, reject) => {
      onManagerEvent = function (evt) {
        const eventName = String(evt.event || '').toLowerCase();

        if (eventName === 'peerentry') {
          const objectName = evt.objectname || '';
          const rawStatus  = evt.status || '';
          const peerStatus = rawStatus.toUpperCase();
          const isUp = peerStatus.startsWith('OK') || peerStatus.startsWith('LAGGED');

          if (EXTENSION_NAME_RE.test(objectName)) {
            // Numeric name → extension (R23)
            extensions.push({ extension: objectName, status: isUp ? 'active' : 'inactive' });
          } else {
            // Non-numeric name → trunk
            trunks.push({ trunk: objectName, status: isUp ? 'up' : 'down', rawStatus });
          }
        } else if (eventName === 'peerlistcomplete') {
          cleanup();
          resolve({ extensions, trunks });
        }
      };

      ami.on('managerevent', onManagerEvent);

      ami.action({ action: 'SIPpeers' }, (err) => {
        if (err) {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err.message || 'Error AMI')));
        }
        // On success, the response itself carries no peer data — the peers
        // arrive as `PeerEntry`/`PeerlistComplete` events handled above.
      });
    });

    return { promise, cleanup };
  }

  async function check() {
    if (!configured) {
      return getStatus();
    }

    let timeoutHandle;
    const { promise: peersPromise, cleanup } = queryPeers();

    try {
      const { extensions, trunks } = await Promise.race([
        peersPromise,
        new Promise((_resolve, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Timeout al consultar extensiones AMI')), timeoutMs);
        }),
      ]);

      const total  = extensions.length;
      const active = extensions.filter(e => e.status === 'active').length;

      state      = { total, active, extensions, available: true };
      trunkState = { trunks, available: true };
      hasSucceededOnce = true;
    } catch (err) {
      console.error('[ami] SIPpeers failed:', err.message);
      if (!hasSucceededOnce) {
        state      = { ...EMPTY_STATE };
        trunkState = { ...EMPTY_TRUNK_STATE };
      }
      // else: retain the previously cached successful result (R10)
    } finally {
      clearTimeout(timeoutHandle);
      cleanup(); // always remove the managerevent listener, even on timeout
    }

    return getStatus();
  }

  function start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (!configured) {
      return function stop() {};
    }

    const timer = setInterval(() => {
      check().catch(err => console.error('[ami] check:', err.message));
    }, intervalMs);

    return function stop() {
      clearInterval(timer);
    };
  }

  return { check, getStatus, getTrunksStatus, getTrunkStatus, isConfigured, start };
};
