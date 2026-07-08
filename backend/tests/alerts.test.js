'use strict';

/**
 * alerts.test.js — alerts_monitoring feature (#15) tests
 *
 * Uses Jest + Supertest with an in-memory SQLite DB (`:memory:`, mirroring
 * the `alert_rules`/`alerts` tables added to `backend/db/setup.js`) and
 * mocks for `pool.query`, `pbxHealthService.getStatus`, `broadcast`, and
 * `mailService.sendAlertEmail`. No real MySQL/SMTP connections are made.
 */

const request  = require('supertest');
const express  = require('express');
const session  = require('express-session');
const Database = require('better-sqlite3');

const createAlertService = require('../services/alertService');
const alertsRouter        = require('../routes/alerts');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a fresh in-memory SQLite DB with the `alert_rules`/`alerts` tables
 * (mirrors backend/db/setup.js).
 */
/**
 * Format a Date as 'YYYY-MM-DD HH:MM:SS' in LOCAL time (mirrors the
 * `toMySQLDate` used by alertService/server.js and the format of real
 * `cdr.calldate` values).
 *
 * @param {Date} d
 * @returns {string}
 */
function toMySQLDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF'); // mirrors backend/db/setup.js (R9)

  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT    NOT NULL CHECK (type IN ('trunk_down', 'ext_unreachable', 'lost_spike', 'pbx_disconnect')),
      threshold    REAL,
      enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      notify_email TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id     INTEGER REFERENCES alert_rules(id),
      type        TEXT    NOT NULL,
      description TEXT,
      resolved    INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts (resolved, created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_rule_unresolved ON alerts (rule_id, resolved)`);

  return db;
}

/**
 * Build a fresh Express app mounting `routes/alerts.js`, plus the underlying
 * `alertService` instance for direct calls to `evaluateOnce()` in tests.
 *
 * @param {object} opts
 * @param {object} [opts.config] - merged into the default config
 * @param {Function} [opts.poolQueryImpl] - mock implementation for pool.query
 * @param {object|null} [opts.sessionUser] - session user, or null for unauthenticated
 * @param {Function} [opts.broadcast] - broadcast mock
 * @param {{ connected: boolean, lastCheck?: string|null, lastError?: string|null, latencyMs?: number|null }} [opts.pbxStatus]
 * @param {Function} [opts.sendAlertEmail] - mailService.sendAlertEmail mock
 * @param {object} [opts.serviceOptions] - options passed to createAlertService
 */
function buildApp({
  config = {},
  poolQueryImpl = jest.fn().mockResolvedValue([[{ lost_count: 0 }]]),
  sessionUser = { id: 1, username: 'admin', role: 'admin' },
  broadcast = jest.fn(),
  pbxStatus = { connected: true, lastCheck: new Date().toISOString(), lastError: null, latencyMs: 5 },
  sendAlertEmail = jest.fn().mockResolvedValue(undefined),
  serviceOptions = {},
} = {}) {
  const pool = { query: poolQueryImpl };
  const fullConfig = {
    server: { sessionSecret: 'test-secret', pollIntervalMs: 30000 },
    lostDestinations: ['s', 'hang', 'hangup'],
    channels: { inbound: [], outbound: [] },
    ...config,
  };

  const db = createTestDb();

  const pbxHealthService = { getStatus: jest.fn(() => ({ ...pbxStatus })) };
  const mailService = { sendAlertEmail };

  const alertService = createAlertService(pool, fullConfig, db, broadcast, pbxHealthService, mailService, serviceOptions);

  const app = express();
  app.use(express.json());
  app.use(session({
    secret: fullConfig.server.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }));

  if (sessionUser) {
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
    if (!req.session?.user) return res.status(401).json({ ok: false, error: 'No autenticado' });
    if (req.session.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Se requiere rol de administrador' });
    next();
  }

  app.use('/api', alertsRouter(pool, fullConfig, db, requireAuth, requireAdmin, alertService));

  return { app, db, alertService, broadcast, pbxHealthService, sendAlertEmail, poolQueryImpl };
}

// ── R1-R3 — creación de reglas válidas con defaults ─────────────────────────

describe('POST /api/admin/alerts/rules — creación (R1-R3)', () => {
  it('R1/R2/R3 - crea una regla lost_spike válida con enabled=true por defecto y la incluye en el listado', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'lost_spike', threshold: 5 });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({ type: 'lost_spike', threshold: 5, enabled: true, notify_email: null });
    expect(res.body.data.id).toEqual(expect.any(Number));

    const list = await request(app).get('/api/admin/alerts/rules');
    expect(list.status).toBe(200);
    expect(list.body.ok).toBe(true);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: res.body.data.id, type: 'lost_spike', threshold: 5, enabled: true });
  });

  it('R1/R2/R3 - crea una regla pbx_disconnect válida sin threshold (opcional)', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'pbx_disconnect' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ type: 'pbx_disconnect', threshold: null, enabled: true });
  });

  it('R1/R2/R3 - crea una regla trunk_down válida con threshold (minutos)', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'trunk_down', threshold: 30 });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ type: 'trunk_down', threshold: 30, enabled: true });
  });

  it('R1/R2/R3 - crea una regla ext_unreachable válida (persistida para CRUD aunque no se evalúe)', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'ext_unreachable' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ type: 'ext_unreachable', enabled: true });
  });
});

// ── R4 — type inválido ──────────────────────────────────────────────────────

describe('POST /api/admin/alerts/rules — validación de type (R4)', () => {
  it('R4 - type inválido retorna 400 y no persiste cambios', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'not_a_real_type', threshold: 1 });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const list = await request(app).get('/api/admin/alerts/rules');
    expect(list.body.data).toHaveLength(0);
  });
});

// ── R5 — threshold requerido para lost_spike/trunk_down ─────────────────────

describe('POST /api/admin/alerts/rules — validación de threshold (R5)', () => {
  it('R5 - lost_spike sin threshold numérico retorna 400', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'lost_spike' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R5 - trunk_down con threshold no numérico retorna 400', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'trunk_down', threshold: 'no-numero' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R5 - lost_spike con threshold negativo retorna 400', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'lost_spike', threshold: -1 });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

// ── R6 — formato de notify_email ────────────────────────────────────────────

describe('POST /api/admin/alerts/rules — validación de notify_email (R6)', () => {
  it('R6 - notify_email con formato inválido retorna 400 y no persiste', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'pbx_disconnect', notify_email: 'no-es-un-email' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const list = await request(app).get('/api/admin/alerts/rules');
    expect(list.body.data).toHaveLength(0);
  });

  it('R6 - notify_email válido se persiste correctamente', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'pbx_disconnect', notify_email: 'ops@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.data.notify_email).toBe('ops@example.com');
  });
});

// ── R7 — PATCH actualiza solo campos provistos ──────────────────────────────

describe('PATCH /api/admin/alerts/rules/:id — actualización parcial (R7)', () => {
  it('R7 - PATCH actualiza solo threshold dejando enabled/notify_email intactos', async () => {
    const { app } = buildApp();

    const created = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'lost_spike', threshold: 5, notify_email: 'a@b.com' });
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/admin/alerts/rules/${id}`)
      .send({ threshold: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, type: 'lost_spike', threshold: 10, enabled: true, notify_email: 'a@b.com' });
  });

  it('R7 - PATCH actualiza solo enabled', async () => {
    const { app } = buildApp();

    const created = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'pbx_disconnect' });
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/admin/alerts/rules/${id}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, enabled: false, threshold: null });
  });

  it('R7 - PATCH actualiza solo notify_email', async () => {
    const { app } = buildApp();

    const created = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'pbx_disconnect' });
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/admin/alerts/rules/${id}`)
      .send({ notify_email: 'new@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.notify_email).toBe('new@example.com');
  });
});

// ── R8 — id inexistente en PATCH/DELETE ─────────────────────────────────────

describe('PATCH/DELETE /api/admin/alerts/rules/:id — id inexistente (R8)', () => {
  it('R8 - PATCH sobre id inexistente retorna 404 y no hace cambios', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .patch('/api/admin/alerts/rules/9999')
      .send({ enabled: false });

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('R8 - DELETE sobre id inexistente retorna 404', async () => {
    const { app } = buildApp();

    const res = await request(app).delete('/api/admin/alerts/rules/9999');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});

// ── R9 — DELETE no borra alertas históricas ─────────────────────────────────

describe('DELETE /api/admin/alerts/rules/:id — preserva alertas históricas (R9)', () => {
  it('R9 - eliminar una regla retorna 200 y conserva alertas previamente generadas (rule_id intacto)', async () => {
    const { app, db } = buildApp();

    const created = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'pbx_disconnect' });
    const id = created.body.data.id;

    // Insertar manualmente una alerta histórica generada por esta regla
    db.prepare(
      `INSERT INTO alerts (rule_id, type, description, resolved) VALUES (?, ?, ?, ?)`
    ).run(id, 'pbx_disconnect', 'Histórica', 1);

    const res = await request(app).delete(`/api/admin/alerts/rules/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ id });

    const rulesList = await request(app).get('/api/admin/alerts/rules');
    expect(rulesList.body.data).toHaveLength(0);

    const alertRow = db.prepare('SELECT rule_id, type FROM alerts WHERE rule_id = ?').get(id);
    expect(alertRow).toMatchObject({ rule_id: id, type: 'pbx_disconnect' });
  });
});

