'use strict';

/**
 * outbound.test.js — outbound_filters_export feature tests
 * Uses Jest + Supertest with a mocked MySQL pool (no Issabel DB required).
 */

const request        = require('supertest');
const express        = require('express');
const session        = require('express-session');
const outboundRouter = require('../routes/outbound');
const inboundRouter  = require('../routes/inbound');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal extractChannel implementation (mirrors server.js) */
function extractChannel(raw) {
  if (!raw) return 'Desconocido';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

/** Sample outbound CDR row returned by the mock pool */
function makeCdrRow(overrides = {}) {
  return {
    calldate:    new Date('2026-06-07T14:35:22.000Z'),
    src:         '101',
    dst:         '3001234567',
    dstchannel:  'SIP/troncal-claro-00b3c4d5',
    duration:    185,
    billsec:     180,
    disposition: 'ANSWERED',
    ...overrides,
  };
}

/** Sample inbound CDR row for no-regression test */
function makeInboundRow(overrides = {}) {
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
 * @param {object} config         - optional config override
 */
function buildApp(poolQueryImpl, sessionUser = { id: 1, username: 'tester', role: 'monitor' }, config = {}) {
  const pool = { query: poolQueryImpl };

  const effectiveConfig = {
    server: { sessionSecret: 'test-secret' },
    channels: { inbound: [], outbound: [] },
    ...config,
  };

  const app = express();
  app.use(express.json());
  app.use(session({
    secret:            effectiveConfig.server.sessionSecret,
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

  app.use('/api', outboundRouter(pool, effectiveConfig, requireAuth, extractChannel));
  app.use('/api', inboundRouter(pool, effectiveConfig, requireAuth, extractChannel));

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

describe('GET /api/calls/outbound', () => {
  it('R1 - debe retornar registros individuales para un rango de fechas válido', async () => {
    const rows = [makeCdrRow()];
    const app  = buildApp(mockListQuery(rows, 1));

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0]).toHaveProperty('calldate');
    expect(res.body.data[0]).toHaveProperty('src');
    expect(res.body.data[0]).toHaveProperty('dstchannel');
    expect(res.body.meta).toHaveProperty('total', 1);
  });

  it('R2 - debe filtrar por troncal saliente (dstchannel) y retornar solo registros del canal indicado', async () => {
    const rows = [makeCdrRow({ dstchannel: 'SIP/troncal-claro-00b3c4d5' })];
    const queryFn = mockListQuery(rows, 1);
    const app = buildApp(queryFn);

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08&trunk=SIP%2Ftroncal-claro')
      .expect(200);

    expect(res.body.ok).toBe(true);
    const allParams = queryFn.mock.calls.flatMap(c => c[1] || []);
    expect(allParams).toContain('SIP/troncal-claro');
  });

  it('R3 - debe filtrar por extensión origen (src) con búsqueda parcial', async () => {
    const rows = [makeCdrRow({ src: '101' })];
    const queryFn = mockListQuery(rows, 1);
    const app = buildApp(queryFn);

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08&extension=10')
      .expect(200);

    expect(res.body.ok).toBe(true);
    const allParams = queryFn.mock.calls.flatMap(c => c[1] || []);
    expect(allParams).toContain('10');
  });

  it('R4 - debe filtrar por número destino (dst) con búsqueda parcial', async () => {
    const rows = [makeCdrRow({ dst: '3001234567' })];
    const queryFn = mockListQuery(rows, 1);
    const app = buildApp(queryFn);

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08&dest=300123')
      .expect(200);

    expect(res.body.ok).toBe(true);
    const allParams = queryFn.mock.calls.flatMap(c => c[1] || []);
    expect(allParams).toContain('300123');
  });

  it('R5 - debe filtrar por disposition y retornar solo el estado indicado', async () => {
    const rows = [makeCdrRow({ disposition: 'ANSWERED' })];
    const queryFn = mockListQuery(rows, 1);
    const app = buildApp(queryFn);

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08&disposition=ANSWERED')
      .expect(200);

    expect(res.body.ok).toBe(true);
    const allParams = queryFn.mock.calls.flatMap(c => c[1] || []);
    expect(allParams).toContain('ANSWERED');
  });

  it('R6 - debe aplicar múltiples filtros combinados como AND', async () => {
    const rows = [makeCdrRow()];
    const queryFn = mockListQuery(rows, 1);
    const app = buildApp(queryFn);

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08&trunk=SIP%2Ftroncal-claro&extension=10&dest=300&disposition=ANSWERED')
      .expect(200);

    expect(res.body.ok).toBe(true);
    const allParams = queryFn.mock.calls.flatMap(c => c[1] || []);
    expect(allParams).toContain('SIP/troncal-claro');
    expect(allParams).toContain('10');
    expect(allParams).toContain('300');
    expect(allParams).toContain('ANSWERED');
  });

  it('R7 - debe rechazar con 400 si falta el parámetro from o to', async () => {
    const app = buildApp(jest.fn());

    const res1 = await request(app)
      .get('/api/calls/outbound?from=2026-06-01')
      .expect(400);
    expect(res1.body.ok).toBe(false);
    expect(res1.body.error).toMatch(/to/i);

    const res2 = await request(app)
      .get('/api/calls/outbound?to=2026-06-08')
      .expect(400);
    expect(res2.body.ok).toBe(false);
    expect(res2.body.error).toMatch(/from/i);
  });

  it('R9 - debe rechazar con 400 si disposition tiene un valor inválido', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08&disposition=INVALID')
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/disposition/i);
  });

  it('R12 y R13 - debe paginar correctamente y retornar meta.total, page, limit, totalPages', async () => {
    const rows = Array.from({ length: 10 }, () => makeCdrRow());
    const app  = buildApp(mockListQuery(rows, 250));

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08&page=2&limit=10')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.meta).toMatchObject({
      total:      250,
      page:       2,
      limit:      10,
      totalPages: 25,
    });
  });

  it('R14 - debe rechazar con 400 si limit supera 500', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08&limit=501')
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/limit/i);
  });

  it('R17 - debe retornar array vacío y meta.total=0 cuando no hay resultados', async () => {
    const app = buildApp(mockListQuery([], 0));

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('R28 - debe rechazar con 401 si no hay sesión autenticada', async () => {
    const app = buildApp(jest.fn(), null /* no session user */);

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08')
      .expect(401);

    expect(res.body.ok).toBe(false);
  });

  it('R17 - debe devolver solo canales de channels.outbound (LIKE explícito), no por exclusión de inbound', async () => {
    const rows = [makeCdrRow({ dstchannel: 'SIP/SALIENTE_CALL-00b3c4d5' })];
    const queryFn = mockListQuery(rows, 1);
    const app = buildApp(queryFn, undefined, {
      channels: { inbound: ['SIP/ENT_LIWA'], outbound: ['SIP/SALIENTE_CALL'] },
    });

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.body.ok).toBe(true);

    // El WHERE generado debe usar inclusión explícita LIKE CONCAT(?, '%') con
    // el canal de channels.outbound, no NOT LIKE de channels.inbound.
    const dataSql = queryFn.mock.calls[1][0];
    expect(dataSql).toMatch(/channel LIKE CONCAT\(\?, '%'\)/);
    expect(dataSql).not.toMatch(/NOT LIKE CONCAT/);

    const allParams = queryFn.mock.calls.flatMap(c => c[1] || []);
    expect(allParams).toContain('SIP/SALIENTE_CALL');
    expect(allParams).not.toContain('SIP/ENT_LIWA');
  });

  it('R12 - no incluye llamadas extension-a-extension (canal fuera de channels.outbound)', async () => {
    const queryFn = mockListQuery([], 0);
    const app = buildApp(queryFn, undefined, {
      channels: { inbound: ['SIP/ENT_LIWA'], outbound: ['SIP/SALIENTE_CALL'] },
    });

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.body.ok).toBe(true);

    const dataSql = queryFn.mock.calls[1][0];
    // El WHERE solo permite canales que empiecen por 'SIP/SALIENTE_CALL';
    // un canal de extensión interna (ej. SIP/201) no aparece en los params.
    const allParams = queryFn.mock.calls.flatMap(c => c[1] || []);
    expect(allParams).not.toContain('SIP/201');
    expect(dataSql).toMatch(/channel NOT LIKE 'Local\/%'/);
  });

  it("R10 - con channels.outbound vacío devuelve data:[] y meta.total=0 con HTTP 200", async () => {
    const queryFn = mockListQuery([], 0);
    const app = buildApp(queryFn, undefined, {
      channels: { inbound: ['SIP/ENT_LIWA'], outbound: [] },
    });

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);

    // El WHERE debe contener la condición constante '1 = 0'
    const countSql = queryFn.mock.calls[0][0];
    expect(countSql).toMatch(/1 = 0/);
  });
});

