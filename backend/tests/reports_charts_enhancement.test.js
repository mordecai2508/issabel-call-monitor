'use strict';

/**
 * reports_charts_enhancement.test.js — feature #28 tests
 *
 * Tests that renderExecutiveBody, renderCallsBody, renderRankingBody call
 * drawBarChart and drawMultiBarChart the expected number of times, and that
 * buildReportXlsx includes a 'Datos para gráfica' sheet in all report types.
 *
 * Chart functions are injected via optional parameters to avoid module-level
 * mocking complexity.
 */

const request       = require('supertest');
const express       = require('express');
const session       = require('express-session');
const Database      = require('better-sqlite3');
const ExcelJS       = require('exceljs');
const reportsRouter = require('../routes/reports');

const {
  renderExecutiveBody,
  renderCallsBody,
  renderRankingBody,
  computeHourly,
} = require('../services/exportService');

// ── Minimal mock PDFDocument ──────────────────────────────────────────────────

function makeMockDoc() {
  const doc = {
    x: 40,
    y: 80,
    page: { width: 595, height: 842 },
  };
  const self = () => doc;
  doc.fontSize   = self;
  doc.font       = self;
  doc.fillColor  = self;
  doc.text       = self;
  doc.moveDown   = self;
  doc.moveTo     = self;
  doc.lineTo     = self;
  doc.stroke     = self;
  doc.rect       = self;
  doc.fill       = self;
  doc.addPage    = () => { doc.y = 40; return doc; };
  return doc;
}

// ── Data fixtures ─────────────────────────────────────────────────────────────

function makeOverallTotals(overrides = {}) {
  return { total: 100, answered: 70, no_answer: 20, busy: 5, failed: 5, avg_duration: 45, ...overrides };
}

function makeTrendPoint(label, overrides = {}) {
  return { period_label: label, total: 10, answered: 7, no_answer: 2, busy: 1, failed: 0, avg_duration: 45, ...overrides };
}

function makeRankingItem(name, overrides = {}) {
  return { name, total: 8, answered: 6, no_answer: 1, busy: 1, failed: 0, avg_duration: 30, ...overrides };
}

function makeCdrRow(overrides = {}) {
  return {
    calldate:    '2026-06-17T10:30:00.000Z',
    src:         '3001234567',
    dst:         '100',
    channel:     'SIP/ENT',
    dstchannel:  'Agent/03',
    duration:    90,
    billsec:     85,
    disposition: 'ANSWERED',
    ...overrides,
  };
}

function makeSummary(overrides = {}) {
  return { total: 5, ANSWERED: 4, 'NO ANSWER': 1, BUSY: 0, FAILED: 0, ...overrides };
}

const EXECUTIVE_DATA = {
  overallTotals:  makeOverallTotals(),
  trend:          [makeTrendPoint('2026-06-01'), makeTrendPoint('2026-06-02')],
  inboundTotals:  { total: 60, ANSWERED: 45, 'NO ANSWER': 10, BUSY: 3, FAILED: 2 },
  outboundTotals: { total: 40, ANSWERED: 25, 'NO ANSWER': 10, BUSY: 2, FAILED: 3 },
  topExtensions:  [makeRankingItem('101'), makeRankingItem('102')],
  topTrunks:      [makeRankingItem('SIP/troncal-claro')],
};

const INBOUND_DATA = {
  type:      'inbound',
  rows:      [makeCdrRow(), makeCdrRow({ calldate: '2026-06-17T14:00:00.000Z' })],
  summary:   makeSummary(),
  truncated: false,
};

const OUTBOUND_DATA = {
  type:      'outbound',
  rows:      [makeCdrRow()],
  summary:   makeSummary({ total: 3 }),
  truncated: false,
};

const EXTENSIONS_DATA = {
  type:     'extensions',
  rankings: [makeRankingItem('101'), makeRankingItem('102'), makeRankingItem('103')],
};

const TRUNKS_DATA = {
  type:     'trunks',
  rankings: [makeRankingItem('SIP/troncal-claro'), makeRankingItem('SIP/troncal-b')],
};

// ── renderExecutiveBody chart call counts ─────────────────────────────────────

