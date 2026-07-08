'use strict';

/**
 * outbound.export.test.js — Feature #41 tests
 * Verifies that the outbound export handler enriches rows with
 * agentName, duration_fmt, and disposition_label (R16/R17).
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
const outboundRouter = require('../routes/outbound');
const exportService  = require('../services/exportService');

function extractChannel(raw) {
  if (!raw) return '';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

function makeCdrRow(overrides = {}) {
  return {
    calldate:    new Date('2026-06-07T14:35:22.000Z'),
    src:         '101',
    dst:         '3001234567',
    channel:     'SIP/local-ext-101-00aabbcc',
    dstchannel:  'SIP/troncal-claro-00b3c4d5',
    duration:    185,
    billsec:     180,
    disposition: 'ANSWERED',
    ...overrides,
  };
}

function buildApp(poolQueryImpl, config = {}) {
  const pool = { query: poolQueryImpl };
  const effectiveConfig = {
    server:   { sessionSecret: 'test-secret' },
    channels: { inbound: [], outbound: ['SIP/local-ext'] },
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

  app.use('/api', outboundRouter(pool, effectiveConfig, requireAuth, extractChannel));
  return app;
}

function mockExportQuery(rows) {
  return jest.fn().mockResolvedValue([rows]);
}

describe('GET /api/calls/outbound/export — R16/R17: enriched display rows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('displayRows passed to toXlsx include agentName, duration_fmt, disposition_label', async () => {
    const rows = [makeCdrRow({ channel: 'SIP/202-00aabbcc', billsec: 180, disposition: 'ANSWERED' })];
    const app  = buildApp(mockExportQuery(rows));

    await request(app)
      .get('/api/calls/outbound/export?from=2026-06-01&to=2026-06-07&format=xlsx')
      .expect(200);

    expect(exportService.toXlsx).toHaveBeenCalledTimes(1);
    const displayRows = exportService.toXlsx.mock.calls[0][0];
    expect(Array.isArray(displayRows)).toBe(true);
    // channel 'SIP/202-00aabbcc' → extractAgentName → '202'
    expect(displayRows[0]).toHaveProperty('agentName', '202');
    expect(displayRows[0]).toHaveProperty('duration_fmt', '3:00');
    expect(displayRows[0]).toHaveProperty('disposition_label', 'Contestada');
  });

  it('displayRows passed to toPdf include agentName, duration_fmt, disposition_label', async () => {
    const rows = [makeCdrRow({ channel: 'Agent/05-000001ab', billsec: 59, disposition: 'NO ANSWER' })];
    const app  = buildApp(mockExportQuery(rows));

    await request(app)
      .get('/api/calls/outbound/export?from=2026-06-01&to=2026-06-07&format=pdf')
      .expect(200);

    expect(exportService.toPdf).toHaveBeenCalledTimes(1);
    const displayRows = exportService.toPdf.mock.calls[0][0];
    expect(displayRows[0]).toHaveProperty('agentName', 'Agent/05');
    expect(displayRows[0]).toHaveProperty('duration_fmt', '0:59');
    expect(displayRows[0]).toHaveProperty('disposition_label', 'No contestada');
  });

  it('displayRows have dstchannel resolved via channelAliases', async () => {
    const rows = [makeCdrRow({ dstchannel: 'SIP/troncal-claro-00b3c4d5' })];
    const config = {
      channels:      { inbound: [], outbound: ['SIP/local-ext'] },
      channelAliases: { 'SIP/troncal-claro': 'Claro' },
    };
    const app = buildApp(mockExportQuery(rows), config);

    await request(app)
      .get('/api/calls/outbound/export?from=2026-06-01&to=2026-06-07&format=xlsx')
      .expect(200);

    const displayRows = exportService.toXlsx.mock.calls[0][0];
    // extractChannel strips suffix: 'SIP/troncal-claro-00b3c4d5' → 'SIP/troncal-claro'
    expect(displayRows[0].dstchannel).toBe('Claro');
  });
});
