'use strict';

const express = require('express');

const MIN_JOB_INTERVAL_MS = 60_000;
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Congela recursivamente un objeto (copia previa) para que los plugins
 * no puedan mutar la configuración del servidor (R7).
 *
 * @param {*} obj
 * @returns {*} el mismo objeto, congelado en profundidad
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return Object.freeze(obj);
}

/**
 * Valida el manifest de un plugin (R2, R3).
 *
 * @param {*} manifest
 * @param {string} entryName nombre declarado en la entrada del registro
 * @param {Map} registered plugins ya registrados (para detectar duplicados)
 * @returns {string|null} mensaje de error, o null si es válido
 */
function validateManifest(manifest, entryName, registered) {
  if (!manifest || typeof manifest !== 'object') {
    return 'manifest ausente o inválido';
  }
  if (typeof manifest.name !== 'string' || !NAME_RE.test(manifest.name)) {
    return `manifest.name inválido (debe cumplir ${NAME_RE})`;
  }
  if (manifest.name !== entryName) {
    return `manifest.name ("${manifest.name}") no coincide con la entrada del registro ("${entryName}")`;
  }
  if (registered.has(manifest.name)) {
    return `nombre duplicado ("${manifest.name}") con otro plugin ya registrado`;
  }
  if (typeof manifest.title !== 'string' || !manifest.title.trim()) {
    return 'manifest.title debe ser un string no vacío';
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    return 'manifest.version debe ser un string no vacío';
  }
  return null;
}

/**
 * Factory del gestor de plugins (feature #54 — plugin_system).
 *
 * Ciclo de vida: carga desde registro estático, validación de manifest,
 * estado persistido en SQLite (tabla `plugins`), init(ctx), jobs periódicos
 * y router HTTP con gate de habilitación por request.
 *
 * @param {Array<{ name: string, load: Function }>} registry
 * @param {object} deps
 * @param {import('mysql2/promise').Pool} deps.pool  pool MySQL COMPARTIDO (R16)
 * @param {import('better-sqlite3').Database} deps.db SQLite local
 * @param {object} deps.config config.json parseado
 * @param {Function} deps.broadcast broadcast SSE core del servidor
 */
