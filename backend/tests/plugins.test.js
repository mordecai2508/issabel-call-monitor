'use strict';

/**
 * plugins.test.js — plugin_system (feature #54) tests
 * Jest + Supertest con SQLite en memoria y pool MySQL mockeado
 * (nunca BD real de Issabel).
 */

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');

const createPluginManagerService = require('../services/pluginManagerService');
const { MIN_JOB_INTERVAL_MS } = createPluginManagerService;
const pluginsRouter = require('../routes/plugins');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** In-memory SQLite db with the `plugins` table (mirrors db/setup.js). */
function buildSqliteDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
      name       TEXT    PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

const BASE_CONFIG = {
  server: { sessionSecret: 'test-secret', pollIntervalMs: 30000 },
  db: { timezone: '-05:00' },
  channels: { inbound: [], outbound: [] },
};

/** Build a manager with fake plugins (registry entries are object literals). */
function buildManager(registry, opts = {}) {
  const db = opts.db ?? buildSqliteDb();
  const pool = opts.pool ?? { query: jest.fn() };
  const config = opts.config ?? JSON.parse(JSON.stringify(BASE_CONFIG));
  const broadcast = opts.broadcast ?? jest.fn();
  const manager = createPluginManagerService(registry, { pool, db, config, broadcast });
  return { manager, db, pool, config, broadcast };
}

function fakeModule(name, extra = {}) {
  return {
    manifest: { name, title: `Plugin ${name}`, version: '1.0.0', hasView: false },
    ...extra,
  };
}

/** Test app mounting routes/plugins.js + manager.buildRouter (patrón buildApp). */
async function buildApp({ registry = [], sessionUser, db, coreBroadcast } = {}) {
  const sqlite = db ?? buildSqliteDb();
  const broadcastSpy = coreBroadcast ?? jest.fn();
  const { manager } = buildManager(registry, { db: sqlite, broadcast: broadcastSpy });
  await manager.init();

  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }));

  if (sessionUser !== undefined && sessionUser !== null) {
    app.use((req, _res, next) => {
      req.session.user = sessionUser;
      next();
    });
  }

  function requireAuth(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ ok: false, error: 'No autenticado' });
    next();
  }
  function requireAdmin(req, res, next) {
    if (!req.session?.user)                return res.status(401).json({ ok: false, error: 'No autenticado' });
    if (req.session.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Se requiere rol de administrador' });
    next();
  }

  app.use('/api', pluginsRouter(sqlite, requireAuth, requireAdmin, manager, broadcastSpy));
  app.use('/api/plugins', manager.buildRouter(requireAuth));

  return { app, db: sqlite, manager, broadcastSpy };
}

const ADMIN    = { id: 1, username: 'admin', role: 'admin' };
const OPERADOR = { id: 2, username: 'operador', role: 'operador' };

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ── T7 — Unit tests del pluginManagerService ─────────────────────────────────

