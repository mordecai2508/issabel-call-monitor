'use strict';

/**
 * ami.test.js — dashboard_extensions_status (#18) and
 * dashboard_extensions_chan_sip_fix (#19) feature tests
 *
 * Jest + Supertest, with a mocked `asterisk-manager` (no real AMI connection).
 * Covers R1/R2/R5/R6/R7/R8/R9/R10/R11/R12/R13/R18/R19/R20 (from #18) and
 * R21/R22/R23/R24/R25/R26 (from #19, the chan_sip SIPpeers/PeerEntry fix).
 */

const request = require('supertest');
const express = require('express');
const session = require('express-session');

const pbxRouter = require('../routes/pbx');

// ── Mock asterisk-manager ───────────────────────────────────────────────────
//
// The mock instance is an EventEmitter-like object exposing `on`,
// `removeListener`, and `action`. Each test controls the mock's behaviour via
// `__mockImpl` (set on the constructor before instantiating the service).

jest.mock('asterisk-manager', () => {
  const { EventEmitter } = require('events');

  function MockAsteriskManager(port, host, username, password, events) {
    const emitter = new EventEmitter();
    emitter.options = { port, host, username, password, events };
    emitter.action = function (action, callback) {
      if (MockAsteriskManager.__actionImpl) {
        return MockAsteriskManager.__actionImpl.call(emitter, action, callback);
      }
      return undefined;
    };
    return emitter;
  }

  MockAsteriskManager.__actionImpl = null;

  return MockAsteriskManager;
});

const AsteriskManager = require('asterisk-manager');
const createAmiExtensionsService = require('../services/amiExtensionsService');

afterEach(() => {
  AsteriskManager.__actionImpl = null;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_AMI_CONFIG = { host: '127.0.0.1', port: 5038, username: 'monitor', password: 'secret' };

/**
 * Configures the mock so that `action({ action: 'SIPpeers' }, cb)` emits the
 * given list of `{ extension, peerStatus }` pairs as `PeerEntry`
 * managerevents (`objectname`/`status`), followed by `PeerlistComplete`,
 * then resolves the action callback successfully.
 */
function mockSuccessfulQuery(peerDefs) {
  AsteriskManager.__actionImpl = function (action, callback) {
    process.nextTick(() => {
      for (const { extension, peerStatus } of peerDefs) {
        this.emit('managerevent', { event: 'PeerEntry', objectname: extension, status: peerStatus });
      }
      this.emit('managerevent', { event: 'PeerlistComplete' });
      callback(null, { response: 'Success' });
    });
  };
}

/** Configures the mock so the action callback never fires (simulates a hang/timeout). */
function mockHangingQuery() {
  AsteriskManager.__actionImpl = function () {
    // never calls callback, never emits PeerlistComplete
  };
}

/** Configures the mock so the action callback fires with an error. */
function mockFailingQuery(message) {
  AsteriskManager.__actionImpl = function (action, callback) {
    process.nextTick(() => callback(new Error(message)));
  };
}

/**
 * Build a fresh Express app mounting `routes/pbx.js` with the given
 * `amiExtensionsService` (and a minimal `pbxHealthService` stub, plus
 * R18 smoke-test mirrors of `/api/calls/today` and `/api/pbx/health`).
 */
function buildApp({ amiExtensionsService, sessionUser = { id: 1, username: 'tester', role: 'monitor' } } = {}) {
  const pool   = { query: jest.fn().mockResolvedValue([[{ '1': 1 }]]) };
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

  const pbxHealthService = {
    ensureChecked: jest.fn().mockResolvedValue({ connected: true, lastCheck: null, lastError: null, latencyMs: 0 }),
    check:         jest.fn().mockResolvedValue({ connected: true, lastCheck: null, lastError: null, latencyMs: 0 }),
    getStatus:     jest.fn().mockReturnValue({ connected: true, lastCheck: null, lastError: null, latencyMs: 0 }),
  };

  app.use('/api', pbxRouter(pool, config, db, requireAuth, pbxHealthService, amiExtensionsService));

  // R18 smoke-test mirror of /api/calls/today.
  app.get('/api/calls/today', requireAuth, async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, stats: {}, channels: [], hourly: [] });
    } catch {
      res.status(500).json({ ok: false, error: 'Error al consultar la base de datos' });
    }
  });

  return { app, pool };
}

