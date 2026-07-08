'use strict';

/**
 * reports.test.js — reports_module feature tests
 * Uses Jest + Supertest with a mocked MySQL pool (no Issabel DB required)
 * and an in-memory SQLite database for getBranding().
 */

const request       = require('supertest');
const express       = require('express');
const session       = require('express-session');
const Database      = require('better-sqlite3');
const reportsRouter = require('../routes/reports');
const inboundRouter = require('../routes/inbound');
const outboundRouter = require('../routes/outbound');
const statsRouter   = require('../routes/stats');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal extractChannel implementation (mirrors server.js) */
function extractChannel(raw) {
  if (!raw) return 'Desconocido';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

/** Sample inbound CDR row returned by the mock pool */
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

/** Sample outbound CDR row returned by the mock pool */
function makeOutboundRow(overrides = {}) {
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

/** Aggregate row as returned by queryHistorical(period='custom') */
function makeAggRow(overrides = {}) {
  return {
    total:        '20',
    answered:     '15',
    no_answer:    '3',
    busy:         '1',
    failed:       '1',
    avg_duration: '60.00',
    ...overrides,
  };
}

/** Daily trend row as returned by queryHistorical(period='day') */
function makeDayRow(label, overrides = {}) {
  return {
    period_label: label,
    total:        '10',
    answered:     '7',
    no_answer:    '2',
    busy:         '1',
    failed:       '0',
    avg_duration: '45.50',
    ...overrides,
  };
}

/** Ranking row as returned by queryRankings */
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
 * Build a generic pool.query mock that inspects the SQL string to decide
 * which fixture to return. Handles all queries issued by reportService
 * (queryHistorical 'custom'/'day', queryRankings 'extension'/'trunk',
 * queryInboundExport, queryOutboundExport), regardless of Promise.all order.
 *
 * @param {object} fixtures
 * @param {object[]} [fixtures.aggRows]      - rows for queryHistorical('custom')
 * @param {object[]} [fixtures.dayRows]      - rows for queryHistorical('day')
 * @param {object[]} [fixtures.extRanking]   - rows for queryRankings('extension')
 * @param {object[]} [fixtures.trunkRanking] - rows for queryRankings('trunk')
 * @param {object[]} [fixtures.inboundRows]  - rows for queryInboundExport
 * @param {object[]} [fixtures.outboundRows] - rows for queryOutboundExport
 */
function mockPoolQuery(fixtures = {}) {
  const {
    aggRows      = [makeAggRow()],
    dayRows      = [makeDayRow('2026-06-01'), makeDayRow('2026-06-02')],
    extRanking   = [makeRankRow('101'), makeRankRow('102')],
    trunkRanking = [makeRankRow('SIP/troncal-claro')],
    inboundRows  = [makeInboundRow()],
    outboundRows = [makeOutboundRow()],
  } = fixtures;

  return jest.fn().mockImplementation((sql) => {
    if (sql.includes("DATE_FORMAT(calldate, '%Y-%m-%d')")) {
      return Promise.resolve([dayRows]);
    }
    if (sql.includes('LEFT(channel,')) {
      return Promise.resolve([trunkRanking]);
    }
    if (sql.includes('src') && sql.includes('AS name')) {
      return Promise.resolve([extRanking]);
    }
    if (sql.includes('dstchannel, channel')) {
      // inbound SELECT includes both dstchannel and channel columns
      return Promise.resolve([inboundRows]);
    }
    if (sql.includes('dstchannel')) {
      return Promise.resolve([outboundRows]);
    }
    // queryHistorical('custom') — single aggregate row, no GROUP BY
    return Promise.resolve([aggRows]);
  });
}

/**
 * Build a fresh in-memory SQLite db (no system_config table by default).
 */
function buildSqliteDb() {
  const db = new Database(':memory:');
  return db;
}

/**
 * Build a test Express app with the reports router mounted.
 *
 * @param {object} poolQueryImpl
 * @param {object} sessionUser - null = unauthenticated
 * @param {object} opts        - { dbOk, db, config }
 */
function buildApp(poolQueryImpl, sessionUser = { id: 1, username: 'tester', role: 'monitor' }, opts = {}) {
  const pool = { query: poolQueryImpl };
  const db   = opts.db ?? buildSqliteDb();
  const dbOk = opts.dbOk !== undefined ? opts.dbOk : true;
  const config = opts.config ?? { server: { sessionSecret: 'test-secret' }, channels: [] };

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

  app.use('/api', reportsRouter(pool, config, db, requireAuth, extractChannel, dbOk));
  app.use('/api', inboundRouter(pool, config, requireAuth, extractChannel));
  app.use('/api', outboundRouter(pool, config, requireAuth, extractChannel));
  app.use('/api', statsRouter(pool, config, requireAuth));

  return app;
}

/**
 * Issue a GET request and buffer the raw binary response body
 * (supertest does not parse application/pdf or spreadsheetml by default).
 *
 * @param {import('express').Express} app
 * @param {string} url
 */
function getBinary(app, url) {
  return request(app)
    .get(url)
    .buffer()
    .parse((res, callback) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}

const REPORT_TYPES = ['executive', 'inbound', 'outbound', 'extensions', 'trunks'];

// ── R1/R2 — generación exitosa para cada tipo ─────────────────────────────────

describe('GET /api/reports/:type/pdf y /xlsx — generación exitosa', () => {
  for (const type of REPORT_TYPES) {
    it(`R1 - ${type}: /pdf retorna 200, Content-Type pdf y Content-Disposition con filename`, async () => {
      const app = buildApp(mockPoolQuery());

      const res = await request(app)
        .get(`/api/reports/${type}/pdf?from=2026-06-01&to=2026-06-08`)
        .expect(200);

      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.headers['content-disposition']).toContain(`reporte_${type}_2026-06-01_2026-06-08.pdf`);
    });

    it(`R2 - ${type}: /xlsx retorna 200, Content-Type xlsx y Content-Disposition con filename`, async () => {
      const app = buildApp(mockPoolQuery());

      const res = await request(app)
        .get(`/api/reports/${type}/xlsx?from=2026-06-01&to=2026-06-08`)
        .expect(200);

      expect(res.headers['content-type']).toMatch(/spreadsheetml/);
      expect(res.headers['content-disposition']).toContain(`reporte_${type}_2026-06-01_2026-06-08.xlsx`);
    });
  }
});

// ── R3 — :type inválido ───────────────────────────────────────────────────────

describe('R3 - tipo de reporte inválido', () => {
  it('retorna 400 en /pdf con tipo inválido', async () => {
    const app = buildApp(mockPoolQuery());

    const res = await request(app)
      .get('/api/reports/invalid/pdf?from=2026-06-01&to=2026-06-08')
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/executive, inbound, outbound, extensions, trunks/);
  });

  it('retorna 400 en /xlsx con tipo inválido', async () => {
    const app = buildApp(mockPoolQuery());

    const res = await request(app)
      .get('/api/reports/invalid/xlsx?from=2026-06-01&to=2026-06-08')
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/executive, inbound, outbound, extensions, trunks/);
  });
});