// ── R10/R11 — auth y roles en /api/admin/alerts/* ───────────────────────────

describe('/api/admin/alerts/rules* — autenticación y rol (R10/R11)', () => {
  it('R10 - sin sesión, GET /admin/alerts/rules retorna 401', async () => {
    const { app } = buildApp({ sessionUser: null });

    const res = await request(app).get('/api/admin/alerts/rules');
    expect(res.status).toBe(401);
  });

  it('R10 - sin sesión, POST /admin/alerts/rules retorna 401', async () => {
    const { app } = buildApp({ sessionUser: null });

    const res = await request(app).post('/api/admin/alerts/rules').send({ type: 'pbx_disconnect' });
    expect(res.status).toBe(401);
  });

  it('R11 - rol no admin (monitor), GET /admin/alerts/rules retorna 403', async () => {
    const { app } = buildApp({ sessionUser: { id: 2, username: 'monitor', role: 'monitor' } });

    const res = await request(app).get('/api/admin/alerts/rules');
    expect(res.status).toBe(403);
  });

  it('R11 - rol no admin (monitor), POST /admin/alerts/rules retorna 403', async () => {
    const { app } = buildApp({ sessionUser: { id: 2, username: 'monitor', role: 'monitor' } });

    const res = await request(app).post('/api/admin/alerts/rules').send({ type: 'pbx_disconnect' });
    expect(res.status).toBe(403);
  });
});

