'use strict';

/**
 * stats.test.js — historical_analytics feature tests
 * Uses Jest + Supertest with a mocked MySQL pool (no Issabel DB required).
 */

const request     = require('supertest');
const express     = require('express');
const session     = require('express-session');
const statsRouter = require('../routes/stats');

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp(poolQueryImpl, sessionUser = { id: 1, username: 'tester', role: 'monitor' }) {
  const pool   = { query: poolQueryImpl };
  const config = { server: { sessionSecret: 'test-secret' } };

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

  app.use('/api', statsRouter(pool, config, requireAuth));
  return app;
}

/** Build a historical row as MySQL would return */
function makeHistoricalRow(label, overrides = {}) {
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

/** Build a compare/custom aggregate row */
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

/** Build a rankings row */
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

// ── /api/stats/historical ─────────────────────────────────────────────────────

describe('GET /api/stats/historical', () => {

  it('R1 - parámetros válidos retornan 200 y estructura correcta', async () => {
    const rows = [makeHistoricalRow('2026-05-01'), makeHistoricalRow('2026-05-02')];
    const app  = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/historical?period=day&from=2026-05-01&to=2026-05-31');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({ period: 'day', from: '2026-05-01', to: '2026-05-31' });
    expect(Array.isArray(res.body.data.points)).toBe(true);
    expect(res.body.data.points).toHaveLength(2);
  });

  it('R2 - period=day: period_label tiene formato YYYY-MM-DD', async () => {
    const rows = [makeHistoricalRow('2026-05-15')];
    const app  = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/historical?period=day&from=2026-05-01&to=2026-05-31');

    expect(res.status).toBe(200);
    expect(res.body.data.points[0].period_label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('R3 - period=week: period_label tiene formato YYYY-Www', async () => {
    const rows = [makeHistoricalRow('2026-W20')];
    const app  = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/historical?period=week&from=2026-05-01&to=2026-05-31');

    expect(res.status).toBe(200);
    expect(res.body.data.points[0].period_label).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('R4 - period=month: period_label tiene formato YYYY-MM', async () => {
    const rows = [makeHistoricalRow('2026-05')];
    const app  = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/historical?period=month&from=2026-01-01&to=2026-12-31');

    expect(res.status).toBe(200);
    expect(res.body.data.points[0].period_label).toMatch(/^\d{4}-\d{2}$/);
  });

  it('R5 - period=year: period_label tiene formato YYYY', async () => {
    const rows = [makeHistoricalRow('2026')];
    const app  = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/historical?period=year&from=2024-01-01&to=2026-12-31');

    expect(res.status).toBe(200);
    expect(res.body.data.points[0].period_label).toMatch(/^\d{4}$/);
  });

  it('R6 - period=custom: retorna un único punto con period_label "from / to"', async () => {
    const aggRow = makeAggRow();
    const app    = buildApp(jest.fn().mockResolvedValue([[aggRow]]));

    const res = await request(app)
      .get('/api/stats/historical?period=custom&from=2026-05-01&to=2026-05-31');

    expect(res.status).toBe(200);
    expect(res.body.data.points).toHaveLength(1);
    expect(res.body.data.points[0].period_label).toBe('2026-05-01 / 2026-05-31');
  });

  it('R8 - period inválido retorna 400', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/stats/historical?period=invalid&from=2026-05-01&to=2026-05-31');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R9 - from/to ausentes retornan 400', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/stats/historical?period=day');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R9 - from/to con formato inválido retornan 400', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/stats/historical?period=day&from=not-a-date&to=2026-05-31');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R10 - from posterior a to retorna 400', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/stats/historical?period=day&from=2026-06-01&to=2026-05-01');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R11 - rango sin datos retorna 200 con points: []', async () => {
    // GROUP BY queries return empty array; custom returns row with total=0
    const app = buildApp(jest.fn().mockResolvedValue([[]]));

    const res = await request(app)
      .get('/api/stats/historical?period=day&from=2026-05-01&to=2026-05-31');

    expect(res.status).toBe(200);
    expect(res.body.data.points).toEqual([]);
  });

  it('R12 - sin sesión retorna 401', async () => {
    const app = buildApp(jest.fn(), null);

    const res = await request(app)
      .get('/api/stats/historical?period=day&from=2026-05-01&to=2026-05-31');

    expect(res.status).toBe(401);
  });
});

// ── /api/stats/compare ────────────────────────────────────────────────────────

describe('GET /api/stats/compare', () => {

  it('R14 - parámetros válidos retornan 200 con period1, period2, variation', async () => {
    const r1 = makeAggRow({ total: '100', answered: '80', no_answer: '10', busy: '5', failed: '5', avg_duration: '60.00' });
    const r2 = makeAggRow({ total: '120', answered: '90', no_answer: '15', busy: '8', failed: '7', avg_duration: '55.00' });
    const mockQuery = jest.fn()
      .mockResolvedValueOnce([[r1]])
      .mockResolvedValueOnce([[r2]]);
    const app = buildApp(mockQuery);

    const res = await request(app)
      .get('/api/stats/compare?period1_from=2026-04-01&period1_to=2026-04-30&period2_from=2026-05-01&period2_to=2026-05-31');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveProperty('period1');
    expect(res.body.data).toHaveProperty('period2');
    expect(res.body.data).toHaveProperty('variation');
    expect(res.body.data.period1.from).toBe('2026-04-01');
    expect(res.body.data.period1.to).toBe('2026-04-30');
    expect(res.body.data.period2.from).toBe('2026-05-01');
    expect(res.body.data.period2.to).toBe('2026-05-31');
  });

  it('R16 - variation contiene variación porcentual correcta', async () => {
    // p1 total=100, p2 total=120 → variation = ((120-100)/100)*100 = 20.0
    const r1 = makeAggRow({ total: '100', answered: '80', no_answer: '10', busy: '5', failed: '5', avg_duration: '60.00' });
    const r2 = makeAggRow({ total: '120', answered: '80', no_answer: '10', busy: '5', failed: '5', avg_duration: '60.00' });
    const mockQuery = jest.fn()
      .mockResolvedValueOnce([[r1]])
      .mockResolvedValueOnce([[r2]]);
    const app = buildApp(mockQuery);

    const res = await request(app)
      .get('/api/stats/compare?period1_from=2026-04-01&period1_to=2026-04-30&period2_from=2026-05-01&period2_to=2026-05-31');

    expect(res.status).toBe(200);
    expect(res.body.data.variation.total).toBe(20);
  });

  it('R17 - variation es null cuando period1 KPI es 0', async () => {
    const r1 = makeAggRow({ total: '0', answered: '0', no_answer: '0', busy: '0', failed: '0', avg_duration: '0.00' });
    const r2 = makeAggRow({ total: '10', answered: '8', no_answer: '1', busy: '1', failed: '0', avg_duration: '45.00' });
    const mockQuery = jest.fn()
      .mockResolvedValueOnce([[r1]])
      .mockResolvedValueOnce([[r2]]);
    const app = buildApp(mockQuery);

    const res = await request(app)
      .get('/api/stats/compare?period1_from=2026-04-01&period1_to=2026-04-30&period2_from=2026-05-01&period2_to=2026-05-31');

    expect(res.status).toBe(200);
    expect(res.body.data.variation.total).toBeNull();
    expect(res.body.data.variation.answered).toBeNull();
  });

  it('R18 - parámetros de compare inválidos retornan 400', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/stats/compare?period1_from=2026-04-01&period1_to=2026-04-30');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R19 - from > to en compare retorna 400', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/stats/compare?period1_from=2026-04-30&period1_to=2026-04-01&period2_from=2026-05-01&period2_to=2026-05-31');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R12 - sin sesión retorna 401 en compare', async () => {
    const app = buildApp(jest.fn(), null);

    const res = await request(app)
      .get('/api/stats/compare?period1_from=2026-04-01&period1_to=2026-04-30&period2_from=2026-05-01&period2_to=2026-05-31');

    expect(res.status).toBe(401);
  });
});

// ── /api/stats/rankings ───────────────────────────────────────────────────────

describe('GET /api/stats/rankings', () => {

  it('R22 - parámetros válidos retornan 200 con estructura correcta', async () => {
    const rows = [makeRankRow('3001234567'), makeRankRow('3007654321')];
    const app  = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=extension');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({ type: 'extension', from: '2026-05-01', to: '2026-05-31' });
    expect(Array.isArray(res.body.data.rankings)).toBe(true);
  });

  it('R23 - type=extension agrupa por src (name = src)', async () => {
    const rows = [makeRankRow('3001234567')];
    const app  = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=extension');

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('extension');
    expect(res.body.data.rankings[0].name).toBe('3001234567');
  });

  it('R24 - type=trunk agrupa por canal normalizado', async () => {
    const rows = [makeRankRow('SIP/troncal-claro')];
    const app  = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=trunk');

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('trunk');
    expect(res.body.data.rankings[0].name).toBe('SIP/troncal-claro');
  });

  it('R27 - limit fuera de rango retorna 400', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=extension&limit=100');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R27 - limit=0 retorna 400', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=extension&limit=0');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R28 - type inválido retorna 400', async () => {
    const app = buildApp(jest.fn());

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=invalid');

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('R30 - rango sin datos retorna 200 con rankings: []', async () => {
    const app = buildApp(jest.fn().mockResolvedValue([[]]));

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=extension');

    expect(res.status).toBe(200);
    expect(res.body.data.rankings).toEqual([]);
  });

  it('R12 - sin sesión retorna 401 en rankings', async () => {
    const app = buildApp(jest.fn(), null);

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=extension');

    expect(res.status).toBe(401);
  });
});

// ── #42: analytics_agents_ranking_fix ────────────────────────────────────────

describe('#42 — GET /api/stats/rankings?type=extension (solo contestadas, duración en min)', () => {

  it('R1/R2 — type=extension: total === answered en cada agente del resultado', async () => {
    // Simula que el backend ya solo devuelve filas contestadas (total = answered)
    const rows = [
      makeRankRow('1001', { total: '5', answered: '5', no_answer: '0', avg_duration: '3.2' }),
      makeRankRow('1002', { total: '3', answered: '3', no_answer: '0', avg_duration: '2.0' }),
    ];
    const app = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=extension');

    expect(res.status).toBe(200);
    for (const r of res.body.data.rankings) {
      expect(r.total).toBe(r.answered);
    }
  });

  it('R3 — avg_duration viene en minutos (1 decimal, valor numérico)', async () => {
    // billsec=210 → AVG/60 = 3.5 min
    const rows = [makeRankRow('1001', { avg_duration: '3.5' })];
    const app = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=extension');

    expect(res.status).toBe(200);
    const agent = res.body.data.rankings[0];
    // valor numérico, 1 decimal
    expect(typeof agent.avg_duration).toBe('number');
    expect(agent.avg_duration).toBe(3.5);
    // debe ser razonable como minutos (mucho menor que el equivalente en segundos)
    expect(agent.avg_duration).toBeLessThan(60);
  });

  it('RCL1 — agente con 0 contestadas no aparece en el ranking', async () => {
    // La query SQL ya filtra, así que el mock devuelve un array vacío
    const rows = [];
    const app = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=extension');

    expect(res.status).toBe(200);
    expect(res.body.data.rankings).toEqual([]);
  });

  it('RCL2 — sin llamadas contestadas en el rango, rankings es []', async () => {
    const app = buildApp(jest.fn().mockResolvedValue([[]]));

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=extension');

    expect(res.status).toBe(200);
    expect(res.body.data.rankings).toEqual([]);
  });

  it('RCL3 — type=trunk no se ve afectado por el cambio (sigue igual)', async () => {
    // El trunk devuelve su avg_duration sin cambios
    const rows = [makeRankRow('SIP/trunkal', { total: '10', answered: '7', avg_duration: '45.00' })];
    const app = buildApp(jest.fn().mockResolvedValue([rows]));

    const res = await request(app)
      .get('/api/stats/rankings?from=2026-05-01&to=2026-05-31&type=trunk');

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('trunk');
    // El trunk puede tener total != answered (no se filtra)
    const trunk = res.body.data.rankings[0];
    expect(trunk.name).toBe('SIP/trunkal');
    expect(typeof trunk.avg_duration).toBe('number');
  });
});

// ── custom period with zero data ──────────────────────────────────────────────

describe('GET /api/stats/historical (custom, no data)', () => {

  it('R11 - custom period sin datos retorna 200 con points: []', async () => {
    const aggRow = makeAggRow({ total: '0', answered: '0', no_answer: '0', busy: '0', failed: '0', avg_duration: null });
    const app    = buildApp(jest.fn().mockResolvedValue([[aggRow]]));

    const res = await request(app)
      .get('/api/stats/historical?period=custom&from=2026-05-01&to=2026-05-31');

    expect(res.status).toBe(200);
    expect(res.body.data.points).toEqual([]);
  });
});
