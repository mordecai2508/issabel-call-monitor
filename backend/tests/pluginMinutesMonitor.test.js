'use strict';

/**
 * pluginMinutesMonitor.test.js — plugin minutes-monitor (feature #55) tests
 * Jest + Supertest con SQLite en memoria, pool MySQL mockeado (nunca BD real)
 * y pluginManagerService REAL con el registro apuntando al plugin real.
 */

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');

const createPluginManagerService = require('../services/pluginManagerService');
const minutesPlugin = require('../plugins/minutes-monitor');
const { monthRange, queryMonth, buildExtensionsSql, SQL_TOTAL, SQL_TRONCALES } = require('../plugins/minutes-monitor/minutesQuery');
const { enrich } = require('../plugins/minutes-monitor/minutesEnrich');
const { CONFIG_KEY, DEFAULT_CONFIG, loadConfig, validateConfig } = require('../plugins/minutes-monitor/minutesConfig');
const { setConfigValue, getConfigValue } = require('../services/configService');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** SQLite en memoria con las tablas `plugins` y `system_config` (db/setup.js). */
function buildSqliteDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
      name       TEXT    PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS system_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

/**
 * Pool MySQL mockeado que enruta por el SQL recibido. `data` es mutable
 * para simular cambios/fallos de la BD entre mediciones.
 */
function mockPool(data = {}) {
  const state = {
    total:      data.total      ?? { minutos: 0, llamadas: 0 },
    troncales:  data.troncales  ?? [],
    extensiones: data.extensiones ?? [],
    reject:     data.reject     ?? false,
  };
  const pool = {
    state,
    query: jest.fn(async (sql) => {
      if (state.reject) throw new Error('mysql caído');
      if (sql.includes('SUBSTRING_INDEX')) return [state.troncales.map(t => ({ ...t })), []];
      if (sql.includes('src IN'))          return [state.extensiones.map(e => ({ ...e })), []];
      return [[{ ...state.total }], []];
    }),
  };
  return pool;
}

const BASE_CONFIG = {
  server: { sessionSecret: 'test-secret', pollIntervalMs: 30000 },
  db: { timezone: '-05:00' },
};

function makeCtx({ pool, db, broadcast } = {}) {
  return {
    pool:      pool ?? mockPool(),
    db:        db ?? buildSqliteDb(),
    config:    JSON.parse(JSON.stringify(BASE_CONFIG)),
    broadcast: broadcast ?? jest.fn(),
    logger:    { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

/** App de test con el pluginManagerService REAL y el plugin real (patrón buildApp). */
async function buildApp({ sessionUser, pool, db, coreBroadcast } = {}) {
  const sqlite = db ?? buildSqliteDb();
  const mysqlPool = pool ?? mockPool();
  const broadcastSpy = coreBroadcast ?? jest.fn();

  const manager = createPluginManagerService(
    [{ name: 'minutes-monitor', load: () => minutesPlugin }],
    { pool: mysqlPool, db: sqlite, config: JSON.parse(JSON.stringify(BASE_CONFIG)), broadcast: broadcastSpy }
  );
  await manager.init();

  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }));

  if (sessionUser !== undefined && sessionUser !== null) {
    app.use((req, _res, next) => {
      req.session.user = sessionUser;
      next();
    });
  }

  function requireAuth(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ ok: false, error: 'No autenticado' });
    next();
  }

  app.use('/api/plugins', manager.buildRouter(requireAuth));

  return { app, db: sqlite, pool: mysqlPool, manager, broadcastSpy };
}

/** Drena la medición inmediata asíncrona lanzada por startJobs/PUT. */
async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

const ADMIN    = { id: 1, username: 'admin', role: 'admin' };
const OPERADOR = { id: 2, username: 'operador', role: 'operador' };

const VALID_CONFIG = {
  umbralMinutos: 1000,
  alertaTempranaP: 80,
  alertaCriticaP: 90,
  costoMinutoExtra: 50,
  moneda: 'COP',
  extensiones: [{ numero: '1001', nombre: 'Ventas', umbral: 200 }],
  umbralSoloExtensiones: false,
  intervaloMinutos: 30,
};

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ── T7 — Unit: minutesQuery ──────────────────────────────────────────────────