// ── R12/R13 — reglas deshabilitadas no se evalúan ───────────────────────────

describe('evaluateOnce — reglas deshabilitadas (R12/R13)', () => {
  it('R12/R13 - una regla pbx_disconnect con enabled=false no genera alertas aunque connected=false', async () => {
    const { app, alertService, db } = buildApp({ pbxStatus: { connected: false, lastCheck: null, lastError: 'ECONNREFUSED', latencyMs: null } });

    const created = await request(app)
      .post('/api/admin/alerts/rules')
      .send({ type: 'pbx_disconnect' });
    const id = created.body.data.id;

    await request(app).patch(`/api/admin/alerts/rules/${id}`).send({ enabled: false });

    await alertService.evaluateOnce();

    const alerts = db.prepare('SELECT * FROM alerts').all();
    expect(alerts).toHaveLength(0);
  });
});

// ── R14/R15 — creación de alerta y no-duplicación ───────────────────────────

describe('evaluateOnce — creación de alerta y no-duplicación (R14/R15)', () => {
  it('R14/R15 - condición cumplida genera una alerta; un segundo ciclo con la misma condición no duplica', async () => {
    const { app, alertService, db } = buildApp({ pbxStatus: { connected: false, lastCheck: null, lastError: 'ECONNREFUSED', latencyMs: null } });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'pbx_disconnect' });

    await alertService.evaluateOnce();
    let alerts = db.prepare('SELECT * FROM alerts WHERE resolved = 0').all();
    expect(alerts).toHaveLength(1);

    await alertService.evaluateOnce();
    alerts = db.prepare('SELECT * FROM alerts WHERE resolved = 0').all();
    expect(alerts).toHaveLength(1); // sin duplicados
  });
});

