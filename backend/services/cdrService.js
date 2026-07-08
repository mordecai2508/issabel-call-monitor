'use strict';

const MAX_EXPORT_ROWS = 10000;

// #56: PJSIP/NNN- (extensiones PJSIP) y Local/NNN@ (agente contestando vía cola,
// from-queue) también son canales de agente real. Debe coincidir con
// AGENT_DSTCHANNEL_RE de server.js y statsService.js.
const AGENT_DSTCHANNEL_RE    = /^(Agent\/\d+|SIP\/\d+-|PJSIP\/\d+-|Local\/\d+@)/;
const AGENT_DSTCHANNEL_MYSQL = '^(Agent/[0-9]+|SIP/[0-9]+-|PJSIP/[0-9]+-|Local/[0-9]+@)';

// #56: applyAgentRule=false para salientes. En una llamada saliente el dstchannel
// es la troncal (no un agente), por lo que la regla #21 "ANSWERED sin agente →
// NO ANSWER" no aplica y marcaría toda saliente contestada como no contestada.
function resolveDispositionLocal(disposition, dst, dstchannel, lostDests, applyAgentRule = true) {
  const d = (disposition || '').toUpperCase();
  let key = ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED'].includes(d) ? d : null;
  if (!key) return disposition;
  // #37: BUSY se trata como NO ANSWER
  if (key === 'BUSY') key = 'NO ANSWER';
  if (lostDests.includes(dst) && key !== 'NO ANSWER') key = 'NO ANSWER';
  if (applyAgentRule && key === 'ANSWERED' && !AGENT_DSTCHANNEL_RE.test(dstchannel || '')) key = 'NO ANSWER';
  return key;
}

function buildWhereClause(filters, lostDests = []) {
  const { from, to, trunk, origin, disposition, channels } = filters;
  const conditions = [];
  const params = [];

  conditions.push('calldate >= ?');
  params.push(from + ' 00:00:00');
  conditions.push('calldate <= ?');
  params.push(to + ' 23:59:59');

  // Excluir canales internos: Local/ y extensiones SIP/PJSIP numéricas (ej. SIP/202-...)
  conditions.push("channel NOT LIKE 'Local/%'");
  conditions.push("channel NOT REGEXP '^(SIP|PJSIP)/[0-9]+'");

  if (channels && channels.length > 0) {
    const orParts = channels.map(() => "channel LIKE CONCAT(?, '%')");
    conditions.push(`(${orParts.join(' OR ')})`);
    for (const ch of channels) params.push(ch);
  }

  if (trunk) {
    conditions.push("channel LIKE CONCAT(?, '%')");
    params.push(trunk);
  }

  if (origin) {
    conditions.push("src LIKE CONCAT('%', ?, '%')");
    params.push(origin);
  }

  if (disposition) {
    // #37: filtrar por BUSY equivale a filtrar por NO ANSWER (disposición efectiva)
    const d = disposition.toUpperCase() === 'BUSY' ? 'NO ANSWER' : disposition.toUpperCase();
    if (lostDests.length > 0 && d === 'NO ANSWER') {
      const lp = lostDests.map(() => '?').join(',');
      conditions.push(
        `(UPPER(disposition) = 'NO ANSWER' OR UPPER(disposition) = 'BUSY' OR dst IN (${lp}) OR ` +
        `(UPPER(disposition) = 'ANSWERED' AND (dstchannel IS NULL OR dstchannel = '' OR dstchannel NOT REGEXP ?)))`
      );
      params.push(...lostDests, AGENT_DSTCHANNEL_MYSQL);
    } else if (lostDests.length > 0 && d === 'ANSWERED') {
      const lp = lostDests.map(() => '?').join(',');
      conditions.push(
        `(UPPER(disposition) = 'ANSWERED' AND dst NOT IN (${lp}) AND dstchannel REGEXP ?)`
      );
      params.push(...lostDests, AGENT_DSTCHANNEL_MYSQL);
    } else if (d === 'NO ANSWER') {
      // Sin lostDests: incluir filas BUSY originales también
      conditions.push("(UPPER(disposition) = 'NO ANSWER' OR UPPER(disposition) = 'BUSY')");
    } else {
      conditions.push('UPPER(disposition) = UPPER(?)');
      params.push(d);
    }
  }

  return { conditions, params };
}