describe('GET /api/calls/outbound/export', () => {
  it('R18 - debe responder con Content-Type xlsx para exportación Excel', async () => {
    const rows = [makeCdrRow()];
    const app  = buildApp(mockExportQuery(rows));

    const res = await request(app)
      .get('/api/calls/outbound/export?from=2026-06-01&to=2026-06-08&format=xlsx')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
  });

  it('R22 - debe responder con Content-Type pdf para exportación PDF', async () => {
    const rows = [makeCdrRow()];
    const app  = buildApp(mockExportQuery(rows));

    const res = await request(app)
      .get('/api/calls/outbound/export?from=2026-06-01&to=2026-06-08&format=pdf')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/pdf/);
  });

  it('R26 - debe rechazar con 400 si format no es xlsx ni pdf', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/calls/outbound/export?from=2026-06-01&to=2026-06-08&format=csv')
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/format/i);
  });

  it('R28 - debe rechazar con 401 si no hay sesión autenticada (export)', async () => {
    const app = buildApp(jest.fn(), null /* no session user */);

    const res = await request(app)
      .get('/api/calls/outbound/export?from=2026-06-01&to=2026-06-08&format=xlsx')
      .expect(401);

    expect(res.body.ok).toBe(false);
  });
});

describe('R32 - no-regresión: GET /api/calls/inbound', () => {
  it('R32 (no-regresión) - GET /api/calls/inbound sigue respondiendo con su contrato original', async () => {
    const rows = [makeInboundRow()];
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
});