// ── R16/R17 — lost_spike ─────────────────────────────────────────────────────

describe('evaluateOnce — lost_spike (R16/R17)', () => {
  it('R16 - genera una alerta cuando el conteo de llamadas perdidas >= threshold', async () => {
    const poolQueryImpl = jest.fn().mockResolvedValue([[{ lost_count: 7 }]]);
    const { app, alertService, db } = buildApp({ poolQueryImpl });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'lost_spike', threshold: 5 });

    await alertService.evaluateOnce();

    const alerts = db.prepare('SELECT * FROM alerts').all();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('lost_spike');
    expect(alerts[0].description).toContain('7');
    expect(alerts[0].description).toContain('5');
  });

  it('R16 - no genera alerta cuando el conteo está por debajo del threshold', async () => {
    const poolQueryImpl = jest.fn().mockResolvedValue([[{ lost_count: 2 }]]);
    const { app, alertService, db } = buildApp({ poolQueryImpl });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'lost_spike', threshold: 5 });

    await alertService.evaluateOnce();

    const alerts = db.prepare('SELECT * FROM alerts').all();
    expect(alerts).toHaveLength(0);
  });

  it('R17 - se omite la evaluación sin generar alerta ni error si pbxHealthService reporta connected=false', async () => {
    const poolQueryImpl = jest.fn().mockResolvedValue([[{ lost_count: 100 }]]);
    const { app, alertService, db } = buildApp({
      poolQueryImpl,
      pbxStatus: { connected: false, lastCheck: null, lastError: 'ECONNREFUSED', latencyMs: null },
    });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'lost_spike', threshold: 5 });

    await expect(alertService.evaluateOnce()).resolves.toBeUndefined();

    // No se generó alerta lost_spike (solo podría existir una pbx_disconnect si
    // existiera esa regla, pero aquí solo creamos lost_spike).
    const alerts = db.prepare('SELECT * FROM alerts').all();
    expect(alerts).toHaveLength(0);
    expect(poolQueryImpl).not.toHaveBeenCalled();
  });
});

// ── R18/R19 — pbx_disconnect ─────────────────────────────────────────────────

