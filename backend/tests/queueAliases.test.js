'use strict';

/**
 * queueAliases.test.js — feature #59 (queue_aliases_and_historical) tests
 *
 * Uses Jest + Supertest with an in-memory SQLite DB and a mocked MySQL pool
 * (no Issabel DB required).
 *
 * NOTE (repo convention, see dashboard_lost_destinations.test.js / config.test.js):
 * backend/server.js is a self-executing script that is not safely importable in
 * tests. This file defines a LOCAL MIRROR of `extractChannel`, `passesFilter`,
 * `resolveDisposition`, the modified `queryQueues` (now receiving `queueAliases`)
 * and the two new `/api/admin/queues` endpoints, kept logic-identical to
 * server.js. The persistence helpers (`getQueueAliases`/`setQueueAlias`) are the
 * REAL implementations imported from services/configService.js.
 */

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');

const configService = require('../services/configService');

// ── Local mirror of server.js helpers ──────────────────────────────────────

/** Mirrors extractChannel from server.js */
function extractChannel(raw) {
  if (!raw) return 'Desconocido';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

/** Mirrors passesFilter from server.js */
function passesFilter(channel, inboundChannels, outboundChannels, direction) {
  const ch = extractChannel(channel);

  if (direction === 'out') {
    if (ch.startsWith('Local/')) return false;
    return outboundChannels.includes(ch);
  }
  if (direction === 'in') {
    return inboundChannels.includes(ch);
  }
  if (ch.startsWith('Local/')) return false;
  if (inboundChannels.length > 0 || outboundChannels.length > 0) {
    return inboundChannels.includes(ch) || outboundChannels.includes(ch);
  }
  return true;
}

/** Mirrors AGENT_DSTCHANNEL_RE from server.js (#56) */
const AGENT_DSTCHANNEL_RE = /^(Agent\/\d+|SIP\/\d+-|PJSIP\/\d+-|Local\/\d+@)/;

/** Mirrors resolveDisposition from server.js */
function resolveDisposition(row, lostDests) {
  const d = row.disposition.toUpperCase();
  let targetKey = ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED'].includes(d) ? d : null;
  if (!targetKey) return null;

  if (targetKey === 'BUSY') targetKey = 'NO ANSWER';

  const isLostDst = lostDests.includes(row.dst);
  if (isLostDst && targetKey !== 'NO ANSWER') {
    targetKey = 'NO ANSWER';
  }

  if (targetKey === 'ANSWERED' && !AGENT_DSTCHANNEL_RE.test(row.dstchannel || '')) {
    targetKey = 'NO ANSWER';
  }

  return targetKey;
}

/** Mirrors the modified queryQueues from server.js (#59: queueAliases arg) */
async function queryQueues(pool, from, to, inboundChannels, outboundChannels, queues, lostDests, queueAliases = {}) {
  if (!queues || queues.length === 0) return [];

  const [rows] = await pool.query(
    `SELECT channel, dst, dstchannel, disposition, COUNT(*) AS count
     FROM cdr
     WHERE calldate >= ? AND calldate < ?
     GROUP BY channel, dst, dstchannel, disposition`,
    [from, to]
  );

  const validDsts = new Set([...queues, ...lostDests]);
  const result = {};
  for (const q of queues) {
    result[q] = { queue: q, label: queueAliases[q] || `Cola ${q}`, total: 0, ANSWERED: 0, 'NO ANSWER': 0, FAILED: 0 };
  }
  result['__lost__'] = { queue: '__lost__', label: 'Perdidas', total: 0, ANSWERED: 0, 'NO ANSWER': 0, FAILED: 0 };

  for (const r of rows) {
    if (!passesFilter(r.channel, inboundChannels, outboundChannels, 'in')) continue;
    if (!validDsts.has(r.dst)) continue;
    if (r.disposition.toUpperCase() === 'BUSY') continue;
    const key = queues.includes(r.dst) ? r.dst : '__lost__';

    const targetKey = resolveDisposition(r, lostDests);
    if (targetKey) {
      result[key][targetKey] += Number(r.count);
    }
    result[key].total += Number(r.count);
  }

  return Object.values(result);
}

// ── Test helpers ────────────────────────────────────────────────────────────

/** Fresh in-memory SQLite with the system_config key-value table (mirrors db/setup.js). */
function buildSqliteDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  return db;
}

