'use strict';

/**
 * config.test.js — system_config feature tests
 * Uses Jest + Supertest with an in-memory SQLite DB and a mocked MySQL pool
 * (no Issabel DB required).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');

const configRouter = require('../routes/config');
const reportService = require('../services/reportService');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fresh in-memory SQLite db with the three new tables (mirrors db/setup.js). */
function buildSqliteDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS extensions_config (
      extension    TEXT PRIMARY KEY,
      display_name TEXT,
      hidden       INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS trunks_config (
      trunk  TEXT PRIMARY KEY,
      hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
    )
  `);
  return db;
}

/** Ranking row as returned by statsService.queryRankings */
function makeRankRow(name, overrides = {}) {
  return {
    name,
    total:        '8',
    answered:     '6',
    no_answer:    '1',
    busy:         '1',
    failed:       '0',
    avg_duration: '30.00',
    ...overrides,
  };
}

/**
 * Build a generic pool.query mock for queryRankings('extension'|'trunk').
 */
function mockPoolQuery({ extRanking = [], trunkRanking = [], reject = false } = {}) {
  return jest.fn().mockImplementation((sql) => {
    if (reject) return Promise.reject(new Error('ECONNREFUSED'));
    if (sql.includes('LEFT(channel,')) {
      return Promise.resolve([trunkRanking]);
    }
    if (sql.includes('src') && sql.includes('AS name')) {
      return Promise.resolve([extRanking]);
    }
    return Promise.resolve([[]]);
  });
}

/**
 * Build a test Express app with the config router mounted.
 *
 * @param {object} opts
 * @param {object} [opts.db] - better-sqlite3 instance (defaults to fresh in-memory)
 * @param {Function} [opts.poolQueryImpl] - pool.query mock implementation
 * @param {object|null} [opts.sessionUser] - session user (null = unauthenticated)
 * @param {object} [opts.config] - parsed config.json stub
 * @param {Function} [opts.getAppName]
 */
function buildApp(opts = {}) {
  const db = opts.db ?? buildSqliteDb();
  const pool = { query: opts.poolQueryImpl ?? mockPoolQuery() };
  const config = opts.config ?? {
    server: { sessionSecret: 'test-secret' },
    db: { timezone: '-05:00' },
    channels: { inbound: ['SIP/troncal-claro'], outbound: [] },
    channelAliases: {},
    app: { name: 'Call Monitor' },
  };
  const getAppName = opts.getAppName ?? (() => config.app?.name || 'Call Monitor');

  const app = express();
  app.use(express.json());
  app.use(session({
    secret:            config.server.sessionSecret,
    resave:            false,
    saveUninitialized: false,
    cookie:            { httpOnly: true, sameSite: 'lax' },
  }));

  if (opts.sessionUser !== undefined && opts.sessionUser !== null) {
    app.use((req, _res, next) => {
      req.session.user = opts.sessionUser;
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

  app.use('/api', configRouter(pool, config, db, requireAuth, requireAdmin, getAppName));

  // ── R39 smoke-test endpoints (mirrors server.js, no file writes to repo) ──
  function getAliases() { return config.channelAliases || {}; }
  const tmpConfigFile = path.join(os.tmpdir(), `call-monitor-config-test-${process.pid}-${Date.now()}.json`);

  app.get('/api/config/public', (req, res) => {
    res.json({ appName: getAppName() });
  });

  app.put('/api/admin/app', requireAdmin, (req, res) => {
    const { name } = req.body || {};
    if (typeof name !== 'string' || !name.trim())
      return res.status(400).json({ ok: false, error: 'El campo name es requerido' });
    if (!config.app) config.app = {};
    config.app.name = name.trim();
    fs.writeFileSync(tmpConfigFile, JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true, name: config.app.name });
  });

  app.get('/api/admin/channels', requireAdmin, (req, res) => {
    const aliases = getAliases();
    const inbound  = (config.channels.inbound  || []).map(ch => ({
      channel: ch,
      direction: 'inbound',
      alias: aliases[ch] || '',
    }));
    const outbound = (config.channels.outbound || []).map(ch => ({
      channel: ch,
      direction: 'outbound',
      alias: aliases[ch] || '',
    }));
    res.json({ ok: true, channels: [...inbound, ...outbound] });
  });

  app.put('/api/admin/channels/:channel', requireAdmin, (req, res) => {
    const channel = decodeURIComponent(req.params.channel);
    const { alias } = req.body || {};
    if (typeof alias !== 'string')
      return res.status(400).json({ ok: false, error: 'El campo alias es requerido' });
    if (!config.channels.inbound.includes(channel) && !config.channels.outbound.includes(channel))
      return res.status(404).json({ ok: false, error: 'Canal no encontrado' });

    if (!config.channelAliases) config.channelAliases = {};
    config.channelAliases[channel] = alias.trim();
    fs.writeFileSync(tmpConfigFile, JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true, alias: config.channelAliases[channel] });
  });

  return { app, db, config, tmpConfigFile };
}

const ADMIN  = { id: 1, username: 'admin', role: 'admin' };
const OPERADOR = { id: 2, username: 'operador', role: 'operador' };

// ── R1/R3 — GET /api/admin/config defaults ─────────────────────────────────────

describe('R1/R3 - GET /api/admin/config (defaults)', () => {
  it('R1/R3 - admin recibe 200 con valores por defecto cuando no hay filas en system_config', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });

    const res = await request(app).get('/api/admin/config').expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({
      companyName: 'Call Monitor',
      timezone: '-05:00',
      language: 'es',
      themeColors: { primary: '#3b82f6', accent: '#1e3a5f' },
      logoUrl: null,
      businessHours: null,
    });
  });
});

// ── R2 — auth ────────────────────────────────────────────────────────────────

describe('R2 - GET /api/admin/config requiere admin', () => {
  it('R2 - sin sesión devuelve 401', async () => {
    const { app } = buildApp({ sessionUser: null });
    const res = await request(app).get('/api/admin/config');
    expect(res.status).toBe(401);
  });

  it('R2 - operador recibe 403', async () => {
    const { app } = buildApp({ sessionUser: OPERADOR });
    const res = await request(app).get('/api/admin/config');
    expect(res.status).toBe(403);
  });
});

// ── R4 — PATCH /api/admin/config persiste solo campos provistos ────────────────

describe('R4 - PATCH /api/admin/config actualiza campos parcialmente', () => {
  it('R4 - actualiza solo companyName, deja el resto sin cambios', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .patch('/api/admin/config')
      .send({ companyName: 'ACME Corp' })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data.companyName).toBe('ACME Corp');
    expect(res.body.data.timezone).toBe('-05:00');
    expect(res.body.data.language).toBe('es');
  });

  it('R4 - actualiza timezone, language y themeColors combinados', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .patch('/api/admin/config')
      .send({ timezone: '-03:00', language: 'en', themeColors: { primary: '#ff0000', accent: '#00ff00' } })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data.timezone).toBe('-03:00');
    expect(res.body.data.language).toBe('en');
    expect(res.body.data.themeColors).toEqual({ primary: '#ff0000', accent: '#00ff00' });
  });

  it('R4 - persiste solo el campo provisto y deja los demás intactos en llamadas posteriores', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });

    await request(app).patch('/api/admin/config').send({ companyName: 'Empresa A' }).expect(200);
    const res = await request(app).patch('/api/admin/config').send({ language: 'en' }).expect(200);

    expect(res.body.data.companyName).toBe('Empresa A');
    expect(res.body.data.language).toBe('en');
  });
});

// ── R5-R8 — validaciones ─────────────────────────────────────────────────────

describe('R5-R8 - PATCH /api/admin/config validación', () => {
  it('R5 - companyName vacío devuelve 400 sin persistir', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });

    const res = await request(app).patch('/api/admin/config').send({ companyName: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const check = await request(app).get('/api/admin/config').expect(200);
    expect(check.body.data.companyName).toBe('Call Monitor');
  });

  it('R6 - timezone con formato incorrecto devuelve 400 sin persistir', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });

    const res = await request(app).patch('/api/admin/config').send({ timezone: 'invalid' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const check = await request(app).get('/api/admin/config').expect(200);
    expect(check.body.data.timezone).toBe('-05:00');
  });

  it('R7 - language no soportado devuelve 400 sin persistir', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });

    const res = await request(app).patch('/api/admin/config').send({ language: 'fr' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const check = await request(app).get('/api/admin/config').expect(200);
    expect(check.body.data.language).toBe('es');
  });

  it('R8 - themeColors.primary no hex devuelve 400 sin persistir', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .patch('/api/admin/config')
      .send({ themeColors: { primary: 'not-a-color', accent: '#000000' } });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const check = await request(app).get('/api/admin/config').expect(200);
    expect(check.body.data.themeColors).toEqual({ primary: '#3b82f6', accent: '#1e3a5f' });
  });

  it('R8 - themeColors.accent no hex devuelve 400 sin persistir', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .patch('/api/admin/config')
      .send({ themeColors: { primary: '#000000', accent: 'nope' } });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const check = await request(app).get('/api/admin/config').expect(200);
    expect(check.body.data.themeColors).toEqual({ primary: '#3b82f6', accent: '#1e3a5f' });
  });

  it('R5/R6/R7/R8 - PATCH inválido no persiste OTROS campos válidos en el mismo body', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .patch('/api/admin/config')
      .send({ companyName: 'Valido', timezone: 'invalid' });
    expect(res.status).toBe(400);

    const check = await request(app).get('/api/admin/config').expect(200);
    expect(check.body.data.companyName).toBe('Call Monitor');
  });
});

// ── R9 — auth en PATCH ─────────────────────────────────────────────────────────

describe('R9 - PATCH /api/admin/config requiere admin', () => {
  it('R9 - sin sesión devuelve 401', async () => {
    const { app } = buildApp({ sessionUser: null });
    const res = await request(app).patch('/api/admin/config').send({ companyName: 'X' });
    expect(res.status).toBe(401);
  });

  it('R9 - operador recibe 403', async () => {
    const { app } = buildApp({ sessionUser: OPERADOR });
    const res = await request(app).patch('/api/admin/config').send({ companyName: 'X' });
    expect(res.status).toBe(403);
  });
});

// ── R10 — integración con reportService.getBranding ────────────────────────────

describe('R10 - companyName disponible para reportService.getBranding', () => {
  it('R10 - tras PATCH companyName, getBranding devuelve el nuevo nombre', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    await request(app).patch('/api/admin/config').send({ companyName: 'ACME Reports SA' }).expect(200);

    const branding = reportService.getBranding(db, 'Fallback Name');
    expect(branding.companyName).toBe('ACME Reports SA');
  });
});

// ── R11-R16 — POST /admin/config/logo ───────────────────────────────────────────

describe('R11-R16 - POST /api/admin/config/logo', () => {
  const PNG_1X1 = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a4944415478da6360000002000154a24f5d0000000049454e44ae426082',
    'hex'
  );

  it('R11 - sube PNG válido <= 2MB, devuelve 200, crea archivo y persiste logoPath', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .post('/api/admin/config/logo')
      .attach('logo', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.logoUrl).toBe('/api/admin/config/logo');

    const logoPath = db.prepare(`SELECT value FROM system_config WHERE key = 'logoPath'`).get().value;
    expect(fs.existsSync(logoPath)).toBe(true);

    // cleanup
    fs.unlinkSync(logoPath);
  });

  it('R12 - MIME no permitido (text/plain) devuelve 400, no crea archivo ni actualiza logoPath', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .post('/api/admin/config/logo')
      .attach('logo', Buffer.from('hello world'), { filename: 'logo.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const row = db.prepare(`SELECT value FROM system_config WHERE key = 'logoPath'`).get();
    expect(row).toBeUndefined();
  });

  it('R13 - archivo > 2MB devuelve 400, no crea archivo ni actualiza logoPath', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const bigBuffer = Buffer.alloc(2 * 1024 * 1024 + 1, 1);

    const res = await request(app)
      .post('/api/admin/config/logo')
      .attach('logo', bigBuffer, { filename: 'big.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const row = db.prepare(`SELECT value FROM system_config WHERE key = 'logoPath'`).get();
    expect(row).toBeUndefined();
  });

  it('R14 - request sin archivo devuelve 400', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });

    const res = await request(app).post('/api/admin/config/logo');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R15 - segunda subida exitosa elimina el archivo de logo anterior', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const first = await request(app)
      .post('/api/admin/config/logo')
      .attach('logo', PNG_1X1, { filename: 'logo1.png', contentType: 'image/png' })
      .expect(200);

    const firstLogoPath = db.prepare(`SELECT value FROM system_config WHERE key = 'logoPath'`).get().value;
    expect(fs.existsSync(firstLogoPath)).toBe(true);

    const second = await request(app)
      .post('/api/admin/config/logo')
      .attach('logo', PNG_1X1, { filename: 'logo2.png', contentType: 'image/png' })
      .expect(200);

    const secondLogoPath = db.prepare(`SELECT value FROM system_config WHERE key = 'logoPath'`).get().value;
    expect(secondLogoPath).not.toBe(firstLogoPath);
    expect(fs.existsSync(firstLogoPath)).toBe(false);
    expect(fs.existsSync(secondLogoPath)).toBe(true);

    // cleanup
    fs.unlinkSync(secondLogoPath);
  });

  it('R16 - sin sesión devuelve 401', async () => {
    const { app } = buildApp({ sessionUser: null });
    const res = await request(app)
      .post('/api/admin/config/logo')
      .attach('logo', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('R16 - operador recibe 403', async () => {
    const { app } = buildApp({ sessionUser: OPERADOR });
    const res = await request(app)
      .post('/api/admin/config/logo')
      .attach('logo', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });
});

// ── R17-R19 — GET /admin/config/logo ────────────────────────────────────────────

describe('R17-R19 - GET /api/admin/config/logo', () => {
  const PNG_1X1 = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a4944415478da6360000002000154a24f5d0000000049454e44ae426082',
    'hex'
  );

  it('R17 - logo configurado y archivo presente devuelve 200 con Content-Type correcto', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    await request(app)
      .post('/api/admin/config/logo')
      .attach('logo', PNG_1X1, { filename: 'logo.png', contentType: 'image/png' })
      .expect(200);

    const res = await request(app).get('/api/admin/config/logo').expect(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);

    const logoPath = db.prepare(`SELECT value FROM system_config WHERE key = 'logoPath'`).get().value;
    fs.unlinkSync(logoPath);
  });

  it('R18 - sin logo configurado devuelve 404', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });
    const res = await request(app).get('/api/admin/config/logo');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('R18 - logoPath apunta a archivo inexistente devuelve 404', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });
    db.prepare(`INSERT INTO system_config (key, value) VALUES ('logoPath', ?)`).run('/no/existe/logo.png');

    const res = await request(app).get('/api/admin/config/logo');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('R19 - sin sesión devuelve 401', async () => {
    const { app } = buildApp({ sessionUser: null });
    const res = await request(app).get('/api/admin/config/logo');
    expect(res.status).toBe(401);
  });
});

// ── R20-R26 — PATCH /admin/extensions/:ext ───────────────────────────────────────

describe('R20-R26 - PATCH /api/admin/extensions/:ext', () => {
  it('R20 - displayName y hidden crean/actualizan fila en extensions_config', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .patch('/api/admin/extensions/101')
      .send({ displayName: 'Recepción', hidden: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ extension: '101', displayName: 'Recepción', hidden: true });

    const row = db.prepare(`SELECT * FROM extensions_config WHERE extension = '101'`).get();
    expect(row.display_name).toBe('Recepción');
    expect(row.hidden).toBe(1);
  });

  it('R21 - :ext vacío (espacio en blanco tras decodeURIComponent) devuelve 400', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });
    // %20 decodes to a single space — a non-empty path segment that Express
    // routes to the handler, which then trims it to an empty string (R21).
    const res = await request(app).patch('/api/admin/extensions/%20').send({ hidden: true });
    expect(res.status).toBe(400);
  });

  it('R22 - displayName no string devuelve 400 sin persistir', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const res = await request(app).patch('/api/admin/extensions/102').send({ displayName: 123 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const row = db.prepare(`SELECT * FROM extensions_config WHERE extension = '102'`).get();
    expect(row).toBeUndefined();
  });

  it('R23 - hidden no booleano devuelve 400 sin persistir', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const res = await request(app).patch('/api/admin/extensions/103').send({ hidden: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const row = db.prepare(`SELECT * FROM extensions_config WHERE extension = '103'`).get();
    expect(row).toBeUndefined();
  });

  it('R24 - body sin displayName ni hidden devuelve 400', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });
    const res = await request(app).patch('/api/admin/extensions/104').send({});
    expect(res.status).toBe(400);
  });

  it('R25 - sin sesión devuelve 401', async () => {
    const { app } = buildApp({ sessionUser: null });
    const res = await request(app).patch('/api/admin/extensions/105').send({ hidden: true });
    expect(res.status).toBe(401);
  });

  it('R25 - operador recibe 403', async () => {
    const { app } = buildApp({ sessionUser: OPERADOR });
    const res = await request(app).patch('/api/admin/extensions/105').send({ hidden: true });
    expect(res.status).toBe(403);
  });

  it('R26 - limpiar displayName y hidden=false elimina la fila', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    await request(app).patch('/api/admin/extensions/106').send({ displayName: 'Ventas', hidden: true }).expect(200);
    let row = db.prepare(`SELECT * FROM extensions_config WHERE extension = '106'`).get();
    expect(row).toBeDefined();

    const res = await request(app).patch('/api/admin/extensions/106').send({ displayName: '', hidden: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ extension: '106', displayName: null, hidden: false });

    row = db.prepare(`SELECT * FROM extensions_config WHERE extension = '106'`).get();
    expect(row).toBeUndefined();
  });
});

// ── GET /admin/extensions (soporte UI) ──────────────────────────────────────────

describe('GET /api/admin/extensions (soporte UI)', () => {
  it('combina ranking CDR con overrides de extensions_config', async () => {
    const { app, db } = buildApp({
      sessionUser: ADMIN,
      poolQueryImpl: mockPoolQuery({ extRanking: [makeRankRow('101'), makeRankRow('102')] }),
    });

    db.prepare(`INSERT INTO extensions_config (extension, display_name, hidden) VALUES ('101', 'Recepción', 1)`).run();

    const res = await request(app).get('/api/admin/extensions').expect(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);

    const ext101 = res.body.data.find(e => e.extension === '101');
    expect(ext101.displayName).toBe('Recepción');
    expect(ext101.hidden).toBe(true);

    const ext102 = res.body.data.find(e => e.extension === '102');
    expect(ext102.displayName).toBeNull();
    expect(ext102.hidden).toBe(false);
  });

  it('devuelve dbUnavailable=true si la consulta a Issabel falla', async () => {
    const { app } = buildApp({
      sessionUser: ADMIN,
      poolQueryImpl: mockPoolQuery({ reject: true }),
    });

    const res = await request(app).get('/api/admin/extensions').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.dbUnavailable).toBe(true);
  });
});

// ── R27-R31 — PATCH /admin/trunks/:trunk ─────────────────────────────────────────

describe('R27-R31 - PATCH /api/admin/trunks/:trunk', () => {
  it('R27 - hidden=true crea fila en trunks_config', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .patch(`/api/admin/trunks/${encodeURIComponent('SIP/troncal-claro')}`)
      .send({ hidden: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ trunk: 'SIP/troncal-claro', hidden: true });

    const row = db.prepare(`SELECT * FROM trunks_config WHERE trunk = ?`).get('SIP/troncal-claro');
    expect(row.hidden).toBe(1);
  });

  it('R27 - hidden=false elimina fila en trunks_config', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    await request(app)
      .patch(`/api/admin/trunks/${encodeURIComponent('SIP/troncal-claro')}`)
      .send({ hidden: true })
      .expect(200);

    const res = await request(app)
      .patch(`/api/admin/trunks/${encodeURIComponent('SIP/troncal-claro')}`)
      .send({ hidden: false });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ trunk: 'SIP/troncal-claro', hidden: false });

    const row = db.prepare(`SELECT * FROM trunks_config WHERE trunk = ?`).get('SIP/troncal-claro');
    expect(row).toBeUndefined();
  });

  it('R28 - hidden ausente devuelve 400 sin persistir', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .patch(`/api/admin/trunks/${encodeURIComponent('SIP/troncal-x')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const row = db.prepare(`SELECT * FROM trunks_config WHERE trunk = ?`).get('SIP/troncal-x');
    expect(row).toBeUndefined();
  });

  it('R28 - hidden no booleano devuelve 400 sin persistir', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .patch(`/api/admin/trunks/${encodeURIComponent('SIP/troncal-y')}`)
      .send({ hidden: 'true' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const row = db.prepare(`SELECT * FROM trunks_config WHERE trunk = ?`).get('SIP/troncal-y');
    expect(row).toBeUndefined();
  });

  it('R29 - :trunk vacío (espacio en blanco tras decodeURIComponent) devuelve 400', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });
    // %20 decodes to a single space — a non-empty path segment that Express
    // routes to the handler, which then trims it to an empty string (R29).
    const res = await request(app).patch('/api/admin/trunks/%20').send({ hidden: true });
    expect(res.status).toBe(400);
  });

  it('R30 - sin sesión devuelve 401', async () => {
    const { app } = buildApp({ sessionUser: null });
    const res = await request(app)
      .patch(`/api/admin/trunks/${encodeURIComponent('SIP/troncal-claro')}`)
      .send({ hidden: true });
    expect(res.status).toBe(401);
  });

  it('R30 - operador recibe 403', async () => {
    const { app } = buildApp({ sessionUser: OPERADOR });
    const res = await request(app)
      .patch(`/api/admin/trunks/${encodeURIComponent('SIP/troncal-claro')}`)
      .send({ hidden: true });
    expect(res.status).toBe(403);
  });

  it('R31 - hidden=false sobre troncal previamente oculta sin otros overrides elimina la fila', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    await request(app)
      .patch(`/api/admin/trunks/${encodeURIComponent('SIP/troncal-z')}`)
      .send({ hidden: true })
      .expect(200);

    let row = db.prepare(`SELECT * FROM trunks_config WHERE trunk = ?`).get('SIP/troncal-z');
    expect(row).toBeDefined();

    await request(app)
      .patch(`/api/admin/trunks/${encodeURIComponent('SIP/troncal-z')}`)
      .send({ hidden: false })
      .expect(200);

    row = db.prepare(`SELECT * FROM trunks_config WHERE trunk = ?`).get('SIP/troncal-z');
    expect(row).toBeUndefined();
  });
});