describe('evaluateOnce — pbx_disconnect (R18/R19)', () => {
  it('R18 - genera una alerta cuando pbxHealthService.getStatus().connected === false', async () => {
    const { app, alertService, db, pbxHealthService } = buildApp({
      pbxStatus: { connected: false, lastCheck: '2026-06-10T10:00:00.000Z', lastError: 'ECONNREFUSED', latencyMs: null },
    });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'pbx_disconnect' });

    await alertService.evaluateOnce();

    expect(pbxHealthService.getStatus).toHaveBeenCalled();
    const alerts = db.prepare('SELECT * FROM alerts WHERE resolved = 0').all();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('pbx_disconnect');
  });

  it('R19 - una alerta pbx_disconnect no resuelta se auto-resuelve cuando connected vuelve a true', async () => {
    let status = { connected: false, lastCheck: null, lastError: 'ECONNREFUSED', latencyMs: null };
    const pbxHealthService = { getStatus: jest.fn(() => ({ ...status })) };

    const pool = { query: jest.fn().mockResolvedValue([[{ lost_count: 0 }]]) };
    const db = createTestDb();
    const broadcast = jest.fn();
    const mailService = { sendAlertEmail: jest.fn().mockResolvedValue(undefined) };
    const config = { server: { pollIntervalMs: 30000 }, lostDestinations: ['s', 'hang', 'hangup'], channels: { inbound: [], outbound: [] } };

    const alertService = createAlertService(pool, config, db, broadcast, pbxHealthService, mailService);

    db.prepare(`INSERT INTO alert_rules (type, threshold, enabled, notify_email) VALUES ('pbx_disconnect', NULL, 1, NULL)`).run();

    await alertService.evaluateOnce(); // connected=false -> crea alerta
    let unresolved = db.prepare('SELECT * FROM alerts WHERE resolved = 0').all();
    expect(unresolved).toHaveLength(1);

    status = { connected: true, lastCheck: new Date().toISOString(), lastError: null, latencyMs: 5 };
    await alertService.evaluateOnce(); // connected=true -> auto-resuelve

    unresolved = db.prepare('SELECT * FROM alerts WHERE resolved = 0').all();
    expect(unresolved).toHaveLength(0);

    const resolved = db.prepare('SELECT * FROM alerts WHERE resolved = 1').all();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].resolved_at).not.toBeNull();
  });
});

// ── R20-R22 — trunk_down ─────────────────────────────────────────────────────

describe('evaluateOnce — trunk_down (R20-R22)', () => {
  it('R20/R21 - genera alerta cuando no hay actividad CDR reciente para el canal configurado (last_activity antiguo)', async () => {
    const oldDate = toMySQLDate(new Date(Date.now() - 60 * 60_000)); // 60 min atrás
    const poolQueryImpl = jest.fn().mockResolvedValue([[{ last_activity: oldDate }]]);

    const { app, alertService, db } = buildApp({
      poolQueryImpl,
      config: { channels: { inbound: ['SIP/troncal-pstn'], outbound: [] } },
    });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'trunk_down', threshold: 30 });

    await alertService.evaluateOnce();

    const alerts = db.prepare('SELECT * FROM alerts').all();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('trunk_down');
    expect(alerts[0].description).toContain('SIP/troncal-pstn');
  });

  it('R20/R21 - genera alerta cuando last_activity es NULL (sin actividad registrada)', async () => {
    const poolQueryImpl = jest.fn().mockResolvedValue([[{ last_activity: null }]]);

    const { app, alertService, db } = buildApp({
      poolQueryImpl,
      config: { channels: { inbound: ['SIP/troncal-pstn'], outbound: [] } },
    });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'trunk_down', threshold: 30 });

    await alertService.evaluateOnce();

    const alerts = db.prepare('SELECT * FROM alerts').all();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('trunk_down');
  });

  it('R21 - no genera alerta cuando hay actividad CDR reciente (dentro del threshold)', async () => {
    const recentDate = toMySQLDate(new Date(Date.now() - 5 * 60_000)); // 5 min atrás
    const poolQueryImpl = jest.fn().mockResolvedValue([[{ last_activity: recentDate }]]);

    const { app, alertService, db } = buildApp({
      poolQueryImpl,
      config: { channels: { inbound: ['SIP/troncal-pstn'], outbound: [] } },
    });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'trunk_down', threshold: 30 });

    await alertService.evaluateOnce();

    const alerts = db.prepare('SELECT * FROM alerts').all();
    expect(alerts).toHaveLength(0);
  });

  it('R22 - si config.channels está vacío, la regla trunk_down no genera alertas', async () => {
    const poolQueryImpl = jest.fn().mockResolvedValue([[{ last_activity: null }]]);

    const { app, alertService, db } = buildApp({
      poolQueryImpl,
      config: { channels: { inbound: [], outbound: [] } },
    });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'trunk_down', threshold: 30 });

    await alertService.evaluateOnce();

    const alerts = db.prepare('SELECT * FROM alerts').all();
    expect(alerts).toHaveLength(0);
  });
});