describe('renderExecutiveBody — conteo de gráficas (feature #28)', () => {

  function run(data) {
    const doc = makeMockDoc();
    const mockBar   = jest.fn().mockReturnValue(doc.y + 150);
    const mockMulti = jest.fn().mockReturnValue(doc.y + 150);
    renderExecutiveBody(doc, data, mockBar, mockMulti);
    return { mockBar, mockMulti };
  }

  it('con datos: llama a drawBarChart 2 veces (distribución + tendencia total)', () => {
    const { mockBar } = run(EXECUTIVE_DATA);
    expect(mockBar).toHaveBeenCalledTimes(2);
  });

  it('con datos: llama a drawMultiBarChart 1 vez (contestadas vs no contestadas por día)', () => {
    const { mockMulti } = run(EXECUTIVE_DATA);
    expect(mockMulti).toHaveBeenCalledTimes(1);
  });

  it('sin tendencia: llama a drawBarChart 1 vez (solo distribución) y drawMultiBarChart 0 veces', () => {
    const data = { ...EXECUTIVE_DATA, trend: [] };
    const { mockBar, mockMulti } = run(data);
    expect(mockBar).toHaveBeenCalledTimes(1);
    expect(mockMulti).toHaveBeenCalledTimes(0);
  });

  it('el primer drawBarChart recibe las 4 categorías de disposición', () => {
    const { mockBar } = run(EXECUTIVE_DATA);
    const firstCall = mockBar.mock.calls[0][1]; // [doc, opts]
    expect(firstCall.labels).toEqual(['Contestadas', 'No Contestadas', 'Ocupado', 'Fallidas']);
    expect(firstCall.values).toEqual([
      EXECUTIVE_DATA.overallTotals.answered,
      EXECUTIVE_DATA.overallTotals.no_answer,
      EXECUTIVE_DATA.overallTotals.busy,
      EXECUTIVE_DATA.overallTotals.failed,
    ]);
  });

  it('el segundo drawBarChart recibe los totales diarios de tendencia', () => {
    const { mockBar } = run(EXECUTIVE_DATA);
    const secondCall = mockBar.mock.calls[1][1];
    expect(secondCall.labels).toEqual(EXECUTIVE_DATA.trend.map(p => p.period_label));
    expect(secondCall.values).toEqual(EXECUTIVE_DATA.trend.map(p => p.total));
  });

  it('drawMultiBarChart recibe dos series: contestadas y no contestadas', () => {
    const { mockMulti } = run(EXECUTIVE_DATA);
    const opts = mockMulti.mock.calls[0][1];
    expect(opts.series).toHaveLength(2);
    expect(opts.series[0].values).toEqual(EXECUTIVE_DATA.trend.map(p => p.answered));
    expect(opts.series[1].values).toEqual(EXECUTIVE_DATA.trend.map(p => p.no_answer));
  });

});

// ── renderCallsBody chart call counts ─────────────────────────────────────────

describe('renderCallsBody — conteo de gráficas (feature #28)', () => {

  function run(data) {
    const doc     = makeMockDoc();
    const mockBar = jest.fn().mockReturnValue(doc.y + 140);
    renderCallsBody(doc, data, mockBar);
    return { mockBar };
  }

  it('inbound con datos: llama a drawBarChart 2 veces (disposición + horaria)', () => {
    const { mockBar } = run(INBOUND_DATA);
    expect(mockBar).toHaveBeenCalledTimes(2);
  });

  it('outbound con datos: llama a drawBarChart 2 veces', () => {
    const { mockBar } = run(OUTBOUND_DATA);
    expect(mockBar).toHaveBeenCalledTimes(2);
  });

  it('sin filas: llama a drawBarChart 0 veces (ambos gráficos muestran sin datos)', () => {
    const data = { ...INBOUND_DATA, rows: [], summary: { total: 0, ANSWERED: 0, 'NO ANSWER': 0, BUSY: 0, FAILED: 0 } };
    const { mockBar } = run(data);
    expect(mockBar).toHaveBeenCalledTimes(0);
  });

  it('el segundo drawBarChart recibe 24 labels (horas 00-23)', () => {
    const { mockBar } = run(INBOUND_DATA);
    const secondCall = mockBar.mock.calls[1][1];
    expect(secondCall.labels).toHaveLength(24);
    expect(secondCall.labels[0]).toBe('00');
    expect(secondCall.labels[23]).toBe('23');
  });

  it('el segundo drawBarChart refleja la hora de las filas', () => {
    // Both rows have hour 10 UTC (10:30:00Z → getHours() = 10)
    const { mockBar } = run(INBOUND_DATA);
    const secondCall = mockBar.mock.calls[1][1];
    // First row is 10:30Z → h=10; second is 14:00Z → h=14
    expect(secondCall.values[10]).toBe(1);
    expect(secondCall.values[14]).toBe(1);
    // Other hours should be 0
    expect(secondCall.values.reduce((a, b) => a + b, 0)).toBe(2);
  });

});

// ── renderRankingBody chart call counts ───────────────────────────────────────

