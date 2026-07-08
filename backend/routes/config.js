'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const configService = require('../services/configService');
const statsService = require('../services/statsService');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const MAX_LOGO_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_LOGO_MIMETYPES = ['image/png', 'image/jpeg'];
const RANKINGS_DAYS = 30;
const RANKINGS_LIMIT = 50;

/**
 * Format a Date as YYYY-MM-DD (local time), matching the convention used
 * by `statsService.queryRankings` / `routes/stats.js`.
 *
 * @param {Date} d
 * @returns {string}
 */
function toDateOnly(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Compute the { from, to } range covering the last N days (including today),
 * formatted as YYYY-MM-DD.
 *
 * @param {number} days
 * @returns {{ from: string, to: string }}
 */
function lastNDaysRange(days) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86400_000);
  return { from: toDateOnly(from), to: toDateOnly(to) };
}

/**
 * Determine the Content-Type for a logo file based on its extension.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function contentTypeForLogo(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return null;
}

/**
 * Factory for the system_config router (feature #13).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} config
 * @param {import('better-sqlite3').Database} db
 * @param {Function} requireAuth
 * @param {Function} requireAdmin
 * @param {Function} getAppName
 * @returns {import('express').Router}
 */
module.exports = function configRouter(pool, config, db, requireAuth, requireAdmin, getAppName, broadcast) {
  const router = express.Router();

  // Defensive: ensure the uploads directory exists on disk (T6).
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOADS_DIR),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() ||
          (file.mimetype === 'image/png' ? '.png' : '.jpg');
        cb(null, `logo-${Date.now()}${ext}`);
      },
    }),
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_LOGO_MIMETYPES.includes(file.mimetype)) {
        return cb(new Error('El logo debe ser una imagen PNG o JPEG'));
      }
      cb(null, true);
    },
    limits: { fileSize: MAX_LOGO_SIZE },
  });

  function buildConfigResponse() {
    const general = configService.getGeneralConfig(db, {
      fallbackAppName: getAppName(),
      fallbackTimezone: config.db?.timezone,
    });

    const logoUrl = (general.logoPath && fs.existsSync(general.logoPath))
      ? '/api/admin/config/logo'
      : null;

    return {
      companyName: general.companyName,
      timezone: general.timezone,
      language: general.language,
      themeColors: general.themeColors,
      logoUrl,
      businessHours: configService.getBusinessHours(db),
      subcompanyName: general.subcompanyName,
    };
  }

  // ── GET /admin/config ────────────────────────────────────────────
  router.get('/admin/config', requireAdmin, (req, res) => {
    try {
      res.json({ ok: true, data: buildConfigResponse() });
    } catch (err) {
      console.error('[config] GET /admin/config:', err.message);
      res.status(500).json({ ok: false, error: 'Error al obtener la configuración' });
    }
  });

  // ── PATCH /admin/config ──────────────────────────────────────────
  router.patch('/admin/config', requireAdmin, (req, res) => {
    const { companyName, timezone, language, themeColors, businessHours, subcompanyName } = req.body || {};

    if (companyName === undefined && timezone === undefined && language === undefined && themeColors === undefined && businessHours === undefined && subcompanyName === undefined) {
      return res.status(400).json({ ok: false, error: 'Debe proporcionar al menos un campo a actualizar' });
    }

    // Validate businessHours when provided (null clears it)
    if (businessHours !== undefined && businessHours !== null) {
      if (typeof businessHours !== 'object' || Array.isArray(businessHours)) {
        return res.status(400).json({ ok: false, error: 'El campo businessHours debe ser un objeto o null' });
      }
      if (!Array.isArray(businessHours.days)) {
        return res.status(400).json({ ok: false, error: 'businessHours.days debe ser un arreglo' });
      }
      if (businessHours.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
        return res.status(400).json({ ok: false, error: 'businessHours.days debe contener enteros entre 0 (domingo) y 6 (sábado)' });
      }
      if (typeof businessHours.start !== 'string' || !/^\d{2}:\d{2}$/.test(businessHours.start)) {
        return res.status(400).json({ ok: false, error: 'businessHours.start debe tener el formato HH:MM' });
      }
      if (typeof businessHours.end !== 'string' || !/^\d{2}:\d{2}$/.test(businessHours.end)) {
        return res.status(400).json({ ok: false, error: 'businessHours.end debe tener el formato HH:MM' });
      }
    }

    try {
      if (companyName !== undefined || timezone !== undefined || language !== undefined || themeColors !== undefined || subcompanyName !== undefined) {
        configService.updateGeneralConfig(db, { companyName, timezone, language, themeColors, subcompanyName });
      }
      if (businessHours !== undefined) {
        configService.setBusinessHours(db, businessHours);
      }
      const responseData = buildConfigResponse();
      res.json({ ok: true, data: responseData });
      if (typeof broadcast === 'function') {
        broadcast('config_updated', {
          appName: responseData.companyName,
          subcompanyName: responseData.subcompanyName,
        });
      }
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      console.error('[config] PATCH /admin/config:', err.message);
      res.status(500).json({ ok: false, error: 'Error al actualizar la configuración' });
    }
  });

  // ── POST /admin/config/logo ──────────────────────────────────────
  router.post('/admin/config/logo', requireAdmin, (req, res) => {
    upload.single('logo')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ ok: false, error: 'El archivo no debe superar los 2 MB' });
        }
        return res.status(400).json({ ok: false, error: err.message });
      }
      if (err) {
        return res.status(400).json({ ok: false, error: err.message || 'Error al subir el logo' });
      }

      if (!req.file) {
        return res.status(400).json({ ok: false, error: 'Debe incluir un archivo de imagen (campo "logo")' });
      }

      try {
        const previousLogoPath = configService.getLogoPath(db);
        const newLogoPath = req.file.path;

        configService.setLogoPath(db, newLogoPath);

        if (previousLogoPath && previousLogoPath !== newLogoPath) {
          try {
            fs.unlinkSync(previousLogoPath);
          } catch (unlinkErr) {
            console.error('[config] No se pudo eliminar el logo anterior:', unlinkErr.message);
          }
        }

        res.json({ ok: true, data: { logoUrl: '/api/admin/config/logo' } });
      } catch (innerErr) {
        console.error('[config] POST /admin/config/logo:', innerErr.message);
        res.status(500).json({ ok: false, error: 'Error al guardar el logo' });
      }
    });
  });

  // ── GET /admin/config/logo ────────────────────────────────────────
  router.get('/admin/config/logo', requireAuth, (req, res) => {
    try {
      const logoPath = configService.getLogoPath(db);
      if (!logoPath || !fs.existsSync(logoPath)) {
        return res.status(404).json({ ok: false, error: 'No hay logo configurado' });
      }

      const contentType = contentTypeForLogo(logoPath);
      if (!contentType) {
        return res.status(404).json({ ok: false, error: 'No hay logo configurado' });
      }

      res.setHeader('Content-Type', contentType);
      fs.createReadStream(logoPath).pipe(res);
    } catch (err) {
      console.error('[config] GET /admin/config/logo:', err.message);
      res.status(500).json({ ok: false, error: 'Error al obtener el logo' });
    }
  });

  // ── PATCH /admin/extensions/:ext ──────────────────────────────────
  router.patch('/admin/extensions/:ext', requireAdmin, (req, res) => {
    const ext = decodeURIComponent(req.params.ext);
    if (!ext.trim()) {
      return res.status(400).json({ ok: false, error: 'La extensión no puede estar vacía' });
    }

    const { displayName, hidden } = req.body || {};

    if (displayName === undefined && hidden === undefined) {
      return res.status(400).json({ ok: false, error: 'Debe proporcionar displayName y/o hidden' });
    }
    if (displayName !== undefined && typeof displayName !== 'string') {
      return res.status(400).json({ ok: false, error: 'El campo displayName debe ser una cadena de texto' });
    }
    if (hidden !== undefined && typeof hidden !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'El campo hidden debe ser un valor booleano' });
    }

    try {
      const result = configService.upsertExtensionOverride(db, ext, { displayName, hidden });
      res.json({ ok: true, data: result });
    } catch (err) {
      console.error('[config] PATCH /admin/extensions/:ext:', err.message);
      res.status(500).json({ ok: false, error: 'Error al actualizar la extensión' });
    }
  });

  // ── GET /admin/extensions ──────────────────────────────────────────
  router.get('/admin/extensions', requireAdmin, async (req, res) => {
    try {
      const { from, to } = lastNDaysRange(RANKINGS_DAYS);
      const result = await statsService.queryRankings(pool, from, to, 'extension', RANKINGS_LIMIT);
      const rankings = result.rankings || [];

      const overrides = configService.getExtensionOverrides(db, rankings.map(r => r.name));

      const data = rankings.map(r => {
        const override = overrides.get(r.name);
        return {
          extension: r.name,
          displayName: override?.displayName ?? null,
          hidden: override?.hidden ?? false,
          total: r.total,
        };
      });

      res.json({ ok: true, data });
    } catch (err) {
      console.error('[config] GET /admin/extensions:', err.message);
      res.json({ ok: true, data: [], dbUnavailable: true });
    }
  });

  // ── PATCH /admin/trunks ───────────────────────────────────────────
  router.patch('/admin/trunks', requireAdmin, (req, res) => {
    const { trunk, hidden } = req.body || {};
    if (typeof trunk !== 'string' || !trunk.trim()) {
      return res.status(400).json({ ok: false, error: 'El campo trunk es requerido' });
    }
    if (typeof hidden !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'El campo hidden es requerido y debe ser booleano' });
    }

    try {
      const result = configService.upsertTrunkOverride(db, trunk, hidden);
      res.json({ ok: true, data: result });
    } catch (err) {
      console.error('[config] PATCH /admin/trunks/:trunk:', err.message);
      res.status(500).json({ ok: false, error: 'Error al actualizar el troncal' });
    }
  });

  // ── GET /admin/trunks ────────────────────────────────────────────
  router.get('/admin/trunks', requireAdmin, async (req, res) => {
    try {
      const { from, to } = lastNDaysRange(RANKINGS_DAYS);
      const result = await statsService.queryRankings(pool, from, to, 'trunk', RANKINGS_LIMIT);
      const rankings = result.rankings || [];

      const overrides = configService.getTrunkOverrides(db, rankings.map(r => r.name));

      const data = rankings.map(r => ({
        trunk: r.name,
        hidden: overrides.get(r.name) ?? false,
        total: r.total,
      }));

      res.json({ ok: true, data });
    } catch (err) {
      console.error('[config] GET /admin/trunks:', err.message);
      res.json({ ok: true, data: [], dbUnavailable: true });
    }
  });

  return router;
};