/** Mock pool.query that resolves with the given rows for any query */
function mockPool(rows) {
  return { query: jest.fn().mockResolvedValue([rows]) };
}

/** Sample CDR aggregate row (as returned by the GROUP BY query) */
function makeRow(overrides = {}) {
  return {
    channel:     'SIP/trunk-1',
    dst:         '8000',
    dstchannel:  'Local/101@from-queue-0001',
    disposition: 'ANSWERED',
    count:       1,
    ...overrides,
  };
}

const FROM = '2026-06-10 00:00:00';
const TO   = '2026-06-11 00:00:00';
const INBOUND  = ['SIP/trunk'];
const OUTBOUND = [];
const QUEUES   = ['8000', '8001'];
const LOST     = ['s', 'hang', 'hangup'];

const ADMIN    = { id: 1, username: 'admin',   role: 'admin' };
const OPERADOR = { id: 2, username: 'operador', role: 'operador' };

/**
 * Build a test Express app mirroring server.js's GET/PUT /api/admin/queues,
 * using the REAL configService for persistence.
 */
function buildApp({ db, sessionUser, queues = QUEUES } = {}) {
  const database = db ?? buildSqliteDb();

  const app = express();
  app.use(express.json());
  app.use(session({
    secret:            'test-secret',
    resave:            false,
    saveUninitialized: false,
    cookie:            { httpOnly: true, sameSite: 'lax' },
  }));

  if (sessionUser) {
    app.use((req, _res, next) => { req.session.user = sessionUser; next(); });
  }

  function requireAdmin(req, res, next) {
    if (!req.session?.user)                return res.status(401).json({ ok: false, error: 'No autenticado' });
    if (req.session.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Se requiere rol de administrador' });
    next();
  }

  const configQueues = queues;

  // ── Mirror of server.js GET/PUT /api/admin/queues ──
  app.get('/api/admin/queues', requireAdmin, (req, res) => {
    const aliases = configService.getQueueAliases(database);
    const list = configQueues.map(q => ({ queue: q, alias: aliases[q] || '' }));
    res.json({ ok: true, queues: list });
  });

  app.put('/api/admin/queues', requireAdmin, (req, res) => {
    const { queue, alias } = req.body || {};
    if (typeof queue !== 'string' || !queue.trim())
      return res.status(400).json({ ok: false, error: 'El campo queue es requerido' });
    if (typeof alias !== 'string')
      return res.status(400).json({ ok: false, error: 'El campo alias es requerido' });
    if (!configQueues.includes(queue))
      return res.status(404).json({ ok: false, error: 'Cola no encontrada' });

    configService.setQueueAlias(database, queue, alias);
    res.json({ ok: true, queue, alias: alias.trim() });
  });

  // ── Mirror of server.js /api/calls/today and /api/calls/range (queues only) ──
  // Minimal replica for R14: proves the alias reaches queue.label in the payload
  // while preserving the queue-entry schema.
  const pool = mockPool([
    makeRow({ dst: '8000', disposition: 'ANSWERED' }),
    makeRow({ dst: '8001', disposition: 'NO ANSWER', dstchannel: '' }),
  ]);

  app.get('/api/calls/today', requireAdmin, async (req, res) => {
    const queuesData = await queryQueues(
      pool, FROM, TO, INBOUND, OUTBOUND, configQueues, LOST,
      configService.getQueueAliases(database)
    );
    res.json({ ok: true, queues: queuesData });
  });

  app.get('/api/calls/range', requireAdmin, async (req, res) => {
    const queuesData = await queryQueues(
      pool, FROM, TO, INBOUND, OUTBOUND, configQueues, LOST,
      configService.getQueueAliases(database)
    );
    res.json({ ok: true, queues: queuesData });
  });

  return { app, db: database };
}

// ── T7 / R11-R12 — queryQueues labels ────────────────────────────────────────

describe('R11/R12 - queryQueues aplica alias o el default "Cola <n>"', () => {
  it('R11 - usa el alias configurado como label cuando existe', async () => {
    const pool = mockPool([makeRow({ dst: '8000' })]);
    const result = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST, { '8000': 'Ventas' });

    const q8000 = result.find(q => q.queue === '8000');
    expect(q8000.label).toBe('Ventas');
  });

  it('R12 - usa el default "Cola <n>" cuando no hay alias configurado', async () => {
    const pool = mockPool([makeRow({ dst: '8001' })]);
    const result = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST, {});

    const q8001 = result.find(q => q.queue === '8001');
    expect(q8001.label).toBe('Cola 8001');
  });

  it('R11/R12 - alias parcial: una cola con alias y otra con default', async () => {
    const pool = mockPool([makeRow({ dst: '8000' })]);
    const result = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST, { '8000': 'Soporte' });

    expect(result.find(q => q.queue === '8000').label).toBe('Soporte');
    expect(result.find(q => q.queue === '8001').label).toBe('Cola 8001');
  });
});

