'use strict';

const express = require('express');

/**
 * Factory for the pbx_health router (feature #14).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} config
 * @param {import('better-sqlite3').Database} db
 * @param {(req, res, next) => void} requireAuth
 * @param {ReturnType<typeof import('../services/pbxHealthService')>} pbxHealthService
 * @param {ReturnType<typeof import('../services/amiExtensionsService')>} amiExtensionsService
 */
module.exports = function pbxRouter(pool, config, db, requireAuth, pbxHealthService, amiExtensionsService) {
  const router = express.Router();

  // GET /api/pbx/health
  router.get('/pbx/health', requireAuth, async (req, res) => {
    try {
      const status = await pbxHealthService.ensureChecked();
      res.json({ ok: true, data: status });
    } catch (err) {
      console.error('[pbx] GET /pbx/health:', err.message);
      res.status(500).json({ ok: false, error: 'Error al verificar el estado del PBX' });
    }
  });

  // POST /api/pbx/sync
  router.post('/pbx/sync', requireAuth, async (req, res) => {
    try {
      const status = await pbxHealthService.check();
      res.json({ ok: true, data: status });
    } catch (err) {
      console.error('[pbx] POST /pbx/sync:', err.message);
      res.status(500).json({ ok: false, error: 'Error al verificar el estado del PBX' });
    }
  });

  // GET /api/pbx/extensions
  router.get('/pbx/extensions', requireAuth, (req, res) => {
    try {
      const status = amiExtensionsService.getStatus();
      res.json({ ok: true, data: status });
    } catch (err) {
      console.error('[pbx] GET /pbx/extensions:', err.message);
      res.status(500).json({ ok: false, error: 'Error al obtener el estado de las extensiones' });
    }
  });

  return router;
};