describe('pluginManagerService — carga y validación', () => {
  it('R1/R2 - plugin válido del registro estático queda registrado con su manifest', async () => {
    const mod = fakeModule('demo', { manifest: { name: 'demo', title: 'Demo', version: '2.1.0', hasView: true } });
    const { manager } = buildManager([{ name: 'demo', load: () => mod }]);
    await manager.init();

    expect(manager.list()).toEqual([
      { name: 'demo', title: 'Demo', version: '2.1.0', enabled: true, hasView: true, status: 'active' },
    ]);
  });

  it('R3 - manifest inválido (sin title) se descarta con log y el arranque continúa', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const bad = { manifest: { name: 'bad', version: '1.0.0' } };
    const { manager } = buildManager([
      { name: 'bad', load: () => bad },
      { name: 'good', load: () => fakeModule('good') },
    ]);
    await manager.init();

    expect(errSpy).toHaveBeenCalled();
    expect(manager.list().map(p => p.name)).toEqual(['good']);
  });

  it('R3 - name no apto para URL se descarta', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const bad = { manifest: { name: 'Bad Name!', title: 'X', version: '1.0.0' } };
    const { manager } = buildManager([{ name: 'Bad Name!', load: () => bad }]);
    await manager.init();

    expect(errSpy).toHaveBeenCalled();
    expect(manager.list()).toEqual([]);
  });

  it('R3 - nombre duplicado se descarta y se conserva el primero', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { manager } = buildManager([
      { name: 'dup', load: () => fakeModule('dup', { manifest: { name: 'dup', title: 'Primero', version: '1.0.0' } }) },
      { name: 'dup', load: () => fakeModule('dup', { manifest: { name: 'dup', title: 'Segundo', version: '1.0.0' } }) },
    ]);
    await manager.init();

    expect(errSpy).toHaveBeenCalled();
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0].title).toBe('Primero');
  });

  it('R4 - load() que lanza deja el plugin en error y el resto activo', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { manager } = buildManager([
      { name: 'broken', load: () => { throw new Error('require boom'); } },
      { name: 'good', load: () => fakeModule('good') },
    ]);
    await manager.init();

    expect(errSpy).toHaveBeenCalled();
    const byName = Object.fromEntries(manager.list().map(p => [p.name, p]));
    expect(byName.broken.status).toBe('error');
    expect(byName.broken.enabled).toBe(false);
    expect(byName.good.status).toBe('active');
  });

  it('R4 - init() que lanza (sync) o rechaza (async) deja el plugin en error y el resto activo', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { manager } = buildManager([
      { name: 'sync-fail', load: () => fakeModule('sync-fail', { init() { throw new Error('sync boom'); } }) },
      { name: 'async-fail', load: () => fakeModule('async-fail', { async init() { throw new Error('async boom'); } }) },
      { name: 'good', load: () => fakeModule('good') },
    ]);
    await manager.init();

    const byName = Object.fromEntries(manager.list().map(p => [p.name, p]));
    expect(byName['sync-fail'].status).toBe('error');
    expect(byName['async-fail'].status).toBe('error');
    expect(byName.good.status).toBe('active');
    expect(manager.isEnabled('sync-fail')).toBe(false);
    expect(manager.isEnabled('good')).toBe(true);
  });
});

describe('pluginManagerService — contexto ctx', () => {
  it('R5/R6/R7 - ctx incluye pool/db/config/broadcast/logger, broadcast con namespace y config inmutable', async () => {
    let ctx;
    const mod = fakeModule('ctxdemo', { init(c) { ctx = c; } });
    const { manager, db, pool, config, broadcast } = buildManager([{ name: 'ctxdemo', load: () => mod }]);
    await manager.init();

    // R5: componentes del contexto
    expect(ctx.pool).toBe(pool);           // pool COMPARTIDO (R16)
    expect(ctx.db).toBe(db);
    expect(typeof ctx.broadcast).toBe('function');
    expect(typeof ctx.logger.info).toBe('function');
    expect(typeof ctx.logger.warn).toBe('function');
    expect(typeof ctx.logger.error).toBe('function');

    // R6: broadcast namespaced
    ctx.broadcast('tick', { a: 1 });
    expect(broadcast).toHaveBeenCalledWith('plugin:ctxdemo:tick', { a: 1 });

    // R7: mutar ctx.config no afecta la config real
    expect(ctx.config.db.timezone).toBe('-05:00');
    expect(() => { ctx.config.db.timezone = '+00:00'; }).toThrow(TypeError);
    expect(config.db.timezone).toBe('-05:00');
    expect(ctx.config).not.toBe(config);
  });
});