describe('minutesQuery — monthRange', () => {
  // 2026-08-01 02:00:00 UTC: en -05:00 todavía es 31 de julio.
  const NOW = Date.UTC(2026, 7, 1, 2, 0, 0);

  it('R3 - delimita el mes en curso con la tz de la BD (-05:00: sigue siendo julio)', () => {
    const r = monthRange('-05:00', NOW);
    expect(r).toEqual({ from: '2026-07-01 00:00:00', to: '2026-08-01 00:00:00', mes: '2026-07' });
  });

  it('R3 - con +00:00 el mismo instante ya es agosto y `to` es el inicio del día siguiente (exclusivo)', () => {
    const r = monthRange('+00:00', NOW);
    expect(r).toEqual({ from: '2026-08-01 00:00:00', to: '2026-08-02 00:00:00', mes: '2026-08' });
  });

  it('R3 - timezone inválida cae a offset 0 sin lanzar', () => {
    const r = monthRange(undefined, NOW);
    expect(r.mes).toBe('2026-08');
  });
});

describe('minutesQuery — queryMonth', () => {
  const RANGE = { from: '2026-07-01 00:00:00', to: '2026-07-03 00:00:00', mes: '2026-07' };

  it('R6 - todas las SELECT usan calldate >= ? AND calldate < ? sin funciones sobre la columna', () => {
    for (const sql of [SQL_TOTAL, SQL_TRONCALES, buildExtensionsSql(2)]) {
      expect(sql).toMatch(/calldate >= \? AND calldate < \?/);
      expect(sql).not.toMatch(/YEAR\s*\(/i);
      expect(sql).not.toMatch(/MONTH\s*\(/i);
      expect(sql).not.toMatch(/DATE\s*\(\s*calldate/i);
    }
  });

  it('R5 - genera un placeholder por extensión y pasa [from, to, ...numeros]', async () => {
    const pool = mockPool({ extensiones: [{ extension: '1001', minutos: 10, llamadas: 2 }] });
    await queryMonth(pool, RANGE, [{ numero: '1001' }, { numero: '1002' }]);

    const extCall = pool.query.mock.calls.find(([sql]) => sql.includes('src IN'));
    expect(extCall).toBeDefined();
    expect(extCall[0]).toMatch(/src IN \(\?,\?\)/);
    expect(extCall[1]).toEqual([RANGE.from, RANGE.to, '1001', '1002']);
  });

  it('R5 - sin extensiones configuradas NO ejecuta la query por extensión y devuelve array vacío', async () => {
    const pool = mockPool();
    const raw = await queryMonth(pool, RANGE, []);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('src IN'))).toBe(false);
    expect(raw.extensionesRaw).toEqual([]);
  });

  it('R2/R8 - devuelve total/troncales del mes y ejecuta únicamente SELECT (cero escrituras)', async () => {
    const pool = mockPool({
      total: { minutos: 123.45, llamadas: 10 },
      troncales: [{ troncal: 'SIP/trunk1', minutos: 100, llamadas: 8 }],
    });
    const raw = await queryMonth(pool, RANGE, []);

    expect(raw.mes).toBe('2026-07');
    expect(raw.total).toEqual({ minutos: 123.45, llamadas: 10 });
    expect(raw.troncales).toEqual([{ troncal: 'SIP/trunk1', minutos: 100, llamadas: 8 }]);

    for (const [sql] of pool.query.mock.calls) {
      expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
      expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|DROP|ALTER/i);
    }
  });
});

// ── T8 — Unit: minutesEnrich ─────────────────────────────────────────────────

