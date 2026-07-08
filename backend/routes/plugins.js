'use strict';

const express = require('express');

/**
 * Factory del router de gestión de plugins (feature #54 — plugin_system).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Function} requireAuth
 * @param {Function} requireAdmin
 * @param {object} pluginManager instancia de pluginManagerService
 * @param {Function} broadcast broadcast SSE core del servidor
 * @returns {import('express').Router}
 */
module.exports = function pluginsRouter(db, requireAuth, requireAdmin, pluginManager, broadcast) {
  const router = express.Router();

  // ── GET /api/plugins (R19, R20) ──────────────────────────────────
  router.get('/plugins', requireAuth, (req, res) => {
    try {
      res.json({ ok: true, data: pluginManager.list() });
    } catch (err) {
      console.error('[plugins] GET /plugins:', err.message);
      res.status(500).json({ ok: false, error: 'Error interno del servidor' });
    }
  });

  // ── PATCH /api/admin/plugins/:name (R21–R26) ─────────────────────
  router.patch('/admin/plugins/:name', requireAdmin, (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'El campo enabled es requerido y debe ser booleano' });
    }

    try {
      const result = pluginManager.setEnabled(req.params.name, enabled);
      res.json({ ok: true, data: result });
      if (typeof broadcast === 'function') {
        broadcast('plugins_changed', { name: result.name, enabled: result.enabled });
      }
    } catch (err) {
      if (err && (err.status === 404 || err.status === 409)) {
        return res.status(err.status).json({ ok: false, error: err.message });
      }
      console.error('[plugins] PATCH /admin/plugins/:name:', err.message);
      res.status(500).json({ ok: false, error: 'Error interno del servidor' });
    }
  });

  return router;
};