describe('renderRankingBody — conteo de gráficas (feature #28)', () => {

  function run(data) {
    const doc = makeMockDoc();
    const mockBar   = jest.fn().mockReturnValue(doc.y + 150);
    const mockMulti = jest.fn().mockReturnValue(doc.y + 150);
    renderRankingBody(doc, data, mockBar, mockMulti);
    return { mockBar, mockMulti };
  }

  it('extensions con datos: llama a drawBarChart 1 vez (volumen total)', () => {
    const { mockBar } = run(EXTENSIONS_DATA);
    expect(mockBar).toHaveBeenCalledTimes(1);
  });

  it('extensions con datos: llama a drawMultiBarChart 1 vez (contestadas vs no contestadas)', () => {
    const { mockMulti } = run(EXTENSIONS_DATA);
    expect(mockMulti).toHaveBeenCalledTimes(1);
  });

  it('trunks con datos: llama a drawBarChart 1 vez y drawMultiBarChart 1 vez', () => {
    const { mockBar, mockMulti } = run(TRUNKS_DATA);
    expect(mockBar).toHaveBeenCalledTimes(1);
    expect(mockMulti).toHaveBeenCalledTimes(1);
  });

  it('sin rankings: no llama a drawBarChart ni drawMultiBarChart', () => {
    const data = { ...EXTENSIONS_DATA, rankings: [] };
    const { mockBar, mockMulti } = run(data);
    expect(mockBar).toHaveBeenCalledTimes(0);
    expect(mockMulti).toHaveBeenCalledTimes(0);
  });

  it('drawMultiBarChart recibe dos series: contestadas y no contestadas', () => {
    const { mockMulti } = run(EXTENSIONS_DATA);
    const opts = mockMulti.mock.calls[0][1];
    expect(opts.series).toHaveLength(2);
    expect(opts.series[0].values).toEqual(EXTENSIONS_DATA.rankings.map(r => r.answered));
    expect(opts.series[1].values).toEqual(EXTENSIONS_DATA.rankings.map(r => r.no_answer));
  });

});

// ── computeHourly ─────────────────────────────────────────────────────────────

describe('computeHourly (feature #28)', () => {

  it('devuelve 24 elementos', () => {
    expect(computeHourly([])).toHaveLength(24);
  });

  it('todos los totales son 0 cuando no hay filas', () => {
    const result = computeHourly([]);
    expect(result.every(h => h.total === 0)).toBe(true);
  });

  it('incrementa el conteo correcto para la hora UTC de cada fila', () => {
    const rows = [
      { calldate: '2026-06-17T09:00:00.000Z' }, // h=9
      { calldate: '2026-06-17T09:30:00.000Z' }, // h=9
      { calldate: '2026-06-17T14:00:00.000Z' }, // h=14
    ];
    const result = computeHourly(rows);
    expect(result[9].total).toBe(2);
    expect(result[14].total).toBe(1);
    expect(result.reduce((a, h) => a + h.total, 0)).toBe(3);
  });

  it('no lanza error con calldate inválido', () => {
    const rows = [{ calldate: 'invalid-date' }, { calldate: null }];
    expect(() => computeHourly(rows)).not.toThrow();
  });

});

// ── XLSX 'Datos para gráfica' sheet ──────────────────────────────────────────

// Uses the actual Express app via Supertest to generate real XLSX files

function buildSqliteDb() { return new Database(':memory:'); }

function makeSummaryRow(overrides = {}) {
  return { total: '20', answered: '15', no_answer: '3', busy: '1', failed: '1', avg_duration: '60.00', ...overrides };
}
function makeDayRow(label, overrides = {}) {
  return { period_label: label, total: '10', answered: '7', no_answer: '2', busy: '1', failed: '0', avg_duration: '45.50', ...overrides };
}
function makeRankRow(name, overrides = {}) {
  return { name, total: '8', answered: '6', no_answer: '1', busy: '1', failed: '0', avg_duration: '30.00', ...overrides };
}
function makeInboundRow(overrides = {}) {
  return { calldate: new Date('2026-06-17T10:30:00.000Z'), src: '3001234567', dst: '100', channel: 'SIP/ENT-00a1', dstchannel: '', duration: 90, billsec: 85, disposition: 'ANSWERED', ...overrides };
}
function makeOutboundRow(overrides = {}) {
  return { calldate: new Date('2026-06-17T14:00:00.000Z'), src: '101', dst: '3001234567', dstchannel: 'SIP/troncal-00b2', duration: 120, billsec: 115, disposition: 'ANSWERED', ...overrides };
}

function mockPoolQuery(fixtures = {}) {
  const {
    aggRows      = [makeSummaryRow()],
    dayRows      = [makeDayRow('2026-06-01')],
    extRanking   = [makeRankRow('101')],
    trunkRanking = [makeRankRow('SIP/troncal-claro')],
    inboundRows  = [makeInboundRow()],
    outboundRows = [makeOutboundRow()],
  } = fixtures;

  return jest.fn().mockImplementation((sql) => {
    if (sql.includes("DATE_FORMAT(calldate, '%Y-%m-%d')")) return Promise.resolve([dayRows]);
    if (sql.includes('LEFT(channel,'))                    return Promise.resolve([trunkRanking]);
    if (sql.includes('src') && sql.includes('AS name'))   return Promise.resolve([extRanking]);
    if (sql.includes('dstchannel, channel'))              return Promise.resolve([inboundRows]);
    if (sql.includes('dstchannel'))                       return Promise.resolve([outboundRows]);
    return Promise.resolve([aggRows]);
  });
}

