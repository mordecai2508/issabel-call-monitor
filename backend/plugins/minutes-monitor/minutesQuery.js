'use strict';

/**
 * minutesQuery.js — rango del mes y queries CDR del plugin minutes-monitor
 * (feature #55). SOLO lecturas, siempre sargables sobre `calldate`
 * (`calldate >= ? AND calldate < ?`, sin funciones sobre la columna) para
 * aprovechar el índice existente (R2–R6, R8).
 */

const SQL_TOTAL = `
  SELECT COALESCE(ROUND(SUM(billsec) / 60, 2), 0) AS minutos,
         COUNT(*)                                 AS llamadas
  FROM cdr
  WHERE calldate >= ? AND calldate < ?
    AND disposition = 'ANSWERED'
`;

const SQL_TRONCALES = `
  SELECT SUBSTRING_INDEX(dstchannel, '-', 1)      AS troncal,
         COALESCE(ROUND(SUM(billsec) / 60, 2), 0) AS minutos,
         COUNT(*)                                 AS llamadas
  FROM cdr
  WHERE calldate >= ? AND calldate < ?
    AND disposition = 'ANSWERED'
    AND dstchannel IS NOT NULL AND dstchannel <> ''
  GROUP BY SUBSTRING_INDEX(dstchannel, '-', 1)
  ORDER BY minutos DESC
  LIMIT 100
`;

/**
 * SQL por extensión con placeholders generados para N números (patrón de
 * statsService.js). Solo se usa si hay extensiones monitoreadas (R5).
 *
 * @param {number} count
 * @returns {string}
 */
function buildExtensionsSql(count) {
  const placeholders = Array.from({ length: count }, () => '?').join(',');
  return `
    SELECT src                                      AS extension,
           COALESCE(ROUND(SUM(billsec) / 60, 2), 0) AS minutos,
           COUNT(*)                                 AS llamadas
    FROM cdr
    WHERE calldate >= ? AND calldate < ?
      AND disposition = 'ANSWERED'
      AND src IN (${placeholders})
    GROUP BY src
  `;
}

/**
 * Delimita el mes en curso en la zona horaria de la BD (R3).
 * Mismo patrón de parsing de offset `±HH:MM` que `todayRange()` de server.js:
 * desplaza el instante al offset y lee la fecha con getUTC*.
 *
 * @param {string} dbTimezone p. ej. "-05:00"
 * @param {number} [nowMs] instante de referencia (tests deterministas)
 * @returns {{ from: string, to: string, mes: string }}
 *   from = primer día del mes 00:00:00; to = inicio del día siguiente
 *   (exclusivo); mes = 'YYYY-MM'.
 */
function monthRange(dbTimezone, nowMs = Date.now()) {
  const p = n => String(n).padStart(2, '0');

  const match = typeof dbTimezone === 'string'
    ? dbTimezone.match(/^([+-])(\d{2}):(\d{2})$/)
    : null;
  const offsetMinutes = match
    ? (match[1] === '+' ? 1 : -1) * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10))
    : 0;

  const nowInTz = new Date(nowMs + offsetMinutes * 60_000);
  const y = nowInTz.getUTCFullYear();
  const m = nowInTz.getUTCMonth();
  const d = nowInTz.getUTCDate();

  const from     = `${y}-${p(m + 1)}-01 00:00:00`;
  const tomorrow = new Date(Date.UTC(y, m, d + 1));
  const to       = `${tomorrow.getUTCFullYear()}-${p(tomorrow.getUTCMonth() + 1)}-${p(tomorrow.getUTCDate())} 00:00:00`;

  return { from, to, mes: `${y}-${p(m + 1)}` };
}

/**
 * Ejecuta la medición del mes: total global, desglose por troncal y (si hay
 * extensiones monitoreadas) desglose por origen — en Promise.all sobre el
 * pool compartido (R2, R4, R5, R6, R8).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ from: string, to: string, mes: string }} range
 * @param {Array<{ numero: string }>} [extensiones]
 * @returns {Promise<{
 *   timestamp: string, mes: string,
 *   total: { minutos: number, llamadas: number },
 *   troncales: Array<{ troncal: string, minutos: number, llamadas: number }>,
 *   extensionesRaw: Array<{ extension: string, minutos: number, llamadas: number }>,
 * }>}
 */
async function queryMonth(pool, range, extensiones = []) {
  const params  = [range.from, range.to];
  const numeros = extensiones.map(e => e.numero);

  const [totalRes, troncalesRes, extRes] = await Promise.all([
    pool.query(SQL_TOTAL, params),
    pool.query(SQL_TRONCALES, params),
    numeros.length > 0
      ? pool.query(buildExtensionsSql(numeros.length), [...params, ...numeros])
      : Promise.resolve([[]]),
  ]);

  const totalRow      = (totalRes[0] && totalRes[0][0]) || {};
  const troncalesRows = troncalesRes[0] || [];
  const extRows       = extRes[0] || [];

  return {
    timestamp: new Date().toISOString(),
    mes: range.mes,
    total: {
      minutos:  Number(totalRow.minutos)  || 0,
      llamadas: Number(totalRow.llamadas) || 0,
    },
    troncales: troncalesRows.map(r => ({
      troncal:  String(r.troncal),
      minutos:  Number(r.minutos)  || 0,
      llamadas: Number(r.llamadas) || 0,
    })),
    extensionesRaw: extRows.map(r => ({
      extension: String(r.extension),
      minutos:   Number(r.minutos)  || 0,
      llamadas:  Number(r.llamadas) || 0,
    })),
  };
}

module.exports = { monthRange, queryMonth, buildExtensionsSql, SQL_TOTAL, SQL_TRONCALES };