// ── R23/R24 — ext_unreachable fuera de alcance de evaluación ────────────────

describe('evaluateOnce — ext_unreachable (R23/R24)', () => {
  it('R23/R24 - una regla ext_unreachable se persiste pero evaluateOnce() no genera alertas para ella', async () => {
    const { app, alertService, db } = buildApp();

    const created = await request(app).post('/api/admin/alerts/rules').send({ type: 'ext_unreachable' });
    expect(created.status).toBe(201);

    await alertService.evaluateOnce();

    const alerts = db.prepare('SELECT * FROM alerts').all();
    expect(alerts).toHaveLength(0);

    const rules = db.prepare('SELECT * FROM alert_rules').all();
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe('ext_unreachable');
  });
});

// ── R25 — broadcast SSE 'alert' ─────────────────────────────────────────────

describe('evaluateOnce — broadcast SSE alert (R25)', () => {
  it('R25 - una alerta nueva dispara broadcast("alert", { id, type, description, resolved, created_at })', async () => {
    const { app, alertService, broadcast } = buildApp({
      pbxStatus: { connected: false, lastCheck: null, lastError: 'ECONNREFUSED', latencyMs: null },
    });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'pbx_disconnect' });

    await alertService.evaluateOnce();

    expect(broadcast).toHaveBeenCalledWith('alert', expect.objectContaining({
      id: expect.any(Number),
      type: 'pbx_disconnect',
      description: expect.any(String),
      resolved: false,
      created_at: expect.any(String),
    }));
  });
});

// ── R26-R28 — notificación por correo ───────────────────────────────────────

describe('evaluateOnce — notificación por correo (R26-R28)', () => {
  it('R26 - notify_email configurado dispara mailService.sendAlertEmail', async () => {
    const { app, alertService, sendAlertEmail } = buildApp({
      pbxStatus: { connected: false, lastCheck: null, lastError: 'ECONNREFUSED', latencyMs: null },
    });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'pbx_disconnect', notify_email: 'ops@example.com' });

    await alertService.evaluateOnce();

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendAlertEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@example.com' }));
  });

  it('R27 - si mailService.sendAlertEmail rechaza, la alerta y el broadcast ocurren igual sin excepción no controlada', async () => {
    const sendAlertEmail = jest.fn().mockRejectedValue(new Error('SMTP no disponible'));
    const { app, alertService, broadcast, db } = buildApp({
      pbxStatus: { connected: false, lastCheck: null, lastError: 'ECONNREFUSED', latencyMs: null },
      sendAlertEmail,
    });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'pbx_disconnect', notify_email: 'ops@example.com' });

    await expect(alertService.evaluateOnce()).resolves.toBeUndefined();

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('alert', expect.any(Object));

    const alerts = db.prepare('SELECT * FROM alerts').all();
    expect(alerts).toHaveLength(1);
  });

  it('R28 - notify_email vacío/null no dispara mailService.sendAlertEmail', async () => {
    const { app, alertService, sendAlertEmail } = buildApp({
      pbxStatus: { connected: false, lastCheck: null, lastError: 'ECONNREFUSED', latencyMs: null },
    });

    await request(app).post('/api/admin/alerts/rules').send({ type: 'pbx_disconnect' }); // sin notify_email

    await alertService.evaluateOnce();

    expect(sendAlertEmail).not.toHaveBeenCalled();
  });
});

// ── R29/R30 — GET /api/alerts/active ────────────────────────────────────────