// ── R4 — from/to ausentes o inválidos ─────────────────────────────────────────

describe('R4 - parámetros from/to inválidos', () => {
  it('retorna 400 si from y to están ausentes', async () => {
    const app = buildApp(mockPoolQuery());

    const res = await request(app)
      .get('/api/reports/executive/pdf')
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/from y to/);
  });

  it('retorna 400 si from tiene formato inválido', async () => {
    const app = buildApp(mockPoolQuery());

    const res = await request(app)
      .get('/api/reports/executive/pdf?from=not-a-date&to=2026-06-08')
      .expect(400);

    expect(res.body.ok).toBe(false);
  });
});

// ── R5 — from > to ─────────────────────────────────────────────────────────────

describe('R5 - from posterior a to', () => {
  it('retorna 400', async () => {
    const app = buildApp(mockPoolQuery());

    const res = await request(app)
      .get('/api/reports/executive/pdf?from=2026-06-10&to=2026-06-01')
      .expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/from no puede ser posterior/);
  });
});

// ── R6 — sin sesión ─────────────────────────────────────────────────────────────

describe('R6 - sin sesión autenticada', () => {
  it('retorna 401 en /pdf', async () => {
    const app = buildApp(mockPoolQuery(), null);

    const res = await request(app)
      .get('/api/reports/executive/pdf?from=2026-06-01&to=2026-06-08')
      .expect(401);

    expect(res.body.ok).toBe(false);
  });

  it('retorna 401 en /xlsx', async () => {
    const app = buildApp(mockPoolQuery(), null);

    const res = await request(app)
      .get('/api/reports/executive/xlsx?from=2026-06-01&to=2026-06-08')
      .expect(401);

    expect(res.body.ok).toBe(false);
  });
});