describe('minutesEnrich — enrich', () => {
  const CFG = {
    umbralMinutos: 1000,
    alertaTempranaP: 85,
    alertaCriticaP: 95,
    costoMinutoExtra: 100,
    moneda: 'COP',
    extensiones: [],
    umbralSoloExtensiones: false,
    intervaloMinutos: 60,
  };

  function rawWith(minutos, llamadas = 10, extras = {}) {
    return {
      timestamp: '2026-07-02T15:00:00.000Z',
      mes: '2026-07',
      total: { minutos, llamadas },
      troncales: [],
      extensionesRaw: [],
      ...extras,
    };
  }

  it('R10 - consumo igual o mayor al umbral reporta 🔴 UMBRAL SUPERADO con nivel CRITICO (borde ==)', () => {
    expect(enrich(rawWith(1000), CFG)).toMatchObject({ nivelAlerta: 'CRITICO', estadoAlerta: '🔴 UMBRAL SUPERADO' });
    expect(enrich(rawWith(1500), CFG)).toMatchObject({ nivelAlerta: 'CRITICO', estadoAlerta: '🔴 UMBRAL SUPERADO' });
  });

  it('R11 - consumo en [umbral*criticaP%, umbral) reporta 🟠 ALERTA CRÍTICA con nivel CRITICO (borde ==)', () => {
    expect(enrich(rawWith(950), CFG)).toMatchObject({ nivelAlerta: 'CRITICO', estadoAlerta: '🟠 ALERTA CRÍTICA' });
    expect(enrich(rawWith(999.99), CFG)).toMatchObject({ estadoAlerta: '🟠 ALERTA CRÍTICA' });
  });

  it('R12 - consumo en [umbral*tempranaP%, corte crítico) reporta 🟡 ALERTA TEMPRANA con nivel ADVERTENCIA (borde ==)', () => {
    expect(enrich(rawWith(850), CFG)).toMatchObject({ nivelAlerta: 'ADVERTENCIA', estadoAlerta: '🟡 ALERTA TEMPRANA' });
    expect(enrich(rawWith(949.99), CFG)).toMatchObject({ estadoAlerta: '🟡 ALERTA TEMPRANA' });
  });

  it('R13 - consumo bajo el corte temprano reporta 🟢 NORMAL con nivel OK', () => {
    expect(enrich(rawWith(849.99), CFG)).toMatchObject({ nivelAlerta: 'OK', estadoAlerta: '🟢 NORMAL' });
    expect(enrich(rawWith(0, 0), CFG)).toMatchObject({ nivelAlerta: 'OK' });
  });

  it('R9 - calcula porcentaje, restantes/excedente nunca negativos, costo y promedio por llamada', () => {
    const bajo = enrich(rawWith(500, 4), CFG);
    expect(bajo.porcentajeUso).toBe(50);
    expect(bajo.minutosRestantes).toBe(500);
    expect(bajo.excedente).toBe(0);
    expect(bajo.costoExcedente).toBe(0);
    expect(bajo.promMinPorLlamada).toBe(125);
    expect(bajo.moneda).toBe('COP');

    const alto = enrich(rawWith(1200, 8), CFG);
    expect(alto.minutosRestantes).toBe(0);      // nunca negativo
    expect(alto.excedente).toBe(200);           // nunca negativo
    expect(alto.costoExcedente).toBe(20000);    // 200 × 100
    expect(alto.porcentajeUso).toBe(120);

    const sinLlamadas = enrich(rawWith(0, 0), CFG);
    expect(sinLlamadas.promMinPorLlamada).toBe(0);
  });

  it('R14 - umbralSoloExtensiones usa la suma de extensiones como base de comparación', () => {
    const cfg = {
      ...CFG,
      umbralSoloExtensiones: true,
      extensiones: [
        { numero: '1001', nombre: 'A', umbral: null },
        { numero: '1002', nombre: 'B', umbral: null },
      ],
    };
    const raw = rawWith(5000, 100, {
      extensionesRaw: [
        { extension: '1001', minutos: 600, llamadas: 5 },
        { extension: '1002', minutos: 300, llamadas: 3 },
      ],
    });
    const estado = enrich(raw, cfg);
    expect(estado.baseComparacion).toBe(900);       // 600 + 300, no 5000
    expect(estado.baseEsExtensiones).toBe(true);
    expect(estado.minutosConsumidos).toBe(5000);    // el total general se conserva
    expect(estado.estadoAlerta).toBe('🟡 ALERTA TEMPRANA'); // 900/1000 = 90 % → entre 85 y 95
  });

  it('R15 - usa el umbral propio de la extensión si existe, o el global en caso contrario', () => {
    const cfg = {
      ...CFG,
      extensiones: [
        { numero: '1001', nombre: 'Propio', umbral: 100 },
        { numero: '1002', nombre: 'Global', umbral: null },
      ],
    };
    const raw = rawWith(500, 10, {
      extensionesRaw: [
        { extension: '1001', minutos: 50, llamadas: 2 },
        { extension: '1002', minutos: 50, llamadas: 2 },
      ],
    });
    const [propio, global] = enrich(raw, cfg).extensiones;
    expect(propio).toMatchObject({ umbral: 100, esUmbralPropio: true, porcentaje: 50 });
    expect(global).toMatchObject({ umbral: 1000, esUmbralPropio: false, porcentaje: 5 });
  });

  it('R16 - asigna OK/ADVERTENCIA/CRITICO/SUPERADO por extensión con los mismos cortes', () => {
    const cfg = {
      ...CFG,
      extensiones: [
        { numero: '1', nombre: '', umbral: 100 },
        { numero: '2', nombre: '', umbral: 100 },
        { numero: '3', nombre: '', umbral: 100 },
        { numero: '4', nombre: '', umbral: 100 },
      ],
    };
    const raw = rawWith(1, 1, {
      extensionesRaw: [
        { extension: '1', minutos: 84,  llamadas: 1 },
        { extension: '2', minutos: 85,  llamadas: 1 },
        { extension: '3', minutos: 95,  llamadas: 1 },
        { extension: '4', minutos: 100, llamadas: 1 },
      ],
    });
    const estados = enrich(raw, cfg).extensiones.map(e => e.estado);
    expect(estados).toEqual(['OK', 'ADVERTENCIA', 'CRITICO', 'SUPERADO']);
  });

  it('R17 - extensión monitoreada sin llamadas en el mes aparece con consumo 0 y estado OK', () => {
    const cfg = { ...CFG, extensiones: [{ numero: '1099', nombre: 'Sin uso', umbral: null }] };
    const [ext] = enrich(rawWith(100, 5), cfg).extensiones;
    expect(ext).toMatchObject({
      numero: '1099', minutos: 0, llamadas: 0, estado: 'OK', porcentaje: 0, excedente: 0, promMinPorLlamada: 0,
    });
  });

  it('R18 - aplica el alias de la troncal cuando existe y null en caso contrario', () => {
    const raw = rawWith(100, 5, {
      troncales: [
        { troncal: 'SIP/trunk1', minutos: 60, llamadas: 3 },
        { troncal: 'SIP/trunk2', minutos: 40, llamadas: 2 },
      ],
    });
    const { troncales } = enrich(raw, CFG, { 'SIP/trunk1': 'Claro' });
    expect(troncales[0]).toMatchObject({ troncal: 'SIP/trunk1', alias: 'Claro', promMinPorLlamada: 20 });
    expect(troncales[1]).toMatchObject({ troncal: 'SIP/trunk2', alias: null });
  });
});

