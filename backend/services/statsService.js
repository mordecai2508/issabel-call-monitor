'use strict';

// #56: incluye PJSIP/NNN- y Local/NNN@ (extensiones PJSIP y agentes vía cola).
// Debe coincidir con AGENT_DSTCHANNEL_RE de server.js y cdrService.js.
const AGENT_DSTCHANNEL_MYSQL = '^(Agent/[0-9]+|SIP/[0-9]+-|PJSIP/[0-9]+-|Local/[0-9]+@)';

function calcVariation(v1, v2) {
  if (v1 === 0) return null;
  return Math.round(((v2 - v1) / v1) * 100 * 10) / 10;
}

/**
 * Build CASE expressions that mirror resolveDisposition logic from server.js.
 * Returns { answeredExpr, noAnswerExpr, extraParams } for use in SQL queries.
 * When lostDests is empty, falls back to simple SUM(disposition = ...) for
 * backward compatibility.
 */
function reclassifyCaseExprs(lostDests) {
  if (!lostDests || lostDests.length === 0) {
    return {
      answeredExpr: "SUM(disposition = 'ANSWERED')",
      // #37: BUSY se acumula en no_answer
      noAnswerExpr: "SUM(disposition = 'NO ANSWER' OR UPPER(disposition) = 'BUSY')",
      extraParams:  [],
    };
  }
  const lp = lostDests.map(() => '?').join(',');
  const re = AGENT_DSTCHANNEL_MYSQL;
  const answeredExpr =
    `SUM(CASE WHEN dst IN (${lp}) THEN 0 ` +
    `WHEN UPPER(disposition) = 'ANSWERED' AND (dstchannel IS NULL OR dstchannel = '' OR dstchannel NOT REGEXP ?) THEN 0 ` +
    `WHEN UPPER(disposition) = 'ANSWERED' THEN 1 ELSE 0 END)`;
  // #37: BUSY se acumula en no_answer (antes de lostDests para no interferir con otras reglas)
  const noAnswerExpr =
    `SUM(CASE WHEN UPPER(disposition) = 'BUSY' THEN 1 ` +
    `WHEN dst IN (${lp}) THEN 1 ` +
    `WHEN UPPER(disposition) = 'ANSWERED' AND (dstchannel IS NULL OR dstchannel = '' OR dstchannel NOT REGEXP ?) THEN 1 ` +
    `WHEN UPPER(disposition) = 'NO ANSWER' THEN 1 ELSE 0 END)`;
  return {
    answeredExpr,
    noAnswerExpr,
    extraParams: [...lostDests, re, ...lostDests, re],
  };
}

/**
 * Build a WHERE fragment that restricts CDR rows to those where the agent
 * actually answered the call, mirroring the reclassification logic.
 * Returns { sql, params } to be appended to an existing WHERE clause.
 *
 * - lostDests empty  → AND disposition = 'ANSWERED'
 * - lostDests present → AND dst NOT IN (?,…) AND UPPER(disposition) = 'ANSWERED'
 */
function answeredRowFilter(lostDests) {
  if (!lostDests || lostDests.length === 0) {
    return { sql: " AND disposition = 'ANSWERED'", params: [] };
  }
  const placeholders = lostDests.map(() => '?').join(',');
  return {
    sql: ` AND dst NOT IN (${placeholders}) AND UPPER(disposition) = 'ANSWERED'`,
    params: [...lostDests],
  };
}

function buildChannelCondition(configuredChannels) {
  const base = "channel NOT LIKE 'Local/%'";
  if (!configuredChannels || configuredChannels.length === 0) {
    return { sql: ` AND ${base}`, params: [] };
  }
  const orParts = configuredChannels.map(() => "channel LIKE CONCAT(?, '%')");
  return {
    sql: ` AND ${base} AND (${orParts.join(' OR ')})`,
    params: [...configuredChannels],
  };
}

const PERIOD_GROUPINGS = {
  day:   { label: "DATE_FORMAT(calldate, '%Y-%m-%d')", groupBy: "DATE_FORMAT(calldate, '%Y-%m-%d')", orderBy: "period_label" },
  week:  { label: "DATE_FORMAT(calldate, '%x-W%v')",  groupBy: "DATE_FORMAT(calldate, '%x-%v')",   orderBy: "DATE_FORMAT(calldate, '%x-%v')" },
  month: { label: "DATE_FORMAT(calldate, '%Y-%m')",   groupBy: "DATE_FORMAT(calldate, '%Y-%m')",   orderBy: "period_label" },
  year:  { label: "DATE_FORMAT(calldate, '%Y')",      groupBy: "DATE_FORMAT(calldate, '%Y')",      orderBy: "period_label" },
};