function extractChannel(raw) {
  if (!raw) return 'Desconocido';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

function buildApp(poolQueryImpl) {
  const pool   = { query: poolQueryImpl };
  const db     = buildSqliteDb();
  const config = { server: { sessionSecret: 'test-secret' }, channels: { inbound: [], outbound: [] } };

  const app = express();
  app.use(express.json());
  app.use(session({ secret: config.server.sessionSecret, resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { req.session.user = { id: 1, username: 'tester', role: 'monitor' }; next(); });

  function requireAuth(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ ok: false, error: 'No autenticado' });
    next();
  }

  app.use('/api', reportsRouter(pool, config, db, requireAuth, extractChannel, true));
  return app;
}

async function loadXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

function getBinary(app, url) {
  return request(app).get(url).buffer(true).parse((res, callback) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  });
}

describe('XLSX — hoja Datos para gráfica (feature #28)', () => {

  it('reporte executive incluye hoja "Datos para gráfica" con columnas de tendencia', async () => {
    const app = buildApp(mockPoolQuery());
    const res = await getBinary(app, '/api/reports/executive/xlsx?from=2026-06-01&to=2026-06-17').expect(200);

    const wb = await loadXlsx(res.body);
    const ws = wb.getWorksheet('Datos para gráfica');
    expect(ws).toBeDefined();

    const values = [];
    ws.eachRow(row => values.push(...row.values.filter(v => typeof v === 'string')));
    // Should contain the column headers
    expect(values.some(v => v === 'Contestadas')).toBe(true);
    expect(values.some(v => v === 'No Contestadas')).toBe(true);
  });

  it('reporte inbound incluye hoja "Datos para gráfica" con columna Hora', async () => {
    const app = buildApp(mockPoolQuery());
    const res = await getBinary(app, '/api/reports/inbound/xlsx?from=2026-06-01&to=2026-06-17').expect(200);

    const wb = await loadXlsx(res.body);
    const ws = wb.getWorksheet('Datos para gráfica');
    expect(ws).toBeDefined();

    const values = [];
    ws.eachRow(row => values.push(...row.values.filter(v => typeof v === 'string')));
    expect(values.some(v => v === 'Hora')).toBe(true);
    expect(values.some(v => v === 'Total llamadas')).toBe(true);
  });

  it('reporte outbound incluye hoja "Datos para gráfica" con columna Hora', async () => {
    const app = buildApp(mockPoolQuery());
    const res = await getBinary(app, '/api/reports/outbound/xlsx?from=2026-06-01&to=2026-06-17').expect(200);

    const wb = await loadXlsx(res.body);
    const ws = wb.getWorksheet('Datos para gráfica');
    expect(ws).toBeDefined();
  });

  it('reporte extensions incluye hoja "Datos para gráfica" con columna Nombre', async () => {
    const app = buildApp(mockPoolQuery());
    const res = await getBinary(app, '/api/reports/extensions/xlsx?from=2026-06-01&to=2026-06-17').expect(200);

    const wb = await loadXlsx(res.body);
    const ws = wb.getWorksheet('Datos para gráfica');
    expect(ws).toBeDefined();

    const values = [];
    ws.eachRow(row => values.push(...row.values.filter(v => typeof v === 'string')));
    expect(values.some(v => v === 'Nombre')).toBe(true);
    expect(values.some(v => v === 'Contestadas')).toBe(true);
  });

  it('reporte trunks incluye hoja "Datos para gráfica"', async () => {
    const app = buildApp(mockPoolQuery());
    const res = await getBinary(app, '/api/reports/trunks/xlsx?from=2026-06-01&to=2026-06-17').expect(200);

    const wb = await loadXlsx(res.body);
    const ws = wb.getWorksheet('Datos para gráfica');
    expect(ws).toBeDefined();
  });

  it('hoja "Datos para gráfica" contiene nota sobre ExcelJS streaming', async () => {
    const app = buildApp(mockPoolQuery());
    const res = await getBinary(app, '/api/reports/inbound/xlsx?from=2026-06-01&to=2026-06-17').expect(200);

    const wb = await loadXlsx(res.body);
    const ws = wb.getWorksheet('Datos para gráfica');

    const allValues = [];
    ws.eachRow(row => allValues.push(...row.values.filter(v => typeof v === 'string')));
    expect(allValues.some(v => v.includes('ExcelJS'))).toBe(true);
  });

});