// ── T9 — Unit: minutesConfig ─────────────────────────────────────────────────

describe('minutesConfig — loadConfig', () => {
  it('R26 - sin fila persistida devuelve los defaults exactos', () => {
    const db = buildSqliteDb();
    expect(loadConfig(db)).toEqual({
      umbralMinutos: 70000,
      alertaTempranaP: 85,
      alertaCriticaP: 95,
      costoMinutoExtra: 0,
      moneda: 'COP',
      extensiones: [],
      umbralSoloExtensiones: false,
      intervaloMinutos: 60,
    });
  });

  it('R26 - JSON corrupto devuelve defaults con warn (nunca lanza)', () => {
    const db = buildSqliteDb();
    setConfigValue(db, CONFIG_KEY, '{no es json');
    const logger = { warn: jest.fn() };
    expect(loadConfig(db, logger)).toEqual(loadConfig(buildSqliteDb()));
    expect(logger.warn).toHaveBeenCalled();
  });

  it('R26 - mergea la config persistida sobre defaults y descarta campos desconocidos', () => {
    const db = buildSqliteDb();
    setConfigValue(db, CONFIG_KEY, JSON.stringify({ umbralMinutos: 500, hacker: true }));
    const cfg = loadConfig(db);
    expect(cfg.umbralMinutos).toBe(500);
    expect(cfg.moneda).toBe('COP');
    expect(cfg).not.toHaveProperty('hacker');
  });
});

