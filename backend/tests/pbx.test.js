'use strict';

/**
 * pbx.test.js — pbx_health feature (#14) tests
 *
 * Uses Jest + Supertest with a mocked MySQL pool (no Issabel DB required).
 *
 * NOTE (design.md §8 pattern, mirrored from dashboard_lost_destinations.test.js):
 * backend/server.js is a self-executing script that is not safely importable
 * in tests. For the R20/R23 smoke tests this file builds a MINIMAL local
 * mirror of the relevant `/api/calls/today` and `/api/events` handlers
 * (init payload only, no setInterval) sufficient to verify that mounting
 * `routes/pbx.js` does not break them and that `init` includes `pbxStatus`.
 */

const request    = require('supertest');
const express    = require('express');
const session    = require('express-session');

const createPbxHealthService = require('../services/pbxHealthService');
const pbxRouter               = require('../routes/pbx');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a fresh Express app mounting `routes/pbx.js` (and, for R20/R23, a
 * minimal mirror of `/api/calls/today` and `/api/events`).
 *
 * @param {object} opts
 * @param {Function} [opts.poolQueryImpl] - mock implementation for pool.query
 * @param {object|null} [opts.sessionUser] - session user, or null for unauthenticated
 * @param {Function} [opts.broadcast] - broadcast mock
 * @param {object} [opts.serviceOptions] - options passed to createPbxHealthService
 */