// ── GET /admin/trunks (soporte UI) ──────────────────────────────────────────────

describe('GET /api/admin/trunks (soporte UI)', () => {
  it('combina ranking CDR con overrides de trunks_config', async () => {
    const { app, db } = buildApp({
      sessionUser: ADMIN,
      poolQueryImpl: mockPoolQuery({ trunkRanking: [makeRankRow('SIP/troncal-claro'), makeRankRow('SIP/troncal-movistar')] }),
    });

    db.prepare(`INSERT INTO trunks_config (trunk, hidden) VALUES ('SIP/troncal-movistar', 1)`).run();

    const res = await request(app).get('/api/admin/trunks').expect(200);
    expect(res.body.ok).toBe(true);

    const claro = res.body.data.find(t => t.trunk === 'SIP/troncal-claro');
    expect(claro.hidden).toBe(false);

    const movistar = res.body.data.find(t => t.trunk === 'SIP/troncal-movistar');
    expect(movistar.hidden).toBe(true);
  });

  it('devuelve dbUnavailable=true si la consulta a Issabel falla', async () => {
    const { app } = buildApp({
      sessionUser: ADMIN,
      poolQueryImpl: mockPoolQuery({ reject: true }),
    });

    const res = await request(app).get('/api/admin/trunks').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.dbUnavailable).toBe(true);
  });
});