// ── R1/R2 — createAmiExtensionsService sin configuración ───────────────────

describe('createAmiExtensionsService - sin configuración (R1/R2)', () => {

  it('R1/R2 - amiConfig undefined: getStatus() devuelve el estado vacío sin invocar asterisk-manager', () => {
    const service = createAmiExtensionsService(undefined);

    expect(service.getStatus()).toEqual({ total: 0, active: 0, extensions: [], available: false });
    expect(AsteriskManager.__actionImpl).toBeNull();
  });

  it('R1/R2 - amiConfig = {} (sin host/port/username/password): getStatus() devuelve el estado vacío sin invocar asterisk-manager', async () => {
    const service = createAmiExtensionsService({});

    const status = await service.check();

    expect(status).toEqual({ total: 0, active: 0, extensions: [], available: false });
    expect(service.getStatus()).toEqual({ total: 0, active: 0, extensions: [], available: false });
  });

  it('R2 - start() es no-op si no está configurado (no crea timers)', () => {
    jest.useFakeTimers();
    const service = createAmiExtensionsService(null);
    const stop = service.start(1000);

    expect(jest.getTimerCount()).toBe(0);
    stop();
    jest.useRealTimers();
  });
});

// ── R7/R8/R9 — GET /api/pbx/extensions ──────────────────────────────────────

describe('GET /api/pbx/extensions', () => {

  it('R7 - sesión válida y estado available=true devuelve 200 con { total, active, extensions, available }', async () => {
    const amiExtensionsService = {
      getStatus: jest.fn().mockReturnValue({
        total: 3,
        active: 2,
        extensions: [
          { extension: '100', status: 'active' },
          { extension: '101', status: 'active' },
          { extension: '102', status: 'inactive' },
        ],
        available: true,
      }),
      check: jest.fn(),
      start: jest.fn(),
    };

    const { app } = buildApp({ amiExtensionsService });

    const res = await request(app).get('/api/pbx/extensions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      data: {
        total: 3,
        active: 2,
        extensions: [
          { extension: '100', status: 'active' },
          { extension: '101', status: 'active' },
          { extension: '102', status: 'inactive' },
        ],
        available: true,
      },
    });
  });

  it('R8 - sin sesión retorna 401 sin datos de extensiones', async () => {
    const amiExtensionsService = {
      getStatus: jest.fn().mockReturnValue({ total: 0, active: 0, extensions: [], available: false }),
      check: jest.fn(),
      start: jest.fn(),
    };

    const { app } = buildApp({ amiExtensionsService, sessionUser: null });

    const res = await request(app).get('/api/pbx/extensions');

    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
    expect(amiExtensionsService.getStatus).not.toHaveBeenCalled();
  });

  it('R9 - AMI no configurado (config.ami ausente/{}) devuelve 200 con { total: 0, active: 0, extensions: [], available: false }', async () => {
    const amiExtensionsService = createAmiExtensionsService({});

    const { app } = buildApp({ amiExtensionsService });

    const res = await request(app).get('/api/pbx/extensions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      data: { total: 0, active: 0, extensions: [], available: false },
    });
  });

  it('R6 - GET /api/pbx/extensions no dispara una nueva consulta AMI (solo getStatus, no check)', async () => {
    const amiExtensionsService = {
      getStatus: jest.fn().mockReturnValue({ total: 1, active: 1, extensions: [{ extension: '100', status: 'active' }], available: true }),
      check: jest.fn(),
      start: jest.fn(),
    };

    const { app } = buildApp({ amiExtensionsService });

    await request(app).get('/api/pbx/extensions');
    await request(app).get('/api/pbx/extensions');

    expect(amiExtensionsService.check).not.toHaveBeenCalled();
    expect(amiExtensionsService.getStatus).toHaveBeenCalledTimes(2);
  });
});