function createPluginManagerService(registry, { pool, db, config, broadcast }) {
  // name -> { manifest, module, ctx, status: 'active'|'disabled'|'error', jobHandles: [] }
  const plugins = new Map();

  function makeCtx(name) {
    const frozenConfig = deepFreeze(JSON.parse(JSON.stringify(config || {})));
    return {
      pool,
      db,
      config: frozenConfig,
      broadcast: (event, data) => broadcast(`plugin:${name}:${event}`, data),
      logger: {
        info:  (...args) => console.log(`[plugin:${name}]`, ...args),
        warn:  (...args) => console.warn(`[plugin:${name}]`, ...args),
        error: (...args) => console.error(`[plugin:${name}]`, ...args),
      },
    };
  }

  // ── Estado persistido (R17, R18) ─────────────────────────────────
  function readEnabled(name) {
    const row = db.prepare('SELECT enabled FROM plugins WHERE name = ?').get(name);
    if (row === undefined) {
      db.prepare('INSERT INTO plugins (name, enabled) VALUES (?, 1)').run(name);
      return true;
    }
    return row.enabled === 1;
  }

  function writeEnabled(name, enabled) {
    db.prepare(`
      INSERT INTO plugins (name, enabled) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = datetime('now')
    `).run(name, enabled ? 1 : 0);
  }

  // ── Jobs (R11–R15) ───────────────────────────────────────────────
  function startJobs(p) {
    if (!Array.isArray(p.module?.jobs)) return;

    for (const job of p.module.jobs) {
      const raw = Number(job.intervalMs);
      const interval = Number.isFinite(raw) ? Math.max(MIN_JOB_INTERVAL_MS, raw) : MIN_JOB_INTERVAL_MS;
      if (interval !== raw) {
        console.warn(`[plugins] job "${job.name}" de "${p.manifest.name}": intervalo ${JSON.stringify(job.intervalMs)} inválido o menor al mínimo; usando ${MIN_JOB_INTERVAL_MS} ms`);
      }

      const safeRun = async () => {
        try {
          await job.run(p.ctx);
        } catch (err) {
          p.ctx.logger.error(`job "${job.name}" falló:`, err.message);
        }
      };

      // Una ejecución inmediata (asíncrona, con catch) y luego setInterval (R11).
      safeRun();
      p.jobHandles.push(setInterval(safeRun, interval));
    }
  }

  function stopJobs(p) {
    for (const handle of p.jobHandles) clearInterval(handle);
    p.jobHandles = [];
  }

  // ── Ciclo de vida (R1–R4, R17, R18) ──────────────────────────────
  async function init() {
    for (const entry of registry) {
      // 1. load — thunk con require estático dentro de try/catch (R4)
      let mod;
      try {
        mod = entry.load();
      } catch (err) {
        console.error(`[plugins] error al cargar el plugin "${entry.name}":`, err.message);
        plugins.set(entry.name, {
          manifest: { name: entry.name, title: entry.name, version: null, hasView: false },
          module: null,
          ctx: null,
          status: 'error',
          jobHandles: [],
        });
        continue;
      }

      // 2. validate — manifest inválido/duplicado → descartado (R3)
      const invalid = validateManifest(mod?.manifest, entry.name, plugins);
      if (invalid) {
        console.error(`[plugins] plugin "${entry.name}" descartado: ${invalid}`);
        continue;
      }

      const manifest = {
        name:    mod.manifest.name,
        title:   mod.manifest.title,
        version: mod.manifest.version,
        hasView: Boolean(mod.manifest.hasView),
      };

      // 3. estado persistido (default enabled = 1 en primer registro, R17/R18)
      const enabled = readEnabled(manifest.name);

      const p = {
        manifest,
        module: mod,
        ctx: makeCtx(manifest.name),
        status: enabled ? 'active' : 'disabled',
        jobHandles: [],
      };
      plugins.set(manifest.name, p);

      // 4. init(ctx) — corre una sola vez por proceso, habilitado o no (R4)
      if (typeof mod.init === 'function') {
        try {
          await mod.init(p.ctx);
        } catch (err) {
          console.error(`[plugins] init() del plugin "${manifest.name}" falló:`, err.message);
          stopJobs(p);
          p.status = 'error';
          continue;
        }
      }

      // 5. jobs — solo plugins activos (R11)
      if (p.status === 'active') startJobs(p);
    }
  }

  // ── API pública ──────────────────────────────────────────────────
  function list() {
    return Array.from(plugins.values()).map(p => ({
      name:    p.manifest.name,
      title:   p.manifest.title,
      version: p.manifest.version,
      enabled: p.status === 'active',
      hasView: p.manifest.hasView,
      status:  p.status,
    }));
  }

  function isEnabled(name) {
    const p = plugins.get(name);
    return Boolean(p && p.status === 'active');
  }

  function setEnabled(name, enabled) {
    const p = plugins.get(name);
    if (!p) {
      throw { status: 404, message: 'Plugin no encontrado' };
    }
    if (p.status === 'error') {
      throw { status: 409, message: 'El plugin está en estado de error: requiere corrección y reinicio del servidor' };
    }

    writeEnabled(name, enabled);

    if (enabled && p.status !== 'active') {
      p.status = 'active';
      startJobs(p);
    } else if (!enabled && p.status === 'active') {
      p.status = 'disabled';
      stopJobs(p);
    }

    return { name, enabled: p.status === 'active' };
  }

  function buildRouter(requireAuth) {
    const parent = express.Router();

    for (const p of plugins.values()) {
      if (p.status === 'error') continue;
      if (typeof p.module?.router !== 'function') continue;

      let child;
      try {
        child = p.module.router(p.ctx);
      } catch (err) {
        console.error(`[plugins] router() del plugin "${p.manifest.name}" falló:`, err.message);
        stopJobs(p);
        p.status = 'error';
        continue;
      }

      parent.use(
        `/${p.manifest.name}`,
        requireAuth, // R9 → 401 sin sesión
        (req, res, next) => // gate dinámico por request → R10
          isEnabled(p.manifest.name)
            ? next()
            : res.status(404).json({ ok: false, error: 'Plugin no disponible' }),
        child
      );
    }

    return parent;
  }

  function stopAll() {
    for (const p of plugins.values()) stopJobs(p);
  }

  return { init, list, isEnabled, setEnabled, buildRouter, stopAll };
}

module.exports = createPluginManagerService;
module.exports.MIN_JOB_INTERVAL_MS = MIN_JOB_INTERVAL_MS;
