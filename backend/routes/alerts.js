'use strict';

const express = require('express');

/**
 * Factory for the alerts_monitoring router (feature #15).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} config
 * @param {import('better-sqlite3').Database} db
 * @param {(req, res, next) => void} requireAuth
 * @param {(req, res, next) => void} requireAdmin
 * @param {ReturnType<typeof import('../services/alertService')>} alertService
 * @returns {import('express').Router}
 */
module.exports = function alertsRouter(pool, config, db, requireAuth, requireAdmin, alertService) {
  const router = express.Router();

  // ── Gestión de reglas (admin) ────────────────────────────────────

  // GET /admin/alerts/rules
  router.get('/admin/alerts/rules', requireAdmin, (req, res) => {
    try {
      res.json({ ok: true, data: alertService.listRules() });
    } catch (err) {
      console.error('[alerts] GET /admin/alerts/rules:', err.message);
      res.status(500).json({ ok: false, error: 'Error al obtener las reglas de alerta' });
    }
  });

  // POST /admin/alerts/rules
  router.post('/admin/alerts/rules', requireAdmin, (req, res) => {
    try {
      const rule = alertService.createRule(req.body || {});
      res.status(201).json({ ok: true, data: rule });
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      console.error('[alerts] POST /admin/alerts/rules:', err.message);
      res.status(500).json({ ok: false, error: 'Error al crear la regla de alerta' });
    }
  });

  // PATCH /admin/alerts/rules/:id
  router.patch('/admin/alerts/rules/:id', requireAdmin, (req, res) => {
    const { threshold, enabled, notify_email } = req.body || {};

    if (threshold === undefined && enabled === undefined && notify_email === undefined) {
      return res.status(400).json({ ok: false, error: 'Debe proporcionar al menos un campo a actualizar' });
    }

    try {
      const rule = alertService.updateRule(req.params.id, { threshold, enabled, notify_email });
      res.json({ ok: true, data: rule });
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      if (err.status === 404) {
        return res.status(404).json({ ok: false, error: err.message });
      }
      console.error('[alerts] PATCH /admin/alerts/rules/:id:', err.message);
      res.status(500).json({ ok: false, error: 'Error al actualizar la regla de alerta' });
    }
  });

  // DELETE /admin/alerts/rules/:id
  router.delete('/admin/alerts/rules/:id', requireAdmin, (req, res) => {
    try {
      const result = alertService.deleteRule(req.params.id);
      res.json({ ok: true, data: result });
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({ ok: false, error: err.message });
      }
      console.error('[alerts] DELETE /admin/alerts/rules/:id:', err.message);
      res.status(500).json({ ok: false, error: 'Error al eliminar la regla de alerta' });
    }
  });

  // ── Alertas activas (cualquier usuario autenticado) ──────────────

  // GET /alerts/active
  router.get('/alerts/active', requireAuth, (req, res) => {
    try {
      res.json({ ok: true, data: alertService.getActiveAlerts() });
    } catch (err) {
      console.error('[alerts] GET /alerts/active:', err.message);
      res.status(500).json({ ok: false, error: 'Error al obtener las alertas activas' });
    }
  });

  // PATCH /alerts/:id/resolve
  router.patch('/alerts/:id/resolve', requireAuth, (req, res) => {
    try {
      const alert = alertService.resolveAlert(req.params.id);
      res.json({ ok: true, data: alert });
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({ ok: false, error: err.message });
      }
      if (err.status === 409) {
        return res.status(409).json({ ok: false, error: err.message });
      }
      console.error('[alerts] PATCH /alerts/:id/resolve:', err.message);
      res.status(500).json({ ok: false, error: 'Error al resolver la alerta' });
    }
  });

  return router;
};