// ── T8 / R13 — __lost__ ──────────────────────────────────────────────────────

describe('R13 - la entrada __lost__ conserva label "Perdidas" y no es aliasable', () => {
  it('R13 - __lost__ siempre es "Perdidas" aunque se pase un alias con esa clave', async () => {
    const pool = mockPool([makeRow({ dst: '8000' })]);
    const result = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST, { __lost__: 'No debería aplicarse' });

    const lost = result.find(q => q.queue === '__lost__');
    expect(lost.label).toBe('Perdidas');
  });
});

// ── T9 / R8 — GET /api/admin/queues ──────────────────────────────────────────

describe('R8 - GET /api/admin/queues lista todas las colas con su alias', () => {
  it('R8 - devuelve cada cola configurada con alias (o cadena vacía)', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });
    configService.setQueueAlias(db, '8000', 'Ventas');

    const res = await request(app).get('/api/admin/queues').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.queues).toEqual([
      { queue: '8000', alias: 'Ventas' },
      { queue: '8001', alias: '' },
    ]);
  });
});

// ── T10 / R9-R10 — PUT /api/admin/queues ─────────────────────────────────────

describe('R9/R10 - PUT /api/admin/queues guarda y elimina alias', () => {
  it('R9 - guarda un alias y devuelve el valor guardado', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const res = await request(app).put('/api/admin/queues').send({ queue: '8000', alias: 'Ventas' }).expect(200);
    expect(res.body).toEqual({ ok: true, queue: '8000', alias: 'Ventas' });
    expect(configService.getQueueAliases(db)['8000']).toBe('Ventas');
  });

  it('R9 - recorta espacios del alias antes de persistir', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });

    const res = await request(app).put('/api/admin/queues').send({ queue: '8000', alias: '  Soporte  ' }).expect(200);
    expect(res.body.alias).toBe('Soporte');
    expect(configService.getQueueAliases(db)['8000']).toBe('Soporte');
  });

  it('R10 - alias en blanco elimina el alias (restaura el default)', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });
    configService.setQueueAlias(db, '8000', 'Ventas');

    await request(app).put('/api/admin/queues').send({ queue: '8000', alias: '   ' }).expect(200);
    expect(configService.getQueueAliases(db)['8000']).toBeUndefined();
  });
});

// ── T11 / R7 — persistencia tras reinstanciar el store ───────────────────────

describe('R7 - el alias persiste tras reinstanciar el store (relectura SQLite)', () => {
  it('R7 - un alias guardado se lee de nuevo con otra instancia de acceso al mismo db', () => {
    const db = buildSqliteDb();
    configService.setQueueAlias(db, '8000', 'Ventas');

    // Simula un "reinicio": nueva lectura desde SQLite (misma DB, sin caché en memoria).
    const reread = configService.getQueueAliases(db);
    expect(reread['8000']).toBe('Ventas');
  });

  it('R7 - persiste a través de un archivo SQLite físico reabierto', () => {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const file = path.join(os.tmpdir(), `queue-aliases-test-${process.pid}-${Date.now()}.sqlite`);

    const db1 = new Database(file);
    db1.exec('CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT)');
    configService.setQueueAlias(db1, '8001', 'Cobranza');
    db1.close();

    const db2 = new Database(file);
    const aliases = configService.getQueueAliases(db2);
    expect(aliases['8001']).toBe('Cobranza');
    db2.close();
    fs.unlinkSync(file);
  });
});