// ── R7 — rango sin datos ──────────────────────────────────────────────────────

describe('R7 - rango sin registros CDR', () => {
  for (const type of REPORT_TYPES) {
    it(`${type}: /pdf genera un archivo válido (200) cuando no hay datos`, async () => {
      const app = buildApp(mockPoolQuery({
        aggRows:      [makeAggRow({ total: '0', answered: '0', no_answer: '0', busy: '0', failed: '0', avg_duration: null })],
        dayRows:      [],
        extRanking:   [],
        trunkRanking: [],
        inboundRows:  [],
        outboundRows: [],
      }));

      const res = await request(app)
        .get(`/api/reports/${type}/pdf?from=2026-06-01&to=2026-06-08`)
        .expect(200);

      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.body.length || res.text.length).toBeGreaterThan(0);
    });

    it(`${type}: /xlsx genera un archivo válido (200) cuando no hay datos`, async () => {
      const app = buildApp(mockPoolQuery({
        aggRows:      [makeAggRow({ total: '0', answered: '0', no_answer: '0', busy: '0', failed: '0', avg_duration: null })],
        dayRows:      [],
        extRanking:   [],
        trunkRanking: [],
        inboundRows:  [],
        outboundRows: [],
      }));

      const res = await request(app)
        .get(`/api/reports/${type}/xlsx?from=2026-06-01&to=2026-06-08`)
        .expect(200);

      expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    });
  }
});

// ── R8 — DB no disponible ─────────────────────────────────────────────────────

describe('R8 - dbOk = false', () => {
  it('retorna 503 en /pdf', async () => {
    const app = buildApp(mockPoolQuery(), undefined, { dbOk: false });

    const res = await request(app)
      .get('/api/reports/executive/pdf?from=2026-06-01&to=2026-06-08')
      .expect(503);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Base de datos no disponible');
  });

  it('retorna 503 en /xlsx', async () => {
    const app = buildApp(mockPoolQuery(), undefined, { dbOk: false });

    const res = await request(app)
      .get('/api/reports/executive/xlsx?from=2026-06-01&to=2026-06-08')
      .expect(503);

    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Base de datos no disponible');
  });
});

// ── R9 — timeout ──────────────────────────────────────────────────────────────

describe('R9 - timeout en la generación del reporte', () => {
  it('retorna 504 si collectReportData no resuelve antes de 10s y no se enviaron headers', async () => {
    // pool.query never resolves — collectReportData hangs forever,
    // forcing the router's 10s timeout to fire before any data arrives.
    const neverResolve = jest.fn().mockImplementation(() => new Promise(() => {}));
    const app = buildApp(neverResolve);

    const res = await request(app)
      .get('/api/reports/executive/pdf?from=2026-06-01&to=2026-06-08');

    expect(res.status).toBe(504);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('La generación del reporte tardó demasiado');
  }, 15000);
});

// ── R13-R15 — branding (logo/empresa) ─────────────────────────────────────────