describe('minutesConfig — validateConfig (R27)', () => {
  function expect400(overrides) {
    expect(() => validateConfig({ ...VALID_CONFIG, ...overrides }))
      .toThrow(expect.objectContaining({ status: 400 }));
  }

  it('R27 - config válida se normaliza sin lanzar', () => {
    const cfg = validateConfig({ ...VALID_CONFIG, moneda: '  USD ' });
    expect(cfg.moneda).toBe('USD');
    expect(cfg.extensiones).toEqual([{ numero: '1001', nombre: 'Ventas', umbral: 200 }]);
  });

  it('R27 - umbral no numérico o <= 0 → 400', () => {
    expect400({ umbralMinutos: 'mil' });
    expect400({ umbralMinutos: 0 });
    expect400({ umbralMinutos: -5 });
  });

  it('R27 - porcentajes fuera de 0-100 → 400', () => {
    expect400({ alertaTempranaP: -1 });
    expect400({ alertaCriticaP: 101 });
    expect400({ alertaTempranaP: NaN });
  });

  it('R27 - alerta temprana >= alerta crítica → 400', () => {
    expect400({ alertaTempranaP: 90, alertaCriticaP: 90 });
    expect400({ alertaTempranaP: 95, alertaCriticaP: 90 });
  });

  it('R27 - costo negativo o no numérico → 400', () => {
    expect400({ costoMinutoExtra: -1 });
    expect400({ costoMinutoExtra: 'gratis' });
  });

  it('R27 - moneda vacía o demasiado larga → 400', () => {
    expect400({ moneda: '' });
    expect400({ moneda: '   ' });
    expect400({ moneda: 'PESOSCOLOMBIANOS' });
  });

  it('R27 - extensión con número no numérico o duplicado → 400', () => {
    expect400({ extensiones: [{ numero: 'abc' }] });
    expect400({ extensiones: [{ numero: 1001 }] });
    expect400({ extensiones: [{ numero: '1001' }, { numero: '1001' }] });
    expect400({ extensiones: 'no-array' });
  });

  it('R27 - umbral de extensión no numérico o <= 0 cuando se define → 400 (null es válido)', () => {
    expect400({ extensiones: [{ numero: '1001', umbral: 0 }] });
    expect400({ extensiones: [{ numero: '1001', umbral: 'alto' }] });
    expect(() => validateConfig({ ...VALID_CONFIG, extensiones: [{ numero: '1001', umbral: null }] })).not.toThrow();
  });

  it('R27 - intervalo < 1 minuto o no entero → 400', () => {
    expect400({ intervaloMinutos: 0 });
    expect400({ intervaloMinutos: 0.5 });
    expect400({ intervaloMinutos: '60' });
  });

  it('R27 - umbralSoloExtensiones no booleano estricto → 400', () => {
    expect400({ umbralSoloExtensiones: 'true' });
    expect400({ umbralSoloExtensiones: 1 });
  });
});

// ── T10 — HTTP (Supertest, manager real + plugin real) ───────────────────────