// ── R18-R21 — GET/PUT /api/admin/channels (feature #20) ──────────────────────────

describe('R18-R21 - GET/PUT /api/admin/channels (channels_inbound_outbound_split)', () => {
  function buildChannelsApp() {
    return buildApp({
      sessionUser: ADMIN,
      config: {
        server: { sessionSecret: 'test-secret' },
        db: { timezone: '-05:00' },
        channels: {
          inbound:  ['SIP/ENT_LIWA', 'SIP/NET2_ENT_6076854970'],
          outbound: ['SIP/SALIENTE_CALL'],
        },
        channelAliases: { 'SIP/ENT_LIWA': 'Liwa' },
        app: { name: 'Call Monitor' },
      },
    });
  }

  it('R18 - GET /api/admin/channels devuelve direction inbound/outbound por canal', async () => {
    const { app } = buildChannelsApp();
    const res = await request(app).get('/api/admin/channels').expect(200);

    expect(res.body.ok).toBe(true);
    const liwa = res.body.channels.find(c => c.channel === 'SIP/ENT_LIWA');
    expect(liwa).toEqual({ channel: 'SIP/ENT_LIWA', direction: 'inbound', alias: 'Liwa' });

    const saliente = res.body.channels.find(c => c.channel === 'SIP/SALIENTE_CALL');
    expect(saliente).toEqual({ channel: 'SIP/SALIENTE_CALL', direction: 'outbound', alias: '' });
  });

  it('R19 - un canal presente en ambas listas aparece dos veces, una por dirección', async () => {
    const { app } = buildApp({
      sessionUser: ADMIN,
      config: {
        server: { sessionSecret: 'test-secret' },
        db: { timezone: '-05:00' },
        channels: {
          inbound:  ['SIP/AMBOS'],
          outbound: ['SIP/AMBOS'],
        },
        channelAliases: {},
        app: { name: 'Call Monitor' },
      },
    });

    const res = await request(app).get('/api/admin/channels').expect(200);
    const entries = res.body.channels.filter(c => c.channel === 'SIP/AMBOS');

    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.direction).sort()).toEqual(['inbound', 'outbound']);
  });

  it('R20 - PUT /api/admin/channels/:channel actualiza el alias de un canal de channels.outbound', async () => {
    const { app, tmpConfigFile } = buildChannelsApp();

    const res = await request(app)
      .put(`/api/admin/channels/${encodeURIComponent('SIP/SALIENTE_CALL')}`)
      .send({ alias: 'Troncal Saliente' })
      .expect(200);

    expect(res.body).toEqual({ ok: true, alias: 'Troncal Saliente' });
    if (fs.existsSync(tmpConfigFile)) fs.unlinkSync(tmpConfigFile);
  });

  it('R21 - PUT /api/admin/channels/:channel devuelve 404 si el canal no está en inbound ni outbound', async () => {
    const { app, tmpConfigFile } = buildChannelsApp();

    const res = await request(app)
      .put(`/api/admin/channels/${encodeURIComponent('SIP/NO_EXISTE')}`)
      .send({ alias: 'X' });

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    if (fs.existsSync(tmpConfigFile)) fs.unlinkSync(tmpConfigFile);
  });
});

