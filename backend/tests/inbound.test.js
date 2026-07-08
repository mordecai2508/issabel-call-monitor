'use strict';

/**
 * inbound.test.js — inbound_filters_export feature tests
 * Uses Jest + Supertest with a mocked MySQL pool (no Issabel DB required).
 */

const request       = require('supertest');
const express       = require('express');
const session       = require('express-session');
const inboundRouter = require('../routes/inbound');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal extractChannel implementation (mirrors server.js) */
function extractChannel(raw) {
  if (!raw) return 'Desconocido';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

/** Sample CDR row returned by the mock pool */
function makeCdrRow(overrides = {}) {
  return {
    calldate:    new Date('2026-06-07T10:23:45.000Z'),
    src:         '3001234567',
    dst:         '100',
    channel:     'SIP/troncal-claro-00a1b2c3',
    duration:    95,
    billsec:     87,
    disposition: 'ANSWERED',
    ...overrides,
  };
}

/**
 * Build a test Express app.
 *
 * @param {object} poolQueryImpl  - jest.fn() implementation for pool.query
 * @param {object} sessionUser    - user to inject into the session (null = not authenticated)
 */
function buildApp(poolQueryImpl, sessionUser = { id: 1, username: 'tester', role: 'monitor' }) {
  const pool = { query: poolQueryImpl };

  const config = { server: { sessionSecret: 'test-secret' } };

  const app = express();
  app.use(express.json());
  app.use(session({
    secret:            config.server.sessionSecret,
    resave:            false,
    saveUninitialized: false,
    cookie:            { httpOnly: true, sameSite: 'lax' },
  }));

  // Inject session user for authenticated tests
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

  app.use('/api', inboundRouter(pool, config, requireAuth, extractChannel));

  return app;
}

// ── Mock factory helpers ──────────────────────────────────────────────────────

/**
 * Mock pool.query that returns count + rows.
 * Used for paginated list endpoint.
 */
function mockListQuery(rows, total = null) {
  const effectiveTotal = total !== null ? total : rows.length;
  let callCount = 0;
  return jest.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // First call = COUNT query
      return Promise.resolve([[{ total: effectiveTotal }]]);
    }
    // Second call = data query
    return Promise.resolve([rows]);
  });
}

/**
 * Mock pool.query for export endpoint (single call returning rows).
 */