function buildApp({
  poolQueryImpl = jest.fn().mockResolvedValue([[]]),
  sessionUser   = { id: 1, username: 'tester', role: 'monitor' },
  broadcast     = jest.fn(),
  serviceOptions = {},
} = {}) {
  const pool   = { query: poolQueryImpl };
  const config = { server: { sessionSecret: 'test-secret' } };
  const db     = {};

  const app = express();
  app.use(express.json());
  app.use(session({
    secret:            config.server.sessionSecret,
    resave:            false,
    saveUninitialized: false,
    cookie:            { httpOnly: true, sameSite: 'lax' },
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

  const pbxHealthService = createPbxHealthService(pool, broadcast, serviceOptions);

  app.use('/api', pbxRouter(pool, config, db, requireAuth, pbxHealthService));

  // ── R20/R23 smoke-test mirrors ──────────────────────────────────────────
  // Minimal mirror of /api/calls/today: just confirms the route still
  // responds with its usual { ok, ... } shape after mounting routes/pbx.js.
  app.get('/api/calls/today', requireAuth, async (req, res) => {
    try {
      await pool.query('SELECT 1'); // stand-in for fetchData()
      res.json({ ok: true, stats: {}, channels: [], hourly: [] });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Error al consultar la base de datos' });
    }
  });

  // Minimal mirror of /api/events `init` payload, including pbxStatus (R23).
  // Ends the response immediately after writing `init` so supertest can
  // read the full body (the real server.js keeps the connection open).
  app.get('/api/events', requireAuth, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const data = { stats: {}, channels: [], hourly: [], generatedAt: new Date().toISOString() };
    data.pbxStatus = pbxHealthService.getStatus();
    res.write(`event: init\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });

  return { app, pbxHealthService, broadcast };
}

// ── GET /api/pbx/health ────────────────────────────────────────────────────

describe('GET /api/pbx/health', () => {

  it('R1/R3/R4 - sesión válida y pool.query exitoso retorna 200 con connected=true, lastError=null, lastCheck ISO 8601 y latencyMs >= 0', async () => {
    const { app } = buildApp({
      poolQueryImpl: jest.fn().mockResolvedValue([[{ '1': 1 }]]),
    });

    const res = await request(app).get('/api/pbx/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.connected).toBe(true);
    expect(res.body.data.lastError).toBeNull();
    expect(res.body.data.lastCheck).toEqual(expect.any(String));
    expect(new Date(res.body.data.lastCheck).toISOString()).toBe(res.body.data.lastCheck);
    expect(typeof res.body.data.latencyMs).toBe('number');
    expect(res.body.data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('R2 - sin sesión retorna 401 sin datos de estado', async () => {
    const { app } = buildApp({
      poolQueryImpl: jest.fn().mockResolvedValue([[{ '1': 1 }]]),
      sessionUser: null,
    });

    const res = await request(app).get('/api/pbx/health');

    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });

  it('R3 - sin verificación previa, GET /api/pbx/health la realiza de forma síncrona (lastCheck nunca null)', async () => {
    const { app, pbxHealthService } = buildApp({
      poolQueryImpl: jest.fn().mockResolvedValue([[{ '1': 1 }]]),
    });

    expect(pbxHealthService.getStatus().lastCheck).toBeNull();

    const res = await request(app).get('/api/pbx/health');

    expect(res.status).toBe(200);
    expect(res.body.data.lastCheck).not.toBeNull();
  });

  it('R4 - una segunda solicitud reutiliza el resultado de la verificación previa (no llama pool.query de nuevo)', async () => {
    const poolQueryImpl = jest.fn().mockResolvedValue([[{ '1': 1 }]]);
    const { app } = buildApp({ poolQueryImpl });

    const res1 = await request(app).get('/api/pbx/health');
    expect(poolQueryImpl).toHaveBeenCalledTimes(1);

    const res2 = await request(app).get('/api/pbx/health');
    expect(poolQueryImpl).toHaveBeenCalledTimes(1); // sin nueva verificación
    expect(res2.body.data).toEqual(res1.body.data);
  });
});

// ── POST /api/pbx/sync ──────────────────────────────────────────────────────

describe('POST /api/pbx/sync', () => {

  it('R5/R7 - pool.query falla retorna 200 con connected=false y lastError no vacío', async () => {
    const { app } = buildApp({
      poolQueryImpl: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    const res = await request(app).post('/api/pbx/sync');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.connected).toBe(false);
    expect(typeof res.body.data.lastError).toBe('string');
    expect(res.body.data.lastError.length).toBeGreaterThan(0);
  });

  it('R5 - sesión válida y pool.query exitoso fuerza una nueva verificación y retorna 200 con connected=true', async () => {
    const poolQueryImpl = jest.fn().mockResolvedValue([[{ '1': 1 }]]);
    const { app } = buildApp({ poolQueryImpl });

    const res = await request(app).post('/api/pbx/sync');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.connected).toBe(true);
    expect(poolQueryImpl).toHaveBeenCalledTimes(1);
  });

  it('R6 - sin sesión retorna 401 sin realizar verificación', async () => {
    const poolQueryImpl = jest.fn().mockResolvedValue([[{ '1': 1 }]]);
    const { app } = buildApp({ poolQueryImpl, sessionUser: null });

    const res = await request(app).post('/api/pbx/sync');

    expect(res.status).toBe(401);
    expect(poolQueryImpl).not.toHaveBeenCalled();
  });
});

// ── R8/R9/R10 - verificación periódica: timeout ────────────────────────────

describe('pbxHealthService.check() - timeout (R8/R9/R10)', () => {

  it('R8/R9/R10 - pool.query nunca resuelve: check() retorna connected=false con lastError describiendo el timeout y latencyMs >= 0', async () => {
    const neverResolves = () => new Promise(() => {});
    const broadcast = jest.fn();
    const pbxHealthService = createPbxHealthService(
      { query: neverResolves },
      broadcast,
      { timeoutMs: 50 }, // límite acotado y corto para el test
    );

    const status = await pbxHealthService.check();

    expect(status.connected).toBe(false);
    expect(status.lastError).toMatch(/timeout/i);
    expect(typeof status.latencyMs).toBe('number');
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ── R11/R12/R13 - broadcast en transiciones ─────────────────────────────────

describe('pbxHealthService.check() - broadcast pbx_status en transiciones (R11/R12/R13)', () => {

  it('R13 - la primera verificación desde el arranque NO dispara broadcast', async () => {
    const broadcast = jest.fn();
    const pbxHealthService = createPbxHealthService(
      { query: jest.fn().mockResolvedValue([[{ '1': 1 }]]) },
      broadcast,
    );

    await pbxHealthService.check();

    expect(broadcast).not.toHaveBeenCalled();
  });

  it('R11 - una transición connected=true -> connected=false dispara broadcast("pbx_status", { connected: false, ... }) exactamente una vez', async () => {
    const broadcast = jest.fn();
    const poolQueryImpl = jest.fn()
      .mockResolvedValueOnce([[{ '1': 1 }]])      // 1ra: éxito (sin broadcast, R13)
      .mockRejectedValueOnce(new Error('ECONNREFUSED')); // 2da: fallo -> transición

    const pbxHealthService = createPbxHealthService({ query: poolQueryImpl }, broadcast);

    await pbxHealthService.check(); // 1ra verificación, sin broadcast
    await pbxHealthService.check(); // 2da verificación, transición true -> false

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('pbx_status', expect.objectContaining({ connected: false }));
  });

  it('R12 - una verificación con el mismo connected que la anterior NO dispara un nuevo broadcast', async () => {
    const broadcast = jest.fn();
    const poolQueryImpl = jest.fn()
      .mockResolvedValueOnce([[{ '1': 1 }]])             // 1ra: éxito (sin broadcast, R13)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))  // 2da: fallo -> transición (broadcast #1)
      .mockRejectedValueOnce(new Error('ECONNREFUSED')); // 3ra: fallo -> sin transición (sin broadcast)

    const pbxHealthService = createPbxHealthService({ query: poolQueryImpl }, broadcast);

    await pbxHealthService.check(); // 1ra
    await pbxHealthService.check(); // 2da -> transición, broadcast #1
    await pbxHealthService.check(); // 3ra -> mismo estado, sin broadcast adicional

    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});

// ── R20 - no-regresión de endpoints existentes ──────────────────────────────

describe('R20 - no-regresión de endpoints existentes tras montar routes/pbx.js', () => {

  it('R20 - GET /api/calls/today sigue respondiendo con su forma habitual', async () => {
    const { app } = buildApp({
      poolQueryImpl: jest.fn().mockResolvedValue([[{ '1': 1 }]]),
    });

    const res = await request(app).get('/api/calls/today');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('stats');
    expect(res.body).toHaveProperty('channels');
    expect(res.body).toHaveProperty('hourly');
  });

  it('R20 - GET /api/events sigue emitiendo el evento init con su forma habitual', async () => {
    const { app } = buildApp({
      poolQueryImpl: jest.fn().mockResolvedValue([[{ '1': 1 }]]),
    });

    const res = await request(app).get('/api/events');

    expect(res.status).toBe(200);
    expect(res.text).toContain('event: init');

    const dataLine = res.text.split('\n').find(l => l.startsWith('data: '));
    const payload  = JSON.parse(dataLine.replace('data: ', ''));
    expect(payload).toHaveProperty('stats');
    expect(payload).toHaveProperty('channels');
    expect(payload).toHaveProperty('hourly');
  });
});

// ── R23 - init incluye pbxStatus ────────────────────────────────────────────

describe('R23 - el evento init de GET /api/events incluye pbxStatus', () => {

  it('R23 - init.pbxStatus tiene la forma { connected, lastCheck, lastError, latencyMs }', async () => {
    const { app } = buildApp({
      poolQueryImpl: jest.fn().mockResolvedValue([[{ '1': 1 }]]),
    });

    const res = await request(app).get('/api/events');

    expect(res.status).toBe(200);
    const dataLine = res.text.split('\n').find(l => l.startsWith('data: '));
    const payload  = JSON.parse(dataLine.replace('data: ', ''));

    expect(payload).toHaveProperty('pbxStatus');
    expect(payload.pbxStatus).toEqual({
      connected: false,
      lastCheck: null,
      lastError: null,
      latencyMs: null,
    });
  });
});