describe('GET /api/plugins/minutes-monitor/status', () => {
  it('R23 - sin mediciones responde 200 con hasData:false e historial vacío', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // Pool que rechaza: la medición inmediata falla y no hay estado.
    const { app, manager } = await buildApp({ sessionUser: OPERADOR, pool: mockPool({ reject: true }) });
    await flush();

    const res = await request(app).get('/api/plugins/minutes-monitor/status').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ hasData: false, estado: null, historial: [], ultimaMedicion: null });

    manager.stopAll();
  });

  it('R22 - con mediciones responde el último estado enriquecido y el historial', async () => {
    const pool = mockPool({ total: { minutos: 250, llamadas: 5 } });
    const { app, manager } = await buildApp({ sessionUser: OPERADOR, pool });
    await flush();

    const res = await request(app).get('/api/plugins/minutes-monitor/status').expect(200);
    expect(res.body.data.hasData).toBe(true);
    expect(res.body.data.estado.minutosConsumidos).toBe(250);
    expect(res.body.data.estado.nivelAlerta).toBe('OK');
    expect(res.body.data.historial).toHaveLength(1);
    expect(res.body.data.ultimaMedicion).toBe(res.body.data.estado.timestamp);

    manager.stopAll();
  });

  it('R33 - sin sesión 401 y con plugin deshabilitado 404 (job detenido por el manager)', async () => {
    const { app: anonApp, manager: m1 } = await buildApp({ sessionUser: null });
    await request(anonApp).get('/api/plugins/minutes-monitor/status').expect(401);
    m1.stopAll();

    const { app, manager } = await buildApp({ sessionUser: ADMIN });
    manager.setEnabled('minutes-monitor', false);
    const res = await request(app).get('/api/plugins/minutes-monitor/status');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'Plugin no disponible' });
    manager.stopAll();
  });
});

describe('GET/PUT /api/plugins/minutes-monitor/config', () => {
  it('R24/R26 - admin obtiene la config con defaults aplicados', async () => {
    const { app, manager } = await buildApp({ sessionUser: ADMIN });
    const res = await request(app).get('/api/plugins/minutes-monitor/config').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({ umbralMinutos: 70000, moneda: 'COP', intervaloMinutos: 60 });
    manager.stopAll();
  });

  it('R28 - usuario sin rol admin recibe 403 en GET y PUT', async () => {
    const { app, manager } = await buildApp({ sessionUser: OPERADOR });

    const g = await request(app).get('/api/plugins/minutes-monitor/config');
    expect(g.status).toBe(403);
    const p = await request(app).put('/api/plugins/minutes-monitor/config').send(VALID_CONFIG);
    expect(p.status).toBe(403);
    expect(p.body).toEqual({ ok: false, error: 'Se requiere rol de administrador' });

    manager.stopAll();
  });

  it('R27 - config inválida responde 400 con mensaje y no persiste nada', async () => {
    const { app, db, manager } = await buildApp({ sessionUser: ADMIN });

    const res = await request(app)
      .put('/api/plugins/minutes-monitor/config')
      .send({ ...VALID_CONFIG, umbralMinutos: -1 });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
    expect(getConfigValue(db, CONFIG_KEY, null)).toBeNull();

    manager.stopAll();
  });

  it('R25/R29 - PUT válido persiste en system_config y dispara broadcast plugin:minutes-monitor:update', async () => {
    const coreBroadcast = jest.fn();
    const { app, db, manager, broadcastSpy } = await buildApp({ sessionUser: ADMIN, coreBroadcast });
    await flush();
    broadcastSpy.mockClear();

    const res = await request(app)
      .put('/api/plugins/minutes-monitor/config')
      .send(VALID_CONFIG)
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.umbralMinutos).toBe(1000);

    // Persistido en SQLite (R25) — sobrevive reinicios
    const persisted = JSON.parse(getConfigValue(db, CONFIG_KEY));
    expect(persisted).toEqual(res.body.data);

    // Recalculo inmediato fire-and-forget con evento namespaced (R29, R21)
    await flush();
    expect(broadcastSpy).toHaveBeenCalledWith(
      'plugin:minutes-monitor:update',
      expect.objectContaining({
        estado: expect.objectContaining({ umbralMinutos: 1000 }),
        historial: expect.any(Array),
      })
    );

    manager.stopAll();
  });

  it('R7 - si MySQL falla en la medición se conserva el último estado válido', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const pool = mockPool({ total: { minutos: 111, llamadas: 3 } });
    const { app, manager } = await buildApp({ sessionUser: ADMIN, pool });
    await flush();

    // Primer estado válido
    let res = await request(app).get('/api/plugins/minutes-monitor/status').expect(200);
    expect(res.body.data.estado.minutosConsumidos).toBe(111);

    // La BD CDR cae; el recálculo post-PUT falla pero el PUT responde 200
    pool.state.reject = true;
    await request(app).put('/api/plugins/minutes-monitor/config').send(VALID_CONFIG).expect(200);
    await flush();

    res = await request(app).get('/api/plugins/minutes-monitor/status').expect(200);
    expect(res.body.data.hasData).toBe(true);
    expect(res.body.data.estado.minutosConsumidos).toBe(111); // estado previo intacto
    expect(res.body.data.historial).toHaveLength(1);          // sin medición fallida

    manager.stopAll();
  });
});