// ── R39 — no-regresión de endpoints existentes ──────────────────────────────────

describe('R39 - no-regresión de endpoints existentes', () => {
  it('GET /api/config/public sigue respondiendo igual que antes', async () => {
    const { app } = buildApp({ sessionUser: null });
    const res = await request(app).get('/api/config/public').expect(200);
    expect(res.body).toEqual({ appName: 'Call Monitor' });
  });

  it('PUT /api/admin/app sigue respondiendo igual que antes', async () => {
    const { app, tmpConfigFile } = buildApp({ sessionUser: ADMIN });
    const res = await request(app).put('/api/admin/app').send({ name: 'Nueva Empresa' }).expect(200);
    expect(res.body).toEqual({ ok: true, name: 'Nueva Empresa' });
    if (fs.existsSync(tmpConfigFile)) fs.unlinkSync(tmpConfigFile);
  });

  it('GET /api/admin/channels sigue respondiendo igual que antes (con direction añadido, feature #20)', async () => {
    const { app } = buildApp({ sessionUser: ADMIN });
    const res = await request(app).get('/api/admin/channels').expect(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.channels)).toBe(true);
    expect(res.body.channels[0]).toEqual({ channel: 'SIP/troncal-claro', direction: 'inbound', alias: '' });
  });

  it('PUT /api/admin/channels/:channel sigue respondiendo igual que antes', async () => {
    const { app, tmpConfigFile } = buildApp({ sessionUser: ADMIN });
    const res = await request(app)
      .put(`/api/admin/channels/${encodeURIComponent('SIP/troncal-claro')}`)
      .send({ alias: 'Claro' })
      .expect(200);
    expect(res.body).toEqual({ ok: true, alias: 'Claro' });
    if (fs.existsSync(tmpConfigFile)) fs.unlinkSync(tmpConfigFile);
  });
});