async function queryHistorical(pool, period, from, to, opts = {}) {
  const { lostDests = [], configuredChannels = [] } = opts;
  const fromTs = from + ' 00:00:00';
  const toTs   = to   + ' 23:59:59';
  const { answeredExpr, noAnswerExpr, extraParams } = reclassifyCaseExprs(lostDests);
  const chFilter = buildChannelCondition(configuredChannels);

  let rows;

  if (period === 'custom') {
    [rows] = await pool.query(
      `SELECT SUM(CASE WHEN UPPER(disposition) != 'FAILED' THEN 1 ELSE 0 END) AS total,
              ${answeredExpr} AS answered,
              ${noAnswerExpr} AS no_answer,
              ROUND(AVG(billsec) / 60, 1) AS avg_duration
       FROM cdr WHERE calldate >= ? AND calldate <= ?${chFilter.sql}`,
      [...extraParams, fromTs, toTs, ...chFilter.params]
    );
  } else {
    const g = PERIOD_GROUPINGS[period];
    [rows] = await pool.query(
      `SELECT ${g.label} AS period_label,
              SUM(CASE WHEN UPPER(disposition) != 'FAILED' THEN 1 ELSE 0 END) AS total,
              ${answeredExpr}             AS answered,
              ${noAnswerExpr}             AS no_answer,
              ROUND(AVG(billsec) / 60, 1) AS avg_duration
       FROM cdr WHERE calldate >= ? AND calldate <= ?${chFilter.sql}
       GROUP BY ${g.groupBy}
       ORDER BY ${g.orderBy} ASC`,
      [...extraParams, fromTs, toTs, ...chFilter.params]
    );
  }

  let points;
  if (period === 'custom') {
    const r = rows[0];
    if (Number(r.total) === 0) {
      points = [];
    } else {
      points = [{
        period_label: `${from} / ${to}`,
        total:        Number(r.total),
        answered:     Number(r.answered),
        no_answer:    Number(r.no_answer),
        avg_duration: Number(Number(r.avg_duration).toFixed(1)),
      }];
    }
  } else {
    points = rows.map(r => ({
      period_label: r.period_label,
      total:        Number(r.total),
      answered:     Number(r.answered),
      no_answer:    Number(r.no_answer),
      avg_duration: Number(Number(r.avg_duration).toFixed(1)),
    }));
  }

  return { period, from, to, points };
}

async function queryCompare(pool, p1from, p1to, p2from, p2to, opts = {}) {
  const { lostDests = [], configuredChannels = [] } = opts;
  const { answeredExpr, noAnswerExpr, extraParams } = reclassifyCaseExprs(lostDests);
  const chFilter = buildChannelCondition(configuredChannels);

  const totalQuery =
    `SELECT COUNT(*) AS total,
            ${answeredExpr}             AS answered,
            ${noAnswerExpr}             AS no_answer,
            SUM(disposition = 'BUSY')   AS busy,
            SUM(disposition = 'FAILED') AS failed,
            ROUND(AVG(billsec) / 60, 1) AS avg_duration
     FROM cdr WHERE calldate >= ? AND calldate <= ?${chFilter.sql}`;

  const [[rows1], [rows2]] = await Promise.all([
    pool.query(totalQuery, [...extraParams, p1from + ' 00:00:00', p1to + ' 23:59:59', ...chFilter.params]),
    pool.query(totalQuery, [...extraParams, p2from + ' 00:00:00', p2to + ' 23:59:59', ...chFilter.params]),
  ]);

  const r1 = rows1[0];
  const r2 = rows2[0];

  const kpis1 = {
    total:        Number(r1.total),
    answered:     Number(r1.answered),
    no_answer:    Number(r1.no_answer),
    busy:         Number(r1.busy),
    failed:       Number(r1.failed),
    avg_duration: Number(Number(r1.avg_duration).toFixed(1)),
  };

  const kpis2 = {
    total:        Number(r2.total),
    answered:     Number(r2.answered),
    no_answer:    Number(r2.no_answer),
    busy:         Number(r2.busy),
    failed:       Number(r2.failed),
    avg_duration: Number(Number(r2.avg_duration).toFixed(1)),
  };

  const variation = {
    total:        calcVariation(kpis1.total,        kpis2.total),
    answered:     calcVariation(kpis1.answered,     kpis2.answered),
    no_answer:    calcVariation(kpis1.no_answer,    kpis2.no_answer),
    busy:         calcVariation(kpis1.busy,         kpis2.busy),
    failed:       calcVariation(kpis1.failed,       kpis2.failed),
    avg_duration: calcVariation(kpis1.avg_duration, kpis2.avg_duration),
  };

  return {
    period1: { from: p1from, to: p1to, ...kpis1 },
    period2: { from: p2from, to: p2to, ...kpis2 },
    variation,
  };
}