describe('Historial en memoria (R19, R20)', () => {
  it('R19 - conserva máximo 100 mediciones descartando la más antigua', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T12:00:00Z'));
    const ctx = makeCtx({ pool: mockPool({ total: { minutos: 10, llamadas: 1 } }) });
    await minutesPlugin.init(ctx);

    for (let i = 0; i < 101; i++) {
      jest.setSystemTime(new Date(Date.UTC(2026, 6, 15, 12, 0, i)));
      await minutesPlugin.jobs[0].run(ctx);
    }

    const lastCall = ctx.broadcast.mock.calls.at(-1);
    expect(lastCall[0]).toBe('update');
    expect(lastCall[1].historial).toHaveLength(100);
    // La más antigua (segundo 0) fue descartada; la primera restante es la del segundo 1
    expect(lastCall[1].historial[0].timestamp).toBe('2026-07-15T12:00:01.000Z');
  });

  it('R20 - una medición de un mes distinto reinicia el historial comenzando por ella', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-31T12:00:00Z'));
    const ctx = makeCtx({ pool: mockPool({ total: { minutos: 10, llamadas: 1 } }) });
    await minutesPlugin.init(ctx);

    await minutesPlugin.jobs[0].run(ctx);
    await minutesPlugin.jobs[0].run(ctx);
    expect(ctx.broadcast.mock.calls.at(-1)[1].historial).toHaveLength(2);

    // Cambio de mes (R20)
    jest.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    await minutesPlugin.jobs[0].run(ctx);

    const { estado, historial } = ctx.broadcast.mock.calls.at(-1)[1];
    expect(estado.mes).toBe('2026-08');
    expect(historial).toHaveLength(1);
    expect(historial[0].timestamp).toBe('2026-08-01T12:00:00.000Z');
  });
});

describe('init(ctx) y job (R1, R32)', () => {
  it('R1 - el job measure existe con intervalo default de 1 hora y init ajusta el intervalo persistido', async () => {
    const db = buildSqliteDb();
    const ctx = makeCtx({ db });

    await minutesPlugin.init(ctx);
    expect(minutesPlugin.jobs[0].name).toBe('measure');
    expect(minutesPlugin.jobs[0].intervalMs).toBe(3_600_000); // default 60 min

    setConfigValue(db, CONFIG_KEY, JSON.stringify({ ...DEFAULT_CONFIG, intervaloMinutos: 5 }));
    await minutesPlugin.init(ctx);
    expect(minutesPlugin.jobs[0].intervalMs).toBe(300_000);

    // Nunca por debajo del floor de 60 s aunque la config diga menos
    setConfigValue(db, CONFIG_KEY, JSON.stringify({ ...DEFAULT_CONFIG, intervaloMinutos: 1 }));
    await minutesPlugin.init(ctx);
    expect(minutesPlugin.jobs[0].intervalMs).toBe(60_000);

    // Restaurar el default para el resto de la suite
    setConfigValue(db, CONFIG_KEY, JSON.stringify(DEFAULT_CONFIG));
    await minutesPlugin.init(ctx);
  });
});