function mockExportQuery(rows) {
  return jest.fn().mockResolvedValue([rows]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/calls/inbound', () => {
  it('R1 - debe retornar registros individuales para un rango de fechas válido', async () => {
    const rows = [makeCdrRow()];
    const app  = buildApp(mockListQuery(rows, 1));

    const res = await request(app)
      .get('/api/calls/inbound?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0]).toHaveProperty('calldate');
    expect(res.body.data[0]).toHaveProperty('src');
    expect(res.body.data[0]).toHaveProperty('channel');
    expect(res.body.meta).toHaveProperty('total', 1);
  });

  it('R2 - debe filtrar por troncal y retornar solo registros del canal indicado', async () => {
    const rows = [makeCdrRow({ channel: 'SIP/troncal-claro-00a1b2c3' })];
    const queryFn = mockListQuery(rows, 1);
    const app = buildApp(queryFn);

    const res = await request(app)
      .get('/api/calls/inbound?from=2026-06-01&to=2026-06-08&trunk=SIP%2Ftroncal-claro')
      .expect(200);

    expect(res.body.ok).toBe(true);
    // Verify the SQL was called with trunk param (LIKE filter)
    const calls = queryFn.mock.calls;
    // At least one call should contain the trunk value as a param
    const allParams = calls.flatMap(c => c[1] || []);
    expect(allParams).toContain('SIP/troncal-claro');
  });

  it('R3 - debe filtrar por número origen (búsqueda parcial)', async () => {
    const rows = [makeCdrRow({ src: '3001234567' })];
    const queryFn = mockListQuery(rows, 1);
    const app = buildApp(queryFn);

    const res = await request(app)
      .get('/api/calls/inbound?from=2026-06-01&to=2026-06-08&origin=300123')
      .expect(200);

    expect(res.body.ok).toBe(true);
    const allParams = queryFn.mock.calls.flatMap(c => c[1] || []);
    expect(allParams).toContain('300123');
  });

  it('R4 - debe filtrar por disposition y retornar solo el estado indicado', async () => {
    const rows = [makeCdrRow({ disposition: 'ANSWERED' })];
    const queryFn = mockListQuery(rows, 1);
    const app = buildApp(queryFn);

    const res = await request(app)
      .get('/api/calls/inbound?from=2026-06-01&to=2026-06-08&disposition=ANSWERED')
      .expect(200);

    expect(res.body.ok).toBe(true);
    const allParams = queryFn.mock.calls.flatMap(c => c[1] || []);
    expect(allParams).toContain('ANSWERED');
  });

  it('R5 - debe aplicar múltiples filtros combinados como AND', async () => {
    const rows = [makeCdrRow()];
    const queryFn = mockListQuery(rows, 1);
    const app = buildApp(queryFn);

    const res = await request(app)
      .get('/api/calls/inbound?from=2026-06-01&to=2026-06-08&trunk=SIP%2Ftroncal-claro&origin=300&disposition=ANSWERED')
      .expect(200);

    expect(res.body.ok).toBe(true);
    const allParams = queryFn.mock.calls.flatMap(c => c[1] || []);
    expect(allParams).toContain('SIP/troncal-claro');
    expect(allParams).toContain('300');
    expect(allParams).toContain('ANSWERED');
  });

  it('R6 - debe rechazar con 400 si falta el parámetro from o to', async () => {
    const app = buildApp(jest.fn());

    const res1 = await request(app)
      .get('/api/calls/inbound?from=2026-06-01')
      .expect(400);
    expect(res1.body.ok).toBe(false);
    expect(res1.body.error).toMatch(/to/i);

    const res2 = await request(app)
      .get('/api/calls/inbound?to=2026-06-08')
      .expect(400);
    expect(res2.body.ok).toBe(false);
    expect(res2.body.error).toMatch(/from/i);
  });

  it('R8 - debe rechazar con 400 si disposition tiene un valor inválido', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/calls/inbound?from=2026-06-01&to=2026-06-08&disposition=INVALID')
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/disposition/i);
  });

  it('R9 y R10 - debe paginar correctamente y retornar meta.total, page, limit, totalPages', async () => {
    const rows = Array.from({ length: 10 }, () => makeCdrRow());
    const app  = buildApp(mockListQuery(rows, 250));

    const res = await request(app)
      .get('/api/calls/inbound?from=2026-06-01&to=2026-06-08&page=2&limit=10')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.meta).toMatchObject({
      total:      250,
      page:       2,
      limit:      10,
      totalPages: 25,
    });
  });

  it('R11 - debe rechazar con 400 si limit supera 500', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/calls/inbound?from=2026-06-01&to=2026-06-08&limit=501')
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/limit/i);
  });

  it('R14 - debe retornar array vacío y meta.total=0 cuando no hay resultados', async () => {
    const app = buildApp(mockListQuery([], 0));

    const res = await request(app)
      .get('/api/calls/inbound?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('R25 - debe rechazar con 401 si no hay sesión autenticada', async () => {
    const app = buildApp(jest.fn(), null /* no session user */);

    const res = await request(app)
      .get('/api/calls/inbound?from=2026-06-01&to=2026-06-08')
      .expect(401);

    expect(res.body.ok).toBe(false);
  });
});

describe('GET /api/calls/inbound/export', () => {
  it('R15 - debe responder con Content-Type xlsx para exportación Excel', async () => {
    const rows = [makeCdrRow()];
    const app  = buildApp(mockExportQuery(rows));

    const res = await request(app)
      .get('/api/calls/inbound/export?from=2026-06-01&to=2026-06-08&format=xlsx')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
  });

  it('R19 - debe responder con Content-Type pdf para exportación PDF', async () => {
    const rows = [makeCdrRow()];
    const app  = buildApp(mockExportQuery(rows));

    const res = await request(app)
      .get('/api/calls/inbound/export?from=2026-06-01&to=2026-06-08&format=pdf')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/pdf/);
  });

  it('R23 - debe rechazar con 400 si format no es xlsx ni pdf', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/calls/inbound/export?from=2026-06-01&to=2026-06-08&format=csv')
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/format/i);
  });

  it('R25 - debe rechazar con 401 si no hay sesión autenticada (export)', async () => {
    const app = buildApp(jest.fn(), null /* no session user */);

    const res = await request(app)
      .get('/api/calls/inbound/export?from=2026-06-01&to=2026-06-08&format=xlsx')
      .expect(401);

    expect(res.body.ok).toBe(false);
  });
});
