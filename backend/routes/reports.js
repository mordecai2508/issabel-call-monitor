'use strict';

const express        = require('express');
const reportService  = require('../services/reportService');
const exportService  = require('../services/exportService');
const configService  = require('../services/configService');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_TIMEOUT_MS = 10000;

/**
 * Validate that a string is in YYYY-MM-DD format.
 * @param {string} s
 * @returns {boolean}
 */
function isValidDate(s) {
  if (!s || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !isNaN(d.getTime());
}

/**
 * Factory for the reports router.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {object}   config
 * @param {import('better-sqlite3').Database} db
 * @param {Function} requireAuth
 * @param {Function} extractChannel
 * @param {boolean}  dbOk
 * @returns {import('express').Router}
 */
module.exports = function reportsRouter(pool, config, db, requireAuth, extractChannel, dbOk) {
  const router           = express.Router();
  const inboundChannels  = (config.channels && config.channels.inbound)  || [];
  const outboundChannels = (config.channels && config.channels.outbound) || [];
  const lostDests        = config.lostDestinations || [];

  function applyAliasesToReportData(type, data) {
    const channelAliases = configService.getChannelAliases(db);

    function applyAlias(name) {
      return channelAliases[name] || name;
    }

    if (type === 'inbound' && data.rows) {
      return { ...data, rows: data.rows.map(r => ({ ...r, channel: applyAlias(r.channel) })) };
    }
    if (type === 'outbound' && data.rows) {
      return { ...data, rows: data.rows.map(r => ({ ...r, dstchannel: applyAlias(r.dstchannel) })) };
    }
    if (type === 'trunks' && data.rankings) {
      return { ...data, rankings: data.rankings.map(r => ({ ...r, name: applyAlias(r.name) })) };
    }
    if (type === 'extensions' && data.rankings) {
      const names = data.rankings.map(r => r.name);
      const extOverrides = configService.getExtensionOverrides(db, names);
      return {
        ...data,
        rankings: data.rankings.map(r => ({
          ...r,
          name: extOverrides.get(r.name)?.displayName || r.name,
        })),
      };
    }
    if (type === 'executive') {
      const extNames = (data.topExtensions || []).map(r => r.name);
      const extOverrides = configService.getExtensionOverrides(db, extNames);
      return {
        ...data,
        topTrunks:     (data.topTrunks     || []).map(r => ({ ...r, name: applyAlias(r.name) })),
        topExtensions: (data.topExtensions || []).map(r => ({
          ...r,
          name: extOverrides.get(r.name)?.displayName || r.name,
        })),
      };
    }
    return data;
  }

  function getAppName() {
    return config.app?.name || 'Call Monitor';
  }

  /**
   * Shared handler for /reports/:type/pdf and /reports/:type/xlsx.
   * @param {'pdf'|'xlsx'} format
   */
  function handler(format) {
    return async (req, res) => {
      const { type } = req.params;
      const { from, to } = req.query;

      // R3 — validate :type
      if (!reportService.REPORT_TYPES.includes(type)) {
        return res.status(400).json({
          ok: false,
          error: 'El tipo de reporte debe ser uno de: executive, inbound, outbound, extensions, trunks',
        });
      }

      // R4 — validate from/to format
      if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({
          ok: false,
          error: 'Los parámetros from y to son requeridos y deben ser fechas válidas (YYYY-MM-DD)',
        });
      }

      // R5 — from <= to
      if (from > to) {
        return res.status(400).json({ ok: false, error: 'La fecha from no puede ser posterior a to' });
      }

      // R8 — DB unavailable
      if (!dbOk) {
        return res.status(503).json({ ok: false, error: 'Base de datos no disponible' });
      }

      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        if (!res.headersSent) {
          res.status(504).json({ ok: false, error: 'La generación del reporte tardó demasiado' });
        }
      }, REPORT_TIMEOUT_MS);

      try {
        const rawData = await reportService.collectReportData(pool, type, from, to, { inboundChannels, outboundChannels, extractChannel, lostDests });
        const data = applyAliasesToReportData(type, rawData);

        clearTimeout(timeoutId);
        if (timedOut) return; // R9 — response already sent

        const branding = reportService.getBranding(db, getAppName());
        const filenameBase = `reporte_${type}_${from}_${to}`;

        if (format === 'pdf') {
          exportService.buildReportPdf(res, { type, from, to, branding, data, filenameBase });
        } else {
          await exportService.buildReportXlsx(res, { type, from, to, branding, data, filenameBase });
        }
      } catch (err) {
        clearTimeout(timeoutId);
        if (timedOut) return;

        console.error(`[reports] GET /reports/${type}/${format}:`, err.message);
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: 'Error al generar el reporte' });
        } else {
          res.end();
        }
      }
    };
  }

  router.get('/reports/:type/pdf',  requireAuth, handler('pdf'));
  router.get('/reports/:type/xlsx', requireAuth, handler('xlsx'));

  return router;
};