// ── T12 / R16-R17 — auth ─────────────────────────────────────────────────────

describe('R16/R17 - /api/admin/queues requiere admin', () => {
  it('R16 - GET sin sesión devuelve 401', async () => {
    const { app } = buildApp({ sessionUser: null });
    await request(app).get('/api/admin/queues').expect(401);
  });

  it('R16 - PUT sin sesión devuelve 401', async () => {
    const { app } = buildApp({ sessionUser: null });
    await request(app).put('/api/admin/queues').send({ queue: '8000', alias: 'X' }).expect(401);
  });

  it('R17 - GET con rol no-admin devuelve 403', async () => {
    const { app } = buildApp({ sessionUser: OPERADOR });
    await request(app).get('/api/admin/queues').expect(403);
  });

  it('R17 - PUT con rol no-admin devuelve 403', async () => {
    const { app } = buildApp({ sessionUser: OPERADOR });
    await request(app).put('/api/admin/queues').send({ queue: '8000', alias: 'X' }).expect(403);
  });
});

// ── T13 / R18-R20 — validaciones PUT ─────────────────────────────────────────

describe('R18/R19/R20 - validaciones de PUT /api/admin/queues', () => {
  it('R18 - sin campo queue devuelve 400 y no persiste', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });
    const res = await request(app).put('/api/admin/queues').send({ alias: 'X' });
    expect(res.status).toBe(400);
    expect(Object.keys(configService.getQueueAliases(db))).toHaveLength(0);
  });

  it('R18 - queue en blanco devuelve 400 y no persiste', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });
    const res = await request(app).put('/api/admin/queues').send({ queue: '   ', alias: 'X' });
    expect(res.status).toBe(400);
    expect(Object.keys(configService.getQueueAliases(db))).toHaveLength(0);
  });

  it('R19 - alias no string devuelve 400 y no persiste', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });
    const res = await request(app).put('/api/admin/queues').send({ queue: '8000', alias: 123 });
    expect(res.status).toBe(400);
    expect(Object.keys(configService.getQueueAliases(db))).toHaveLength(0);
  });

  it('R20 - cola inexistente devuelve 404 y no persiste', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });
    const res = await request(app).put('/api/admin/queues').send({ queue: '9999', alias: 'X' });
    expect(res.status).toBe(404);
    expect(Object.keys(configService.getQueueAliases(db))).toHaveLength(0);
  });
});

// ── T14 / R14 — payload de /api/calls/today y /api/calls/range ────────────────

describe('R14 - el alias se refleja en queue.label en today/range sin cambiar la forma', () => {
  it('R14 - /api/calls/today refleja el alias y conserva el esquema de la entrada de cola', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });
    configService.setQueueAlias(db, '8000', 'Ventas');

    const res = await request(app).get('/api/calls/today').expect(200);
    const q8000 = res.body.queues.find(q => q.queue === '8000');
    expect(q8000.label).toBe('Ventas');
    // Forma del esquema por entrada, sin cambios.
    expect(Object.keys(q8000).sort()).toEqual(
      ['ANSWERED', 'FAILED', 'NO ANSWER', 'label', 'queue', 'total'].sort()
    );
    // Cola sin alias conserva el default.
    expect(res.body.queues.find(q => q.queue === '8001').label).toBe('Cola 8001');
    // __lost__ intacto.
    expect(res.body.queues.find(q => q.queue === '__lost__').label).toBe('Perdidas');
  });

  it('R14 - /api/calls/range refleja el alias en queue.label', async () => {
    const { app, db } = buildApp({ sessionUser: ADMIN });
    configService.setQueueAlias(db, '8001', 'Soporte');

    const res = await request(app).get('/api/calls/range').expect(200);
    expect(res.body.queues.find(q => q.queue === '8001').label).toBe('Soporte');
  });
});
