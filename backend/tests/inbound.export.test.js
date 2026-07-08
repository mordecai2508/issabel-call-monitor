'use strict';

/**
 * inbound.export.test.js — Feature #41 tests
 * Verifies that the inbound export handler enriches rows with
 * agentName, duration_fmt, and disposition_label (R15/R17).
 *
 * Strategy: intercept the data passed to exportService.toXlsx / toPdf
 * by mocking the exportService module.
 */

jest.mock('../services/exportService', () => ({
  toXlsx: jest.fn().mockImplementation((_rows, res) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.end();
    return Promise.resolve();
  }),
  toPdf: jest.fn().mockImplementation((_rows, res) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.end();
  }),
}));

const request        = require('supertest');
const express        = require('express');
const session        = require('express-session');
const inboundRouter  = require('../routes/inbound');
const exportService  = require('../services/exportService');

function extractChannel(raw) {
  if (!raw) return '';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

function makeCdrRow(overrides = {}) {
  return {
    calldate:    new Date('2026-06-07T10:23:45.000Z'),
    src:         '3001234567',
    dst:         '100',
    channel:     'SIP/troncal-claro-00a1b2c3',
    dstchannel:  'Agent/03',
    duration:    95,
    billsec:     87,
    disposition: 'ANSWERED',
    ...overrides,
  };
}

function buildApp(poolQueryImpl, config = {}) {
  const pool = { query: poolQueryImpl };
  const effectiveConfig = {
    server: { sessionSecret: 'test-secret' },
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
  app.use((req, _res, next) => {
    req.session.user = { id: 1, username: 'tester', role: 'monitor' };
    next();
  });

  function requireAuth(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ ok: false, error: 'No autenticado' });
    next();
  }

  app.use('/api', inboundRouter(pool, effectiveConfig, requireAuth, extractChannel));
  return app;
}

function mockExportQuery(rows) {
  return jest.fn().mockResolvedValue([rows]);
}

describe('GET /api/calls/inbound/export — R15/R17: enriched display rows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('displayRows passed to toXlsx include agentName, duration_fmt, disposition_label', async () => {
    const rows = [makeCdrRow({ dstchannel: 'Agent/03', billsec: 87, disposition: 'ANSWERED' })];
    const app  = buildApp(mockExportQuery(rows));

    await request(app)
      .get('/api/calls/inbound/export?from=2026-06-01&to=2026-06-07&format=xlsx')
      .expect(200);

    expect(exportService.toXlsx).toHaveBeenCalledTimes(1);
    const displayRows = exportService.toXlsx.mock.calls[0][0];
    expect(Array.isArray(displayRows)).toBe(true);
    expect(displayRows[0]).toHaveProperty('agentName', 'Agent/03');
    expect(displayRows[0]).toHaveProperty('duration_fmt', '1:27');
    expect(displayRows[0]).toHaveProperty('disposition_label', 'Contestada');
  });

  it('displayRows passed to toPdf include agentName, duration_fmt, disposition_label', async () => {
    const rows = [makeCdrRow({ dstchannel: 'SIP/202-00a1b2c3', billsec: 225, disposition: 'NO ANSWER' })];
    const app  = buildApp(mockExportQuery(rows));

    await request(app)
      .get('/api/calls/inbound/export?from=2026-06-01&to=2026-06-07&format=pdf')
      .expect(200);

    expect(exportService.toPdf).toHaveBeenCalledTimes(1);
    const displayRows = exportService.toPdf.mock.calls[0][0];
    expect(displayRows[0]).toHaveProperty('agentName', '202');
    expect(displayRows[0]).toHaveProperty('duration_fmt', '3:45');
    expect(displayRows[0]).toHaveProperty('disposition_label', 'No contestada');
  });

  it('displayRows have channel resolved via channelAliases', async () => {
    const rows = [makeCdrRow({ channel: 'SIP/troncal-claro-00a1b2c3' })];
    const config = { channelAliases: { 'SIP/troncal-claro': 'Claro' } };
    const app = buildApp(mockExportQuery(rows), config);

    await request(app)
      .get('/api/calls/inbound/export?from=2026-06-01&to=2026-06-07&format=xlsx')
      .expect(200);

    const displayRows = exportService.toXlsx.mock.calls[0][0];
    // extractChannel strips suffix: 'SIP/troncal-claro-00a1b2c3' → 'SIP/troncal-claro'
    expect(displayRows[0].channel).toBe('Claro');
  });
});