// ── R21/R22/R5 — check() exitoso con AMI configurado ────────────────────────

describe('amiExtensionsService.check() - consulta exitosa (R21/R22/R5)', () => {

  it('R21/R22 - envía la acción SIPpeers y parsea PeerEntry/PeerlistComplete a { extension, status } y calcula total/active', async () => {
    let sentAction = null;
    AsteriskManager.__actionImpl = function (action, callback) {
      sentAction = action;
      process.nextTick(() => {
        this.emit('managerevent', { event: 'PeerEntry', objectname: '100', status: 'OK (10 ms)' });
        this.emit('managerevent', { event: 'PeerEntry', objectname: '101', status: 'OK (5 ms)' });
        this.emit('managerevent', { event: 'PeerEntry', objectname: '102', status: 'UNKNOWN' });
        this.emit('managerevent', { event: 'PeerlistComplete' });
        callback(null, { response: 'Success' });
      });
    };

    const service = createAmiExtensionsService(VALID_AMI_CONFIG);
    const status = await service.check();

    expect(sentAction).toEqual({ action: 'SIPpeers' });
    expect(status.available).toBe(true);
    expect(status.total).toBe(3);
    expect(status.active).toBe(2);
    expect(status.extensions).toEqual(expect.arrayContaining([
      { extension: '100', status: 'active' },
      { extension: '101', status: 'active' },
      { extension: '102', status: 'inactive' },
    ]));
  });

  it('R5 - solo se invoca la acción de lectura SIPpeers (sin acciones de escritura)', async () => {
    mockSuccessfulQuery([{ extension: '100', peerStatus: 'OK (10 ms)' }]);

    const service = createAmiExtensionsService(VALID_AMI_CONFIG);
    await service.check();

    expect(AsteriskManager.__actionImpl).not.toBeNull();
  });
});

// ── R23 — filtro extensión vs. troncal ──────────────────────────────────────

describe('amiExtensionsService.check() - filtro extensión vs. troncal (R23)', () => {

  it('R23 - excluye peers con ObjectName no puramente numérico (troncales)', async () => {
    mockSuccessfulQuery([
      { extension: '202', peerStatus: 'OK (50 ms)' },
      { extension: '301', peerStatus: 'OK (60 ms)' },
      { extension: 'ENT_LIWA', peerStatus: 'OK (10 ms)' },
      { extension: 'NET2_ENT_6076854970', peerStatus: 'UNKNOWN' },
      { extension: 'VIRTUAL_TRUNK_SALIENTE', peerStatus: 'OK (5 ms)' },
    ]);

    const service = createAmiExtensionsService(VALID_AMI_CONFIG);
    const status = await service.check();

    expect(status.total).toBe(2);
    expect(status.active).toBe(2);
    expect(status.extensions).toEqual(expect.arrayContaining([
      { extension: '202', status: 'active' },
      { extension: '301', status: 'active' },
    ]));
    expect(status.extensions).toHaveLength(2);
    expect(status.extensions.some(e => e.extension === 'ENT_LIWA')).toBe(false);
    expect(status.extensions.some(e => e.extension === 'NET2_ENT_6076854970')).toBe(false);
    expect(status.extensions.some(e => e.extension === 'VIRTUAL_TRUNK_SALIENTE')).toBe(false);
  });
});

// ── R24 — mapeo de Status a active/inactive ─────────────────────────────────