describe('pluginManagerService — jobs', () => {
  function jobPlugin(name, intervalMs, run) {
    return fakeModule(name, { jobs: [{ name: 'poll', intervalMs, run }] });
  }

  it('R11/R12 - job con intervalo < 60000 se ejecuta cada 60000 ms con advertencia en log', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const run = jest.fn();
    const { manager } = buildManager([{ name: 'fastjob', load: () => jobPlugin('fastjob', 1000, run) }]);
    await manager.init();

    expect(run).toHaveBeenCalledTimes(1); // ejecución inmediata
    expect(warnSpy).toHaveBeenCalled();

    jest.advanceTimersByTime(MIN_JOB_INTERVAL_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(MIN_JOB_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(3);

    manager.stopAll();
  });

  it('R12 - intervalo inválido (no numérico) se fuerza a 60000 ms con advertencia', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const run = jest.fn();
    const { manager } = buildManager([{ name: 'nanjob', load: () => jobPlugin('nanjob', 'cada hora', run) }]);
    await manager.init();

    expect(warnSpy).toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(MIN_JOB_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);

    manager.stopAll();
  });

  it('R13/R14 - setEnabled(false) detiene los jobs y setEnabled(true) los reanuda', async () => {
    jest.useFakeTimers();
    const run = jest.fn();
    const { manager } = buildManager([{ name: 'togglejob', load: () => jobPlugin('togglejob', MIN_JOB_INTERVAL_MS, run) }]);
    await manager.init();
    expect(run).toHaveBeenCalledTimes(1);

    // Deshabilitar: sin ejecuciones posteriores (R13)
    manager.setEnabled('togglejob', false);
    jest.advanceTimersByTime(MIN_JOB_INTERVAL_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);

    // Rehabilitar: reanuda sin reinicio (R14) — ejecución inmediata + intervalos
    manager.setEnabled('togglejob', true);
    expect(run).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(MIN_JOB_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(3);

    manager.stopAll();
  });

  it('R15 - job cuyo run lanza deja log de error y sigue programado', async () => {
    jest.useFakeTimers();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const run = jest.fn(() => { throw new Error('job boom'); });
    const { manager } = buildManager([{ name: 'failjob', load: () => jobPlugin('failjob', MIN_JOB_INTERVAL_MS, run) }]);
    await manager.init();

    expect(run).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // drenar la promesa del safeRun
    expect(errSpy).toHaveBeenCalledWith('[plugin:failjob]', expect.stringContaining('job'), 'job boom');

    jest.advanceTimersByTime(MIN_JOB_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);       // sigue programado
    expect(manager.isEnabled('failjob')).toBe(true); // el plugin sigue habilitado

    manager.stopAll();
  });
});

describe('pluginManagerService — persistencia del estado', () => {
  it('R17/R18 - enabled default 1 al primer registro y persistencia de setEnabled', async () => {
    const db = buildSqliteDb();
    const { manager } = buildManager([{ name: 'persist', load: () => fakeModule('persist') }], { db });
    await manager.init();

    // R18: fila insertada con enabled = 1 en el primer registro
    let row = db.prepare('SELECT enabled FROM plugins WHERE name = ?').get('persist');
    expect(row.enabled).toBe(1);
    expect(manager.isEnabled('persist')).toBe(true);

    // R17: setEnabled persiste en SQLite
    manager.setEnabled('persist', false);
    row = db.prepare('SELECT enabled FROM plugins WHERE name = ?').get('persist');
    expect(row.enabled).toBe(0);

    // R17: un manager nuevo sobre la misma BD (simula reinicio) lee el estado persistido
    const { manager: manager2 } = buildManager([{ name: 'persist', load: () => fakeModule('persist') }], { db });
    await manager2.init();
    expect(manager2.isEnabled('persist')).toBe(false);
    expect(manager2.list()[0].status).toBe('disabled');
  });

  it('R23/R25 - setEnabled lanza {status:404} para desconocido y {status:409} para plugin en error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { manager } = buildManager([
      { name: 'broken', load: () => { throw new Error('boom'); } },
    ]);
    await manager.init();

    expect(() => manager.setEnabled('nope', true)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => manager.setEnabled('broken', true)).toThrow(expect.objectContaining({ status: 409 }));
  });
});

// ── T8 — Tests HTTP (Supertest) ──────────────────────────────────────────────

function demoPluginModule() {
  return {
    manifest: { name: 'demo', title: 'Demo', version: '1.0.0', hasView: true },
    router() {
      const router = express.Router();
      router.get('/status', (req, res) => res.json({ ok: true, data: 'demo-status' }));
      return router;
    },
  };
}

describe('GET /api/plugins', () => {
  it('R19 - devuelve [{ name, title, version, enabled, hasView, status }] con sesión', async () => {
    const { app } = await buildApp({
      registry: [{ name: 'demo', load: demoPluginModule }],
      sessionUser: OPERADOR,
    });

    const res = await request(app).get('/api/plugins').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([
      { name: 'demo', title: 'Demo', version: '1.0.0', enabled: true, hasView: true, status: 'active' },
    ]);
  });

  it('R20 - sin sesión devuelve 401', async () => {
    const { app } = await buildApp({
      registry: [{ name: 'demo', load: demoPluginModule }],
      sessionUser: null,
    });
    const res = await request(app).get('/api/plugins');
    expect(res.status).toBe(401);
  });

  it('R34 - registro vacío: arranque normal y lista vacía', async () => {
    const { app } = await buildApp({ registry: [], sessionUser: ADMIN });
    const res = await request(app).get('/api/plugins').expect(200);
    expect(res.body).toEqual({ ok: true, data: [] });
  });
});

