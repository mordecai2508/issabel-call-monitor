'use strict';

const express      = require('express');
const userService  = require('../services/userService');
const auditService = require('../services/auditService');

const VALID_ROLES = ['admin', 'operador'];

/**
 * Factory function that returns an Express router for user-management endpoints.
 *
 * @param {object}   pool         mysql2 pool (not used here, kept for interface consistency)
 * @param {object}   config       parsed config.json
 * @param {Database} db           better-sqlite3 instance
 * @param {Function} requireAuth  middleware: 401 if not authenticated
 * @param {Function} requireAdmin middleware: 403 if not admin
 * @returns {express.Router}
 */
module.exports = function usersRouter(pool, config, db, requireAuth, requireAdmin) {
  const router = express.Router();

  // GET /api/admin/users
  router.get('/admin/users', requireAdmin, async (req, res) => {
    try {
      const users = userService.listUsers(db);
      res.json({ ok: true, data: users, users });
    } catch (err) {
      console.error('[users] GET /admin/users:', err.message);
      res.status(500).json({ ok: false, error: 'Error al obtener usuarios' });
    }
  });

  // POST /api/admin/users
  router.post('/admin/users', requireAdmin, async (req, res) => {
    try {
      const { username, password, role } = req.body || {};

      if (!username || !String(username).trim()) {
        return res.status(400).json({ ok: false, error: 'El campo username es requerido' });
      }
      if (!password || !String(password).trim()) {
        return res.status(400).json({ ok: false, error: 'El campo password es requerido' });
      }
      if (!role || !String(role).trim()) {
        return res.status(400).json({ ok: false, error: 'El campo role es requerido' });
      }
      if (String(password).length < 8) {
        return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres' });
      }
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ ok: false, error: `El rol debe ser uno de: ${VALID_ROLES.join(', ')}` });
      }

      const user = await userService.createUser(db, {
        username: String(username).trim(),
        password: String(password),
        role:     String(role),
      });

      return res.status(201).json({ ok: true, data: user });
    } catch (err) {
      if (err.statusCode === 409) {
        return res.status(409).json({ ok: false, error: err.message });
      }
      console.error('[users] POST /admin/users:', err.message);
      return res.status(500).json({ ok: false, error: 'Error al crear usuario' });
    }
  });

  // PATCH /api/admin/users/:id
  router.patch('/admin/users/:id', requireAdmin, async (req, res) => {
    try {
      const id     = Number(req.params.id);
      const body   = req.body || {};
      const fields = {};

      if (body.username !== undefined) {
        if (!String(body.username).trim()) {
          return res.status(400).json({ ok: false, error: 'El campo username no puede estar vacío' });
        }
        fields.username = String(body.username).trim();
      }
      if (body.role !== undefined) {
        if (!VALID_ROLES.includes(body.role)) {
          return res.status(400).json({ ok: false, error: `El rol debe ser uno de: ${VALID_ROLES.join(', ')}` });
        }
        fields.role = body.role;
      }
      if (body.active !== undefined) {
        fields.active = body.active;
      }

      const updated = userService.updateUser(db, id, fields);
      return res.json({ ok: true, data: updated });
    } catch (err) {
      if (err.statusCode === 404) {
        return res.status(404).json({ ok: false, error: err.message });
      }
      if (err.statusCode === 409) {
        return res.status(409).json({ ok: false, error: err.message });
      }
      console.error('[users] PATCH /admin/users/:id:', err.message);
      return res.status(500).json({ ok: false, error: 'Error al actualizar usuario' });
    }
  });

  // POST /api/admin/users/:id/reset-password
  router.post('/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    try {
      const id     = Number(req.params.id);
      const result = await userService.resetPassword(db, id);
      return res.json({ ok: true, data: result });
    } catch (err) {
      if (err.statusCode === 404) {
        return res.status(404).json({ ok: false, error: err.message });
      }
      console.error('[users] POST /admin/users/:id/reset-password:', err.message);
      return res.status(500).json({ ok: false, error: 'Error al resetear contraseña' });
    }
  });

  // GET /api/admin/audit-log
  router.get('/admin/audit-log', requireAdmin, async (req, res) => {
    try {
      const log = auditService.getRecentLog(db);
      return res.json({ ok: true, data: log });
    } catch (err) {
      console.error('[users] GET /admin/audit-log:', err.message);
      return res.status(500).json({ ok: false, error: 'Error al obtener audit log' });
    }
  });

  return router;
};
