'use strict';

const DEFAULT_CONNECTION_LIMIT = 3;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS     = 15_000;
const INDEX_CHECK_TIMEOUT_MS   = 5_000;

/**
 * Resuelve el límite de conexiones del pool MySQL (feature #53 — db_load_safeguards).
 *
 * - Ausente (`undefined`) → default 3 sin log (R1).
 * - Entero >= 1 (o string que represente un entero >= 1) → valor configurado (R2).
 * - Cualquier otro valor → default 3 con advertencia en log (R3).
 *
 * @param {*} value valor de `config.db.connectionLimit`
 * @returns {number}
 */
function resolveConnectionLimit(value) {
  if (value === undefined) return DEFAULT_CONNECTION_LIMIT;

  const isNumericCandidate =
    (typeof value === 'number') ||
    (typeof value === 'string' && value.trim() !== '');
  const num = isNumericCandidate ? Number(value) : NaN;

  if (Number.isInteger(num) && num >= 1) return num;

  console.warn(`[DB] connectionLimit inválido en config.json (${JSON.stringify(value)}); usando default ${DEFAULT_CONNECTION_LIMIT}`);
  return DEFAULT_CONNECTION_LIMIT;
}

/**
 * Resuelve el intervalo de polling del broadcaster SSE (feature #53).
 *
 * - Ausente → default 60000 ms sin log (R4).
 * - Número >= 15000 → valor configurado (R5).
 * - Definido pero inválido o < 15000 → mínimo 15000 ms con advertencia (R6).
 *
 * @param {*} value valor de `config.server.pollIntervalMs`
 * @returns {number}
 */
function resolvePollIntervalMs(value) {
  if (value === undefined) return DEFAULT_POLL_INTERVAL_MS;

  const num = Number(value);

  if (Number.isFinite(num) && num >= MIN_POLL_INTERVAL_MS) return num;

  console.warn(`[POLL] pollIntervalMs=${JSON.stringify(value)} es menor que el mínimo permitido; usando ${MIN_POLL_INTERVAL_MS} ms`);
  return MIN_POLL_INTERVAL_MS;
}

/**
 * Factory del servicio de salvaguardas de BD (feature #53 — db_load_safeguards).
 *
 * Expone `checkCalldateIndex()`: chequeo informativo, de solo lectura y
 * tolerante a fallos que verifica si la tabla `cdr` tiene índice sobre
 * `calldate`. Nunca lanza, nunca escribe en la BD y nunca bloquea el
 * arranque (R7–R11).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ checkCalldateIndex: () => Promise<{ checked: boolean, hasIndex: boolean|null, error: string|null }> }}
 */
function createDbSafeguardsService(pool, options = {}) {
  const timeoutMs = options.timeoutMs || INDEX_CHECK_TIMEOUT_MS;

  async function checkCalldateIndex() {
    let timeoutHandle;
    try {
      // Nota: SHOW INDEX no admite placeholders `?`; el filtro es un literal
      // fijo en código, nunca interpolado desde config/usuario (R11).
      const [rows] = await Promise.race([
        pool.query("SHOW INDEX FROM cdr WHERE Column_name = 'calldate'"),
        new Promise((_resolve, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Timeout al verificar el índice de calldate')), timeoutMs);
        }),
      ]);

      const hasIndex = Array.isArray(rows) && rows.length > 0;

      if (!hasIndex) {
        console.warn('[DB] ADVERTENCIA: la tabla cdr no tiene índice sobre calldate. Las consultas del monitor pueden degradar la CPU del PBX. Sugerido ejecutar en el servidor Issabel: ALTER TABLE cdr ADD INDEX idx_calldate (calldate);');
      }

      return { checked: true, hasIndex, error: null };
    } catch (err) {
      console.error('[DB] No se pudo verificar el índice de calldate:', err.message);
      return { checked: false, hasIndex: null, error: err.message };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  return { checkCalldateIndex };
}

module.exports = createDbSafeguardsService;
module.exports.resolveConnectionLimit = resolveConnectionLimit;
module.exports.resolvePollIntervalMs  = resolvePollIntervalMs;
module.exports.DEFAULT_CONNECTION_LIMIT = DEFAULT_CONNECTION_LIMIT;
module.exports.DEFAULT_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
module.exports.MIN_POLL_INTERVAL_MS     = MIN_POLL_INTERVAL_MS;