describe('R13-R15 - branding en el PDF', () => {
  it('R13/R15 - sin system_config (sin logo), el PDF se genera sin error usando appName', async () => {
    const db = buildSqliteDb(); // no system_config table
    const app = buildApp(mockPoolQuery(), undefined, {
      db,
      config: { server: { sessionSecret: 'test-secret' }, channels: [], app: { name: 'Mi Empresa' } },
    });

    const res = await request(app)
      .get('/api/reports/executive/pdf?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('R14 - con system_config y companyName configurado, el PDF se genera correctamente', async () => {
    const db = buildSqliteDb();
    db.exec(`CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT)`);
    db.prepare('INSERT INTO system_config (key, value) VALUES (?, ?)').run('companyName', 'ACME Corp');

    const app = buildApp(mockPoolQuery(), undefined, { db });

    const res = await request(app)
      .get('/api/reports/executive/pdf?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });
});

// ── R18-R20 — reporte executive ────────────────────────────────────────────────

describe('R18-R20 - reporte executive incluye KPIs, tendencia y top-5', () => {
  it('genera el PDF correctamente con KPIs totales, tendencia diaria y top-5 extensiones/troncales', async () => {
    const app = buildApp(mockPoolQuery({
      aggRows:      [makeAggRow({ total: '50' })],
      dayRows:      [makeDayRow('2026-06-01'), makeDayRow('2026-06-02')],
      extRanking:   [makeRankRow('101'), makeRankRow('102')],
      trunkRanking: [makeRankRow('SIP/troncal-claro')],
    }));

    const res = await request(app)
      .get('/api/reports/executive/pdf?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('genera el XLSX con hojas Resumen, Tendencia, Top Extensiones y Top Troncales', async () => {
    const ExcelJS = require('exceljs');
    const app = buildApp(mockPoolQuery({
      aggRows:      [makeAggRow({ total: '50' })],
      dayRows:      [makeDayRow('2026-06-01'), makeDayRow('2026-06-02')],
      extRanking:   [makeRankRow('101'), makeRankRow('102')],
      trunkRanking: [makeRankRow('SIP/troncal-claro')],
    }));

    const res = await getBinary(app, '/api/reports/executive/xlsx?from=2026-06-01&to=2026-06-08')
      .expect(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const sheetNames = workbook.worksheets.map(ws => ws.name);

    expect(sheetNames).toEqual(expect.arrayContaining(['Resumen', 'Tendencia', 'Top Extensiones', 'Top Troncales']));
  });
});

// ── R21-R24 — reportes inbound / outbound ──────────────────────────────────────

describe('R21-R22 - reporte inbound incluye resumen por disposición y detalle', () => {
  it('genera el XLSX con hojas Resumen y Detalle', async () => {
    const ExcelJS = require('exceljs');
    const app = buildApp(mockPoolQuery({
      inboundRows: [makeInboundRow({ disposition: 'ANSWERED' }), makeInboundRow({ disposition: 'NO ANSWER' })],
    }));

    const res = await getBinary(app, '/api/reports/inbound/xlsx?from=2026-06-01&to=2026-06-08')
      .expect(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const sheetNames = workbook.worksheets.map(ws => ws.name);

    expect(sheetNames).toEqual(expect.arrayContaining(['Resumen', 'Detalle']));

    const detalle = workbook.getWorksheet('Detalle');
    // header block (5 rows) + column header row + 2 data rows
    expect(detalle.rowCount).toBeGreaterThanOrEqual(8);
  });

  it('genera el PDF correctamente', async () => {
    const app = buildApp(mockPoolQuery({
      inboundRows: [makeInboundRow({ disposition: 'ANSWERED' })],
    }));

    const res = await request(app)
      .get('/api/reports/inbound/pdf?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });
});

describe('R23-R24 - reporte outbound incluye resumen por disposición y detalle', () => {
  it('genera el XLSX con hojas Resumen y Detalle', async () => {
    const ExcelJS = require('exceljs');
    const app = buildApp(mockPoolQuery({
      outboundRows: [makeOutboundRow({ disposition: 'ANSWERED' }), makeOutboundRow({ disposition: 'BUSY' })],
    }));

    const res = await getBinary(app, '/api/reports/outbound/xlsx?from=2026-06-01&to=2026-06-08')
      .expect(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const sheetNames = workbook.worksheets.map(ws => ws.name);

    expect(sheetNames).toEqual(expect.arrayContaining(['Resumen', 'Detalle']));
  });

  it('genera el PDF correctamente', async () => {
    const app = buildApp(mockPoolQuery({
      outboundRows: [makeOutboundRow({ disposition: 'ANSWERED' })],
    }));

    const res = await request(app)
      .get('/api/reports/outbound/pdf?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });
});

// ── R25-R28 — reportes extensions / trunks ─────────────────────────────────────

describe('R25-R26 - reporte extensions incluye ranking con columnas esperadas', () => {
  it('genera el XLSX con hoja Ranking y columnas esperadas', async () => {
    const ExcelJS = require('exceljs');
    const app = buildApp(mockPoolQuery({
      extRanking: [makeRankRow('101'), makeRankRow('102'), makeRankRow('103')],
    }));

    const res = await getBinary(app, '/api/reports/extensions/xlsx?from=2026-06-01&to=2026-06-08')
      .expect(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const ranking = workbook.getWorksheet('Ranking');
    expect(ranking).toBeDefined();

    // Header block = 5 rows, then column-header row at row 6
    const headerRow = ranking.getRow(6).values.filter(Boolean);
    expect(headerRow).toEqual(['Nombre', 'Total', 'Contestadas', 'No contestadas', 'Ocupado', 'Fallidas', 'Dur. media (s)']);
  });

  it('genera el PDF correctamente', async () => {
    const app = buildApp(mockPoolQuery({
      extRanking: [makeRankRow('101'), makeRankRow('102')],
    }));

    const res = await request(app)
      .get('/api/reports/extensions/pdf?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });
});

describe('R27-R28 - reporte trunks incluye ranking con columnas esperadas', () => {
  it('genera el XLSX con hoja Ranking y columnas esperadas', async () => {
    const ExcelJS = require('exceljs');
    const app = buildApp(mockPoolQuery({
      trunkRanking: [makeRankRow('SIP/troncal-claro'), makeRankRow('SIP/troncal-movistar')],
    }));

    const res = await getBinary(app, '/api/reports/trunks/xlsx?from=2026-06-01&to=2026-06-08')
      .expect(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const ranking = workbook.getWorksheet('Ranking');
    expect(ranking).toBeDefined();

    const headerRow = ranking.getRow(6).values.filter(Boolean);
    expect(headerRow).toEqual(['Nombre', 'Total', 'Contestadas', 'No contestadas', 'Ocupado', 'Fallidas', 'Dur. media (s)']);
  });

  it('genera el PDF correctamente', async () => {
    const app = buildApp(mockPoolQuery({
      trunkRanking: [makeRankRow('SIP/troncal-claro')],
    }));

    const res = await request(app)
      .get('/api/reports/trunks/pdf?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });
});

// ── R29-R30 — Excel: hojas/columnas/"Sin datos" ───────────────────────────────

describe('R29-R30 - XLSX contiene fila "Sin datos" cuando no hay registros', () => {
  it('inbound: hoja Detalle muestra "Sin datos para el rango seleccionado" sin filas', async () => {
    const ExcelJS = require('exceljs');
    const app = buildApp(mockPoolQuery({ inboundRows: [] }));

    const res = await getBinary(app, '/api/reports/inbound/xlsx?from=2026-06-01&to=2026-06-08')
      .expect(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const detalle = workbook.getWorksheet('Detalle');

    const allValues = [];
    detalle.eachRow(row => allValues.push(...row.values.filter(v => typeof v === 'string')));
    expect(allValues).toContain('Sin datos para el rango seleccionado');
  });

  it('extensions: hoja Ranking muestra "Sin datos para el rango seleccionado" sin filas', async () => {
    const ExcelJS = require('exceljs');
    const app = buildApp(mockPoolQuery({ extRanking: [] }));

    const res = await getBinary(app, '/api/reports/extensions/xlsx?from=2026-06-01&to=2026-06-08')
      .expect(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const ranking = workbook.getWorksheet('Ranking');

    const allValues = [];
    ranking.eachRow(row => allValues.push(...row.values.filter(v => typeof v === 'string')));
    expect(allValues).toContain('Sin datos para el rango seleccionado');
  });
});

// ── R37 — no-regresión ─────────────────────────────────────────────────────────

describe('R37 - no-regresión de endpoints existentes', () => {
  it('GET /api/calls/inbound sigue respondiendo con su contrato original', async () => {
    const queryFn = jest.fn()
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[makeInboundRow()]]);
    const app = buildApp(queryFn);

    const res = await request(app)
      .get('/api/calls/inbound?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty('total', 1);
  });

  it('GET /api/calls/outbound sigue respondiendo con su contrato original', async () => {
    const queryFn = jest.fn()
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[makeOutboundRow()]]);
    const app = buildApp(queryFn);

    const res = await request(app)
      .get('/api/calls/outbound?from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty('total', 1);
  });

  it('GET /api/stats/historical sigue respondiendo con su contrato original', async () => {
    const app = buildApp(mockPoolQuery());

    const res = await request(app)
      .get('/api/stats/historical?period=day&from=2026-06-01&to=2026-06-08')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveProperty('points');
  });
});