describe('amiExtensionsService.check() - mapeo de Status (R24)', () => {

  it('R24 - clasifica status OK/LAGGED como active y UNKNOWN/UNREACHABLE/Unmonitored/ausente como inactive', async () => {
    mockSuccessfulQuery([
      { extension: '202', peerStatus: 'OK (230 ms)' },
      { extension: '203', peerStatus: 'OK (9 ms)' },
      { extension: '301', peerStatus: 'LAGGED (800 ms)' },
      { extension: '1',   peerStatus: 'UNKNOWN' },
      { extension: '101', peerStatus: 'UNREACHABLE' },
      { extension: '201', peerStatus: 'Unmonitored' },
      { extension: '204', peerStatus: '' },
      { extension: '205', peerStatus: undefined },
    ]);

    const service = createAmiExtensionsService(VALID_AMI_CONFIG);
    const status = await service.check();

    expect(status.total).toBe(8);
    expect(status.active).toBe(3);
    expect(status.extensions).toEqual(expect.arrayContaining([
      { extension: '202', status: 'active' },
      { extension: '203', status: 'active' },
      { extension: '301', status: 'active' },
      { extension: '1',   status: 'inactive' },
      { extension: '101', status: 'inactive' },
      { extension: '201', status: 'inactive' },
      { extension: '204', status: 'inactive' },
      { extension: '205', status: 'inactive' },
    ]));
  });
});

// ── R10/R11/R25 — fallos de conexión / consulta ─────────────────────────────

