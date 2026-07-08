'use strict';

const fs = require('fs');

const statsService = require('./statsService');
const cdrService   = require('./cdrService');

const REPORT_TYPES = ['executive', 'inbound', 'outbound', 'extensions', 'trunks'];

/**
 * Aggregate a list of CDR rows by `disposition`.
 *
 * @param {object[]} rows - rows mapped by cdrService (each has a `disposition` field)
 * @returns {{ total: number, ANSWERED: number, 'NO ANSWER': number }}
 */
function summarizeByDisposition(rows) {
  const summary = { total: 0, ANSWERED: 0, 'NO ANSWER': 0 };
  for (const row of rows) {
    const d = (row.disposition || '').toUpperCase();
    if (d === 'FAILED') continue;
    summary.total += 1;
    const effectiveD = d === 'BUSY' ? 'NO ANSWER' : d;
    if (effectiveD === 'ANSWERED' || effectiveD === 'NO ANSWER') summary[effectiveD] += 1;
  }
  return summary;
}

/**
 * Collect all the raw data needed to build a report of the given type.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} type - one of REPORT_TYPES
 * @param {string} from - YYYY-MM-DD
 * @param {string} to   - YYYY-MM-DD
 * @param {{ allowedChannels: string[]|null, extractChannel: Function }} helpers
 * @returns {Promise<object>}
 */
async function collectReportData(pool, type, from, to, { inboundChannels = [], outboundChannels = [], extractChannel, lostDests = [] }) {
  const configuredTrunks = [...inboundChannels, ...outboundChannels];

  if (type === 'executive') {
    const opts = { lostDests, configuredTrunks, configuredChannels: configuredTrunks };
    const [overall, trend, inboundRows, outboundRows, topExtensions, topTrunks] = await Promise.all([
      statsService.queryHistorical(pool, 'custom', from, to, opts),
      statsService.queryHistorical(pool, 'day', from, to, opts),
      cdrService.queryInboundExport(pool, { from, to, channels: inboundChannels }, extractChannel, lostDests),
      cdrService.queryOutboundExport(pool, { from, to }, outboundChannels, extractChannel, lostDests),
      statsService.queryRankings(pool, from, to, 'extension', 5, opts),
      statsService.queryRankings(pool, from, to, 'trunk', 5, opts),
    ]);

    const overallTotals = overall.points.length > 0
      ? overall.points[0]
      : { total: 0, answered: 0, no_answer: 0, avg_duration: 0 };

    return {
      type,
      from,
      to,
      overallTotals,
      trend: trend.points,
      inboundTotals:  summarizeByDisposition(inboundRows),
      outboundTotals: summarizeByDisposition(outboundRows),
      topExtensions: topExtensions.rankings,
      topTrunks:     topTrunks.rankings,
    };
  }

  if (type === 'inbound') {
    const rows = await cdrService.queryInboundExport(pool, { from, to, channels: inboundChannels }, extractChannel, lostDests);
    return {
      type,
      from,
      to,
      rows,
      summary:   summarizeByDisposition(rows),
      truncated: rows.length >= cdrService.MAX_EXPORT_ROWS,
    };
  }

  if (type === 'outbound') {
    const rows = await cdrService.queryOutboundExport(pool, { from, to }, outboundChannels, extractChannel, lostDests);
    return {
      type,
      from,
      to,
      rows,
      summary:   summarizeByDisposition(rows),
      truncated: rows.length >= cdrService.MAX_EXPORT_ROWS,
    };
  }

  if (type === 'extensions') {
    const rankings = await statsService.queryRankings(pool, from, to, 'extension', 10, { lostDests });
    return { type, from, to, rankings: rankings.rankings };
  }

  // trunks
  const rankings = await statsService.queryRankings(pool, from, to, 'trunk', 10, { lostDests, configuredTrunks });
  return { type, from, to, rankings: rankings.rankings };
}

/**
 * Read optional branding (company name + logo path) from the local SQLite DB.
 *
 * Defensive: checks whether the `system_config` table exists (feature #13,
 * may not be implemented yet) before querying it. Falls back gracefully to
 * `{ companyName: fallbackAppName, logoPath: null }` if the table doesn't
 * exist, has no rows, or `logoPath` points to a non-existent file.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} fallbackAppName
 * @returns {{ companyName: string, subcompanyName: string, logoPath: string|null }}
 */
function getBranding(db, fallbackAppName) {
  let companyName = null;
  let subcompanyName = '';
  let logoPath = null;

  try {
    const tableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_config'`
    ).get();

    if (tableExists) {
      const rows = db.prepare(
        `SELECT key, value FROM system_config WHERE key IN ('companyName', 'logoPath', 'subcompanyName')`
      ).all();

      for (const row of rows) {
        if (row.key === 'companyName' && row.value) companyName = row.value;
        if (row.key === 'logoPath' && row.value) logoPath = row.value;
        if (row.key === 'subcompanyName') subcompanyName = row.value || '';
      }
    }
  } catch (err) {
    console.error('[reportService] getBranding:', err.message);
  }

  if (logoPath && !fs.existsSync(logoPath)) {
    logoPath = null;
  }

  return {
    companyName: companyName || fallbackAppName,
    subcompanyName,
    logoPath,
  };
}

module.exports = {
  REPORT_TYPES,
  collectReportData,
  getBranding,
};