/**
 * Convierte un valor calldate (objeto Date de mysql2 o string ISO) al
 * formato 'YYYY-MM-DD HH:MM:SS' usando el offset de timezone del servidor.
 *
 * @param {Date|string} value    - El valor crudo de mysql2
 * @param {string}      tzOffset - Ej: "-05:00", "+00:00". Default: "+00:00"
 * @returns {string}  Ej: "2026-06-24 17:30:34"
 */
function formatCalldateLocal(value, tzOffset) {
  // 1. Obtener el timestamp Unix en ms
  const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (isNaN(ts)) return String(value); // fallback: devolver tal cual

  // 2. Parsear el offset "-05:00" → -300 minutos
  const tz = (tzOffset || '+00:00').trim() || '+00:00';
  const sign = tz.startsWith('-') ? -1 : 1;
  const [hh, mm] = tz.replace(/^[+-]/, '').split(':').map(Number);
  const offsetMinutes = sign * (hh * 60 + (mm || 0));

  // 3. Ajustar el timestamp UTC con el offset para obtener la hora local
  const localTs = ts + offsetMinutes * 60 * 1000;

  // 4. Formatear usando Date en UTC (así evitamos interferencia del timezone del proceso Node)
  const d = new Date(localTs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function mapRow(row, extractChannelFn, lostDests = [], tzOffset = '+00:00') {
  const disp = lostDests.length > 0
    ? resolveDispositionLocal(row.disposition, row.dst, row.dstchannel || '', lostDests)
    : row.disposition;
  return {
    calldate:    formatCalldateLocal(row.calldate, tzOffset),
    src:         row.src,
    dst:         row.dst,
    channel:     extractChannelFn(row.channel),
    dstchannel:  row.dstchannel || '',
    duration:    Number(row.duration),
    billsec:     Number(row.billsec),
    disposition: disp || row.disposition,
  };
}

async function queryInbound(pool, filters, pagination, extractChannelFn, lostDests = [], tzOffset = '+00:00') {
  const page  = Number(pagination.page)  || 1;
  const limit = Number(pagination.limit) || 100;
  const offset = (page - 1) * limit;

  const { conditions, params } = buildWhereClause(filters, lostDests);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*) AS total FROM cdr ${where}`;
  const dataSql  = `SELECT calldate, src, dst, dstchannel, channel, duration, billsec, disposition
                    FROM cdr
                    ${where}
                    ORDER BY calldate DESC
                    LIMIT ? OFFSET ?`;

  const [[countRow]] = await pool.query(countSql, params);
  const total = Number(countRow.total);

  const dataParams = [...params, limit, offset];
  const [dataRows] = await pool.query(dataSql, dataParams);

  const rows = dataRows.map(r => mapRow(r, extractChannelFn, lostDests, tzOffset));
  const totalPages = Math.ceil(total / limit);

  return {
    rows,
    meta: { total, page, limit, totalPages },
  };
}

async function queryInboundExport(pool, filters, extractChannelFn, lostDests = [], tzOffset = '+00:00') {
  const { conditions, params } = buildWhereClause(filters, lostDests);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `SELECT calldate, src, dst, dstchannel, channel, duration, billsec, disposition
               FROM cdr
               ${where}
               ORDER BY calldate DESC
               LIMIT ${MAX_EXPORT_ROWS}`;

  const [rows] = await pool.query(sql, params);
  return rows.map(r => mapRow(r, extractChannelFn, lostDests, tzOffset));
}

function buildOutboundWhereClause(filters, outboundChannels, lostDests = []) {
  const conditions = [];
  const params = [];

  conditions.push('calldate >= ?');
  params.push(filters.from + ' 00:00:00');
  conditions.push('calldate <= ?');
  params.push(filters.to + ' 23:59:59');

  conditions.push("channel NOT LIKE 'Local/%'");

  if (!outboundChannels || outboundChannels.length === 0) {
    conditions.push('1 = 0');
  } else {
    const orParts = outboundChannels.map(() => "channel LIKE CONCAT(?, '%')");
    conditions.push(`(${orParts.join(' OR ')})`);
    for (const ch of outboundChannels) params.push(ch);
  }

  if (filters.trunk) {
    conditions.push("dstchannel LIKE CONCAT(?, '%')");
    params.push(filters.trunk);
  }
  if (filters.extension) {
    conditions.push("src LIKE CONCAT('%', ?, '%')");
    params.push(filters.extension);
  }
  if (filters.dest) {
    conditions.push("dst LIKE CONCAT('%', ?, '%')");
    params.push(filters.dest);
  }

  if (filters.disposition) {
    // #37: filtrar por BUSY equivale a filtrar por NO ANSWER (disposición efectiva)
    const d = filters.disposition.toUpperCase() === 'BUSY' ? 'NO ANSWER' : filters.disposition.toUpperCase();
    // #56: en salientes la regla #21 "ANSWERED sin agente" NO aplica (el dstchannel
    // es la troncal, no un agente). La reclasificación por lostDestinations sí se
    // mantiene, pero sin exigir dstchannel de agente.
    if (lostDests.length > 0 && d === 'NO ANSWER') {
      const lp = lostDests.map(() => '?').join(',');
      conditions.push(
        `(UPPER(disposition) = 'NO ANSWER' OR UPPER(disposition) = 'BUSY' OR dst IN (${lp}))`
      );
      params.push(...lostDests);
    } else if (lostDests.length > 0 && d === 'ANSWERED') {
      const lp = lostDests.map(() => '?').join(',');
      conditions.push(
        `(UPPER(disposition) = 'ANSWERED' AND dst NOT IN (${lp}))`
      );
      params.push(...lostDests);
    } else if (d === 'NO ANSWER') {
      // Sin lostDests: incluir filas BUSY originales también
      conditions.push("(UPPER(disposition) = 'NO ANSWER' OR UPPER(disposition) = 'BUSY')");
    } else {
      conditions.push('UPPER(disposition) = UPPER(?)');
      params.push(d);
    }
  }

  return { conditions, params };
}

function mapOutboundRow(row, extractChannelFn, lostDests = [], tzOffset = '+00:00') {
  // #56: applyAgentRule=false — no reclasificar ANSWERED→NO ANSWER por dstchannel
  // en salientes (el dstchannel es la troncal de salida, no un agente).
  const disp = lostDests.length > 0
    ? resolveDispositionLocal(row.disposition, row.dst, row.dstchannel || '', lostDests, false)
    : row.disposition;
  return {
    calldate:    formatCalldateLocal(row.calldate, tzOffset),
    src:         row.src,
    dst:         row.dst,
    channel:     row.channel || '',
    dstchannel:  extractChannelFn ? extractChannelFn(row.dstchannel || '') : (row.dstchannel || ''),
    duration:    Number(row.duration),
    billsec:     Number(row.billsec),
    disposition: disp || row.disposition,
  };
}

async function queryOutbound(pool, filters, pagination, outboundChannels, extractChannelFn, lostDests = [], tzOffset = '+00:00') {
  const page   = Number(pagination.page)  || 1;
  const limit  = Number(pagination.limit) || 100;
  const offset = (page - 1) * limit;

  const { conditions, params } = buildOutboundWhereClause(filters, outboundChannels, lostDests);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*) AS total FROM cdr ${where}`;
  const dataSql  = `SELECT calldate, src, dst, channel, dstchannel, duration, billsec, disposition
                    FROM cdr
                    ${where}
                    ORDER BY calldate DESC
                    LIMIT ? OFFSET ?`;

  const [[countRow]] = await pool.query(countSql, params);
  const total = Number(countRow.total);

  const dataParams = [...params, limit, offset];
  const [dataRows] = await pool.query(dataSql, dataParams);

  const rows = dataRows.map(r => mapOutboundRow(r, extractChannelFn, lostDests, tzOffset));
  const totalPages = Math.ceil(total / limit);

  return {
    rows,
    meta: { total, page, limit, totalPages },
  };
}

async function queryOutboundExport(pool, filters, outboundChannels, extractChannelFn, lostDests = [], tzOffset = '+00:00') {
  const { conditions, params } = buildOutboundWhereClause(filters, outboundChannels, lostDests);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `SELECT calldate, src, dst, channel, dstchannel, duration, billsec, disposition
               FROM cdr
               ${where}
               ORDER BY calldate DESC
               LIMIT ${MAX_EXPORT_ROWS}`;

  const [rows] = await pool.query(sql, params);
  return rows.map(r => mapOutboundRow(r, extractChannelFn, lostDests, tzOffset));
}

module.exports = {
  queryInbound,
  queryInboundExport,
  queryOutbound,
  queryOutboundExport,
  MAX_EXPORT_ROWS,
  // Exported for testing
  formatCalldateLocal,
  mapRow,
  mapOutboundRow,
  buildOutboundWhereClause,
  resolveDispositionLocal,
};