describe('amiExtensionsService.check() - fallos (R10/R11/R25)', () => {

  it('R11/R25 - fallo de SIPpeers sin éxito previo: se loguea sin crashear y mantiene estado vacío', async () => {
    mockFailingQuery('ECONNREFUSED');

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const service = createAmiExtensionsService(VALID_AMI_CONFIG);
    const status = await service.check();

    expect(status).toEqual({ total: 0, active: 0, extensions: [], available: false });
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('R10 - fallo de consulta tras un éxito previo: conserva el último estado bueno conocido (available=true)', async () => {
    mockSuccessfulQuery([{ extension: '100', peerStatus: 'OK (10 ms)' }]);
    const service = createAmiExtensionsService(VALID_AMI_CONFIG);

    const firstStatus = await service.check();
    expect(firstStatus.available).toBe(true);

    mockFailingQuery('ETIMEDOUT');
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const secondStatus = await service.check();

    expect(secondStatus).toEqual(firstStatus);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

// ── R12/R13 — timeout acotado ────────────────────────────────────────────────

describe('amiExtensionsService.check() - timeout acotado (R12/R13)', () => {

  it('R13 - una consulta que nunca completa se trata como fallo en un tiempo acotado (sin esperar indefinidamente)', async () => {
    mockHangingQuery();

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const service = createAmiExtensionsService(VALID_AMI_CONFIG, { timeoutMs: 50 });
    const status = await service.check();

    expect(status).toEqual({ total: 0, active: 0, extensions: [], available: false });

    const loggedMessages = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(loggedMessages).toMatch(/timeout/i);

    consoleErrorSpy.mockRestore();
  });
});

// ── R20 — no exponer credenciales AMI ───────────────────────────────────────

describe('amiExtensionsService - no exposición de credenciales (R20)', () => {

  it('R20 - getStatus() no contiene username/password tras un fallo, y console.error no expone credenciales', async () => {
    mockFailingQuery('ECONNREFUSED');

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const service = createAmiExtensionsService(VALID_AMI_CONFIG);
    await service.check();

    const status = service.getStatus();
    const statusJson = JSON.stringify(status);
    expect(statusJson).not.toContain(VALID_AMI_CONFIG.username);
    expect(statusJson).not.toContain(VALID_AMI_CONFIG.password);

    const loggedMessages = consoleErrorSpy.mock.calls.flat().map(arg => {
      try {
        return typeof arg === 'string' ? arg : JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }).join(' ');
    expect(loggedMessages).not.toContain(VALID_AMI_CONFIG.username);
    expect(loggedMessages).not.toContain(VALID_AMI_CONFIG.password);

    consoleErrorSpy.mockRestore();
  });

  it('R20 - GET /api/pbx/extensions no expone username/password del AMI en la respuesta', async () => {
    const amiExtensionsService = {
      getStatus: jest.fn().mockReturnValue({
        total: 1,
        active: 1,
        extensions: [{ extension: '100', status: 'active' }],
        available: true,
      }),
      check: jest.fn(),
      start: jest.fn(),
    };

    const { app } = buildApp({ amiExtensionsService });

    const res = await request(app).get('/api/pbx/extensions');

    const bodyJson = JSON.stringify(res.body);
    expect(bodyJson).not.toContain(VALID_AMI_CONFIG.username);
    expect(bodyJson).not.toContain(VALID_AMI_CONFIG.password);
  });
});

// ── R12 — ciclo de polling AMI independiente de /api/events ────────────────

describe('amiExtensionsService.start() - ciclo de polling propio (R12)', () => {

  afterEach(() => {
    jest.useRealTimers();
  });

  it('R12 - start() arranca su propio setInterval y check() se invoca periódicamente sin depender de /api/events', async () => {
    jest.useFakeTimers();

    let queryCount = 0;
    AsteriskManager.__actionImpl = function (action, callback) {
      queryCount += 1;
      process.nextTick(() => {
        this.emit('managerevent', { event: 'PeerEntry', objectname: '100', status: 'OK (10 ms)' });
        this.emit('managerevent', { event: 'PeerlistComplete' });
        callback(null, { response: 'Success' });
      });
    };

    const service = createAmiExtensionsService(VALID_AMI_CONFIG, { timeoutMs: 50 });

    // Antes de start(), no hay timers propios del servicio AMI y no se ha
    // consultado AMI todavía (no depende del ciclo de /api/events).
    expect(jest.getTimerCount()).toBe(0);
    expect(queryCount).toBe(0);

    const stop = service.start(1000);

    // start() crea su propio setInterval, independiente de cualquier timer
    // del ciclo SSE de /api/events (que este test ni siquiera monta).
    expect(jest.getTimerCount()).toBe(1);
    expect(queryCount).toBe(0);

    // Avanzar el reloj simulado dispara el ciclo de polling propio del
    // servicio (consulta AMI vía SIPpeers), sin que exista (ni se
    // requiera) un servidor Express/SSE.
    await jest.advanceTimersByTimeAsync(1000);
    expect(queryCount).toBe(1);

    await jest.advanceTimersByTimeAsync(1000);
    expect(queryCount).toBe(2);

    await jest.advanceTimersByTimeAsync(1000);
    expect(queryCount).toBe(3);

    // El estado en memoria refleja las consultas periódicas propias.
    expect(service.getStatus()).toEqual({
      total: 1,
      active: 1,
      extensions: [{ extension: '100', status: 'active' }],
      available: true,
    });

    stop();

    // Tras stop(), el ciclo propio se detiene: no se realizan más consultas.
    await jest.advanceTimersByTimeAsync(2000);
    expect(queryCount).toBe(3);
  });

  it('R12 - el setInterval de start() no se reutiliza ni se comparte: cada llamada a start() crea un timer independiente', () => {
    jest.useFakeTimers();

    const serviceA = createAmiExtensionsService(VALID_AMI_CONFIG);
    const serviceB = createAmiExtensionsService(VALID_AMI_CONFIG);

    const stopA = serviceA.start(1000);
    expect(jest.getTimerCount()).toBe(1);

    const stopB = serviceB.start(2000);
    expect(jest.getTimerCount()).toBe(2);

    stopA();
    expect(jest.getTimerCount()).toBe(1);

    stopB();
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ── R19 — sin uso del pool MySQL ────────────────────────────────────────────

describe('createAmiExtensionsService - sin pool MySQL (R19)', () => {

  it('R19 - la factory no acepta ni usa un argumento `pool`: su firma es (amiConfig, options = {})', () => {
    // La firma actual de createAmiExtensionsService es (amiConfig, options = {}).
    // `Function.length` solo cuenta los parámetros anteriores al primer valor
    // por defecto, por lo que `options` (con default `{}`) no se cuenta —
    // de ahí que el valor esperado sea 1, no 2. Lo relevante para R19 es que
    // ningún parámetro se llama/usa como `pool`: la fuente del archivo no
    // declara `pool` en la firma de la factory.
    expect(createAmiExtensionsService.length).toBe(1);

    const source = createAmiExtensionsService.toString();
    const signature = source.slice(0, source.indexOf(')') + 1);
    expect(signature).not.toMatch(/\bpool\b/);
  });

  it('R19 - check() no invoca pool.query bajo ninguna circunstancia (configurado, no configurado, éxito o fallo)', async () => {
    const pool = { query: jest.fn().mockResolvedValue([[{ '1': 1 }]]) };

    // Caso "no configurado" (R2/R9): no debe tocar `pool`.
    const unconfigured = createAmiExtensionsService({});
    await unconfigured.check();
    expect(pool.query).not.toHaveBeenCalled();

    // Caso "configurado, consulta exitosa": tampoco debe tocar `pool`.
    mockSuccessfulQuery([{ extension: '100', peerStatus: 'OK (10 ms)' }]);
    const configuredOk = createAmiExtensionsService(VALID_AMI_CONFIG);
    await configuredOk.check();
    expect(pool.query).not.toHaveBeenCalled();

    // Caso "configurado, consulta fallida": tampoco debe tocar `pool`.
    mockFailingQuery('ECONNREFUSED');
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const configuredFail = createAmiExtensionsService(VALID_AMI_CONFIG);
    await configuredFail.check();
    expect(pool.query).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('R19 - GET /api/pbx/extensions responde usando solo amiExtensionsService.getStatus(), sin invocar pool.query', async () => {
    const amiExtensionsService = {
      getStatus: jest.fn().mockReturnValue({ total: 0, active: 0, extensions: [], available: false }),
      check: jest.fn(),
      start: jest.fn(),
    };

    const { app, pool } = buildApp({ amiExtensionsService });

    await request(app).get('/api/pbx/extensions');

    expect(pool.query).not.toHaveBeenCalled();
    expect(amiExtensionsService.getStatus).toHaveBeenCalled();
  });
});

// ── R18 — no-regresión de endpoints existentes ──────────────────────────────

describe('R18 - no-regresión tras ampliar routes/pbx.js', () => {

  it('R18 - GET /api/calls/today sigue respondiendo con su forma habitual', async () => {
    const amiExtensionsService = createAmiExtensionsService({});
    const { app } = buildApp({ amiExtensionsService });

    const res = await request(app).get('/api/calls/today');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('stats');
    expect(res.body).toHaveProperty('channels');
    expect(res.body).toHaveProperty('hourly');
  });

  it('R18 - GET /api/pbx/health sigue respondiendo con su forma habitual', async () => {
    const amiExtensionsService = createAmiExtensionsService({});
    const { app } = buildApp({ amiExtensionsService });

    const res = await request(app).get('/api/pbx/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ connected: true, lastCheck: null, lastError: null, latencyMs: 0 });
  });
});

// ── R26 — documentación del permiso AMI `reporting` ────────────────────────

describe('config.example.json - documentación del permiso AMI reporting (R26)', () => {

  it('R26 - el bloque ami de config.example.json documenta que manager.conf necesita la clase reporting en read para que SIPpeers funcione', () => {
    // eslint-disable-next-line global-require
    const exampleConfig = require('../config.example.json');

    expect(exampleConfig).toHaveProperty('ami');
    expect(exampleConfig.ami).toHaveProperty('_comment');
    expect(typeof exampleConfig.ami._comment).toBe('string');

    // El comentario debe mencionar explícitamente la clase 'reporting' de
    // manager.conf y la acción AMI SIPpeers que depende de ella.
    expect(exampleConfig.ami._comment).toMatch(/reporting/i);
    expect(exampleConfig.ami._comment).toMatch(/SIPpeers/i);
  });
});