// ── R2-R5 — migración de config.channels (feature #20) ──────────────────────────
//
// NOTE: backend/server.js es un script autoejecutable (no exporta loadConfig).
// Este bloque define una RÉPLICA LOCAL de la lógica de migración de
// config.channels añadida a loadConfig() en server.js (R2-R5), que debe
// mantenerse idéntica a la implementación real.

/** Mirrors the config.channels migration block added to loadConfig() in server.js (R2-R5) */
function migrateChannels(raw) {
  let changed = false;
  if (Array.isArray(raw.channels)) {
    raw.channels = { inbound: raw.channels, outbound: [] };
    changed = true;
  } else if (raw.channels && typeof raw.channels === 'object') {
    raw.channels.inbound  = raw.channels.inbound  || [];
    raw.channels.outbound = raw.channels.outbound || [];
  } else {
    raw.channels = { inbound: [], outbound: [] };
  }
  return changed;
}

describe('R2-R5 - migración de config.channels (array plano -> {inbound, outbound})', () => {
  it('R2 - debe migrar config.channels de array plano a {inbound, outbound:[]}', () => {
    const raw = { channels: ['SIP/ENT_LIWA', 'SIP/NET2_ENT_6076854970'] };
    const changed = migrateChannels(raw);

    expect(changed).toBe(true);
    expect(raw.channels).toEqual({ inbound: ['SIP/ENT_LIWA', 'SIP/NET2_ENT_6076854970'], outbound: [] });
  });

  it('R3 - la migración no debe perder channelAliases ni otras claves de config.json', () => {
    const raw = {
      db: { host: 'localhost' },
      channels: ['SIP/ENT_LIWA'],
      channelAliases: { 'SIP/ENT_LIWA': 'Liwa' },
      queues: ['8000'],
      lostDestinations: ['s', 'hang', 'hangup'],
      app: { name: 'Call Monitor' },
    };
    const changed = migrateChannels(raw);

    expect(changed).toBe(true);
    expect(raw.channels).toEqual({ inbound: ['SIP/ENT_LIWA'], outbound: [] });
    expect(raw.channelAliases).toEqual({ 'SIP/ENT_LIWA': 'Liwa' });
    expect(raw.db).toEqual({ host: 'localhost' });
    expect(raw.queues).toEqual(['8000']);
    expect(raw.lostDestinations).toEqual(['s', 'hang', 'hangup']);
    expect(raw.app).toEqual({ name: 'Call Monitor' });
  });

  it('R4 - si config.channels ya es {inbound, outbound} no se reescribe config.json', () => {
    const raw = { channels: { inbound: ['SIP/ENT_LIWA'], outbound: ['SIP/SALIENTE_CALL'] } };
    const changed = migrateChannels(raw);

    expect(changed).toBe(false);
    expect(raw.channels).toEqual({ inbound: ['SIP/ENT_LIWA'], outbound: ['SIP/SALIENTE_CALL'] });
  });

  it('R4 - si config.channels ya es {inbound, outbound} pero falta una lista, se usa [] sin marcar changed', () => {
    const raw = { channels: { inbound: ['SIP/ENT_LIWA'] } };
    const changed = migrateChannels(raw);

    expect(changed).toBe(false);
    expect(raw.channels).toEqual({ inbound: ['SIP/ENT_LIWA'], outbound: [] });
  });

  it('R5 - si config.channels no existe, se usan listas vacías sin error', () => {
    const raw = {};
    const changed = migrateChannels(raw);

    expect(changed).toBe(false);
    expect(raw.channels).toEqual({ inbound: [], outbound: [] });
  });
});