describe('GET /api/alerts/active (R29/R30)', () => {
  it('R29 - devuelve las alertas no resueltas ordenadas por más reciente primero', async () => {
    const { app, db } = buildApp({ sessionUser: { id: 2, username: 'monitor', role: 'monitor' } });

    db.prepare(`INSERT INTO alert_rules (type, threshold, enabled, notify_email) VALUES ('pbx_disconnect', NULL, 1, NULL)`).run();
    db.prepare(`INSERT INTO alerts (rule_id, type, description, resolved, created_at) VALUES (1, 'pbx_disconnect', 'Primera', 0, '2026-06-10 10:00:00')`).run();
    db.prepare(`INSERT INTO alerts (rule_id, type, description, resolved, created_at) VALUES (1, 'pbx_disconnect', 'Segunda', 0, '2026-06-10 11:00:00')`).run();
    db.prepare(`INSERT INTO alerts (rule_id, type, description, resolved, created_at, resolved_at) VALUES (1, 'pbx_disconnect', 'Resuelta', 1, '2026-06-10 09:00:00', '2026-06-10 09:30:00')`).run();

    const res = await request(app).get('/api/alerts/active');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].description).toBe('Segunda');
    expect(res.body.data[1].description).toBe('Primera');
    for (const alert of res.body.data) {
      expect(alert).toHaveProperty('id');
      expect(alert).toHaveProperty('rule_id');
      expect(alert).toHaveProperty('type');
      expect(alert).toHaveProperty('description');
      expect(alert).toHaveProperty('created_at');
      expect(alert.resolved).toBe(false);
    }
  });

  it('R30 - sin sesión retorna 401', async () => {
    const { app } = buildApp({ sessionUser: null });

    const res = await request(app).get('/api/alerts/active');
    expect(res.status).toBe(401);
  });
});

// ── R31-R33 — PATCH /api/alerts/:id/resolve ─────────────────────────────────

describe('PATCH /api/alerts/:id/resolve (R31-R33)', () => {
  it('R31 - marca la alerta como resuelta y persiste resolved_at', async () => {
    const { app, db } = buildApp({ sessionUser: { id: 2, username: 'monitor', role: 'monitor' } });

    db.prepare(`INSERT INTO alert_rules (type, threshold, enabled, notify_email) VALUES ('pbx_disconnect', NULL, 1, NULL)`).run();
    const insert = db.prepare(`INSERT INTO alerts (rule_id, type, description, resolved) VALUES (1, 'pbx_disconnect', 'Activa', 0)`).run();
    const id = insert.lastInsertRowid;

    const res = await request(app).patch(`/api/alerts/${id}/resolve`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.resolved).toBe(true);
    expect(res.body.data.resolved_at).toEqual(expect.any(String));
  });

  it('R32 - id inexistente retorna 404 y no hace cambios', async () => {
    const { app } = buildApp({ sessionUser: { id: 2, username: 'monitor', role: 'monitor' } });

    const res = await request(app).patch('/api/alerts/9999/resolve');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('R33 - alerta ya resuelta retorna 409 y no hace cambios', async () => {
    const { app, db } = buildApp({ sessionUser: { id: 2, username: 'monitor', role: 'monitor' } });

    db.prepare(`INSERT INTO alert_rules (type, threshold, enabled, notify_email) VALUES ('pbx_disconnect', NULL, 1, NULL)`).run();
    const insert = db.prepare(
      `INSERT INTO alerts (rule_id, type, description, resolved, resolved_at) VALUES (1, 'pbx_disconnect', 'Ya resuelta', 1, '2026-06-10 09:30:00')`
    ).run();
    const id = insert.lastInsertRowid;

    const res = await request(app).patch(`/api/alerts/${id}/resolve`);

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);

    const row = db.prepare('SELECT resolved_at FROM alerts WHERE id = ?').get(id);
    expect(row.resolved_at).toBe('2026-06-10 09:30:00'); // sin cambios
  });
});