describe('PATCH /api/admin/plugins/:name', () => {
  it('R21/R26 - admin persiste, aplica al instante y emite plugins_changed', async () => {
    const coreBroadcast = jest.fn();
    const { app, db } = await buildApp({
      registry: [{ name: 'demo', load: demoPluginModule }],
      sessionUser: ADMIN,
      coreBroadcast,
    });

    const res = await request(app)
      .patch('/api/admin/plugins/demo')
      .send({ enabled: false })
      .expect(200);

    expect(res.body).toEqual({ ok: true, data: { name: 'demo', enabled: false } });

    // Persistido en SQLite (R21)
    const row = db.prepare('SELECT enabled FROM plugins WHERE name = ?').get('demo');
    expect(row.enabled).toBe(0);

    // Aplicado al instante: la lista lo refleja sin reinicio (R21)
    const listRes = await request(app).get('/api/plugins').expect(200);
    expect(listRes.body.data[0].enabled).toBe(false);
    expect(listRes.body.data[0].status).toBe('disabled');

    // Notificación en tiempo real (R26)
    expect(coreBroadcast).toHaveBeenCalledWith('plugins_changed', { name: 'demo', enabled: false });
  });

  it('R22 - operador recibe 403 y sin sesión 401', async () => {
    const { app } = await buildApp({
      registry: [{ name: 'demo', load: demoPluginModule }],
      sessionUser: OPERADOR,
    });
    const res = await request(app).patch('/api/admin/plugins/demo').send({ enabled: false });
    expect(res.status).toBe(403);

    const { app: anonApp } = await buildApp({
      registry: [{ name: 'demo', load: demoPluginModule }],
      sessionUser: null,
    });
    const anonRes = await request(anonApp).patch('/api/admin/plugins/demo').send({ enabled: false });
    expect(anonRes.status).toBe(401);
  });

  it('R23 - plugin no registrado devuelve 404', async () => {
    const { app } = await buildApp({ registry: [], sessionUser: ADMIN });
    const res = await request(app).patch('/api/admin/plugins/desconocido').send({ enabled: true });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('R24 - body sin booleano enabled devuelve 400', async () => {
    const { app } = await buildApp({
      registry: [{ name: 'demo', load: demoPluginModule }],
      sessionUser: ADMIN,
    });

    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }]) {
      const res = await request(app).patch('/api/admin/plugins/demo').send(body);
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    }
  });

  it('R25 - habilitar un plugin fallido devuelve 409 con mensaje de corrección y reinicio', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = await buildApp({
      registry: [{ name: 'broken', load: () => { throw new Error('boom'); } }],
      sessionUser: ADMIN,
    });

    const res = await request(app).patch('/api/admin/plugins/broken').send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/corrección y reinicio/);
  });
});

describe('Rutas HTTP de plugins bajo /api/plugins/<nombre>', () => {
  it('R8 - ruta de plugin habilitado responde 200 bajo /api/plugins/<nombre>', async () => {
    const { app } = await buildApp({
      registry: [{ name: 'demo', load: demoPluginModule }],
      sessionUser: OPERADOR,
    });

    const res = await request(app).get('/api/plugins/demo/status').expect(200);
    expect(res.body).toEqual({ ok: true, data: 'demo-status' });
  });

  it('R9 - sin sesión devuelve 401', async () => {
    const { app } = await buildApp({
      registry: [{ name: 'demo', load: demoPluginModule }],
      sessionUser: null,
    });
    const res = await request(app).get('/api/plugins/demo/status');
    expect(res.status).toBe(401);
  });

  it('R10 - tras deshabilitar (sin remontar la app) la ruta responde 404 y vuelve a 200 al habilitar', async () => {
    const { app, manager } = await buildApp({
      registry: [{ name: 'demo', load: demoPluginModule }],
      sessionUser: ADMIN,
    });

    await request(app).get('/api/plugins/demo/status').expect(200);

    manager.setEnabled('demo', false);
    const res = await request(app).get('/api/plugins/demo/status');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'Plugin no disponible' });

    manager.setEnabled('demo', true);
    await request(app).get('/api/plugins/demo/status').expect(200);
  });
});
