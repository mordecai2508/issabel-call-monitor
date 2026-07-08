'use strict';
const express       = require('express');
const statsService  = require('../services/statsService');
const configService = require('../services/configService');

const VALID_PERIODS  = ['day', 'week', 'month', 'year', 'custom'];
const DATE_RE        = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(str) {
  if (!str || !DATE_RE.test(str)) return false;
  const d = new Date(str + 'T00:00:00');
  return !isNaN(d.getTime());
}

module.exports = function statsRouter(pool, config, requireAuth, db) {
  const router             = express.Router();
  const lostDests          = config.lostDestinations || [];
  const configuredChannels = [
    ...(config.channels?.inbound  || []),
    ...(config.channels?.outbound || []),
  ];
  const configuredTrunks = configuredChannels;

  // GET /api/stats/historical
  router.get('/stats/historical', requireAuth, async (req, res) => {
    const { period, from, to } = req.query;

    if (!period || !VALID_PERIODS.includes(period)) {
      return res.status(400).json({
        ok: false,
        error: 'El parámetro period debe ser day, week, month, year o custom',
      });
    }
    if (!isValidDate(from) || !isValidDate(to)) {
      return res.status(400).json({
        ok: false,
        error: 'Los parámetros from y to son requeridos y deben ser fechas válidas (YYYY-MM-DD)',
      });
    }
    if (from > to) {
      return res.status(400).json({
        ok: false,
        error: 'La fecha from no puede ser posterior a to',
      });
    }

    try {
      const result = await statsService.queryHistorical(pool, period, from, to, { lostDests, configuredChannels });
      return res.json({ ok: true, data: result });
    } catch (err) {
      console.error('[stats] GET /stats/historical:', err.message);
      if (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ER_ACCESS_DENIED_ERROR') {
        return res.status(503).json({ ok: false, error: 'Base de datos no disponible' });
      }
      return res.status(500).json({ ok: false, error: 'Error interno' });
    }
  });

  // GET /api/stats/compare
  router.get('/stats/compare', requireAuth, async (req, res) => {
    const { period1_from, period1_to, period2_from, period2_to } = req.query;

    if (!isValidDate(period1_from) || !isValidDate(period1_to) ||
        !isValidDate(period2_from) || !isValidDate(period2_to)) {
      return res.status(400).json({
        ok: false,
        error: 'Los parámetros period1_from, period1_to, period2_from y period2_to son requeridos y deben ser fechas válidas (YYYY-MM-DD)',
      });
    }
    if (period1_from > period1_to || period2_from > period2_to) {
      return res.status(400).json({
        ok: false,
        error: 'Las fechas de inicio no pueden ser posteriores a las fechas de fin',
      });
    }

    try {
      const result = await statsService.queryCompare(pool, period1_from, period1_to, period2_from, period2_to, { lostDests, configuredChannels });
      return res.json({ ok: true, data: result });
    } catch (err) {
      console.error('[stats] GET /stats/compare:', err.message);
      if (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ER_ACCESS_DENIED_ERROR') {
        return res.status(503).json({ ok: false, error: 'Base de datos no disponible' });
      }
      return res.status(500).json({ ok: false, error: 'Error interno' });
    }
  });

  // GET /api/stats/rankings
  router.get('/stats/rankings', requireAuth, async (req, res) => {
    const { from, to, type, limit } = req.query;

    if (!isValidDate(from) || !isValidDate(to)) {
      return res.status(400).json({
        ok: false,
        error: 'Los parámetros from y to son requeridos y deben ser fechas válidas (YYYY-MM-DD)',
      });
    }
    if (!type || !['extension', 'trunk'].includes(type)) {
      return res.status(400).json({
        ok: false,
        error: 'El parámetro type debe ser extension o trunk',
      });
    }
    if (limit !== undefined) {
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        return res.status(400).json({
          ok: false,
          error: 'El parámetro limit debe ser un entero entre 1 y 50',
        });
      }
    }

    try {
      const result = await statsService.queryRankings(pool, from, to, type, limit || 10, { lostDests, configuredTrunks });

      if (type === 'trunk') {
        // Read channel aliases from SQLite at request time (not snapshot at startup).
        const channelAliases = db ? configService.getChannelAliases(db) : {};
        result.rankings = result.rankings.map(r => ({ ...r, name: channelAliases[r.name] || r.name }));
      }

      if (type === 'extension' && db) {
        const extNames  = result.rankings.map(r => r.name);
        const overrides = configService.getExtensionOverrides(db, extNames);
        result.rankings = result.rankings
          .filter(r => {
            const ov = overrides.get(r.name);
            return !ov || !ov.hidden;
          })
          .map(r => {
            const ov = overrides.get(r.name);
            return { ...r, name: (ov && ov.displayName) || r.name };
          });
      }

      return res.json({ ok: true, data: result });
    } catch (err) {
      console.error('[stats] GET /stats/rankings:', err.message);
      if (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ER_ACCESS_DENIED_ERROR') {
        return res.status(503).json({ ok: false, error: 'Base de datos no disponible' });
      }
      return res.status(500).json({ ok: false, error: 'Error interno' });
    }
  });

  return router;
};