async function queryRankings(pool, from, to, type, limit, opts = {}) {
  const { lostDests = [], configuredTrunks = [] } = opts;
  const safeLimit = Math.min(Number(limit) || 10, 50);
  const fromTs = from + ' 00:00:00';
  const toTs   = to   + ' 23:59:59';
  const { answeredExpr, noAnswerExpr, extraParams } = reclassifyCaseExprs(lostDests);

  let rows;

  if (type === 'extension') {
    // Agents are identified by dstchannel: SIP/<ext>-<hex> or Agent/<ext>.
    // We extract the numeric extension and group by it to get per-agent stats.
    // Only rows where the agent actually answered are included (answeredRowFilter).
    const ansFilter = answeredRowFilter(lostDests);
    [rows] = await pool.query(
      `SELECT CASE
                WHEN dstchannel LIKE 'Agent/%' THEN SUBSTRING(dstchannel, 7)
                WHEN dstchannel LIKE 'SIP/%'   THEN SUBSTRING_INDEX(SUBSTRING(dstchannel, 5), '-', 1)
                WHEN dstchannel LIKE 'PJSIP/%' THEN SUBSTRING_INDEX(SUBSTRING(dstchannel, 7), '-', 1)
                WHEN dstchannel LIKE 'Local/%' THEN SUBSTRING_INDEX(SUBSTRING(dstchannel, 7), '@', 1)
              END AS name,
              COUNT(*)                        AS total,
              ${answeredExpr}                 AS answered,
              ${noAnswerExpr}                 AS no_answer,
              SUM(disposition = 'BUSY')       AS busy,
              SUM(disposition = 'FAILED')     AS failed,
              ROUND(AVG(billsec) / 60, 1)     AS avg_duration
       FROM cdr
       WHERE calldate >= ? AND calldate <= ?
         AND dstchannel REGEXP ?${ansFilter.sql}
       GROUP BY name
       ORDER BY total DESC
       LIMIT ?`,
      [...extraParams, fromTs, toTs, AGENT_DSTCHANNEL_MYSQL, ...ansFilter.params, safeLimit]
    );
  } else {
    // trunk — filter to configured channels when provided
    const trunkConditions = ['calldate >= ?', 'calldate <= ?',
      'channel IS NOT NULL', "channel != ''", "channel NOT LIKE 'Local/%'"];
    const trunkParams = [...extraParams, fromTs, toTs];

    if (configuredTrunks.length > 0) {
      const orParts = configuredTrunks.map(() => "channel LIKE CONCAT(?, '%')");
      trunkConditions.push(`(${orParts.join(' OR ')})`);
      trunkParams.push(...configuredTrunks);
    }

    [rows] = await pool.query(
      `SELECT LEFT(channel,
                CHAR_LENGTH(channel)
                - CHAR_LENGTH(SUBSTRING_INDEX(channel, '-', -1))
                - 1
              ) AS name,
              COUNT(*)                    AS total,
              ${answeredExpr}             AS answered,
              ${noAnswerExpr}             AS no_answer,
              SUM(disposition = 'BUSY')   AS busy,
              SUM(disposition = 'FAILED') AS failed,
              ROUND(AVG(billsec) / 60, 1) AS avg_duration
       FROM cdr
       WHERE ${trunkConditions.join(' AND ')}
       GROUP BY name
       ORDER BY total DESC
       LIMIT ?`,
      [...trunkParams, safeLimit]
    );
  }

  const rankings = rows.map(r => ({
    name:         r.name,
    total:        Number(r.total),
    answered:     Number(r.answered),
    no_answer:    Number(r.no_answer),
    busy:         Number(r.busy),
    failed:       Number(r.failed),
    avg_duration: Number(Number(r.avg_duration).toFixed(1)),
  }));

  return { type, from, to, limit: safeLimit, rankings };
}

module.exports = { queryHistorical, queryCompare, queryRankings };
