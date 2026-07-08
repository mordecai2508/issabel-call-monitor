'use strict';

/**
 * users.test.js — user_management feature tests
 * Uses Jest + Supertest with an in-memory SQLite DB and a mocked MySQL pool.
 */

const request    = require('supertest');
const express    = require('express');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const Database   = require('better-sqlite3');

const { initDb }    = require('../db/setup');
const userService   = require('../services/userService');
const auditService  = require('../services/auditService');
const usersRouter   = require('../routes/users');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a fresh Express app with in-memory SQLite and seeded users.
 * The MySQL pool is mocked (never called by user-management code).
 */
async function buildApp() {
  // Config with two users for migration test (R1, R2)
  const configUsers = [
    { id: 1, username: 'admin', password: await bcrypt.hash('adminpass', 12), role: 'admin' },
    { id: 2, username: 'operador', password: await bcrypt.hash('operpass', 12), role: 'operador' },
  ];

  const config = {
    server: { sessionSecret: 'test-secret', port: 0 },
    users:  configUsers,
    db:     { host: 'localhost', user: 'x', password: 'x', database: 'x' },
  };

  // In-memory SQLite (fresh for each buildApp call)
  const db = new Database(':memory:');
  // Run setup manually using the same logic as initDb but in-memory
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    UNIQUE NOT NULL,
      password   TEXT    NOT NULL,
      role       TEXT    NOT NULL CHECK (role IN ('admin', 'operador')),
      active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      last_login TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER,
      username  TEXT,
      action    TEXT NOT NULL CHECK (action IN ('login', 'logout', 'login_failed')),
      ip        TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp
    ON audit_log (timestamp DESC)
  `);

  // Migrate config users
  const insert = db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password, role, active) VALUES (?, ?, ?, ?, 1)`
  );
  const migrate = db.transaction((users) => { for (const u of users) insert.run(u.id, u.username, u.password, u.role); });
  migrate(configUsers);

  // Mock pool (MySQL not needed for user management)
  const pool = { query: jest.fn().mockResolvedValue([[{ cnt: 1 }]]) };

  const app = express();
  app.use(express.json());
  app.use(session({
    secret:            config.server.sessionSecret,
    resave:            false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }));

  function requireAuth(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ ok: false, error: 'No autenticado' });
    next();
  }
  function requireAdmin(req, res, next) {
    if (!req.session?.user)                return res.status(401).json({ ok: false, error: 'No autenticado' });
    if (req.session.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Se requiere rol de administrador' });
    next();
  }

  // Mount users router
  app.use('/api', usersRouter(pool, config, db, requireAuth, requireAdmin));

  // Login endpoint (mirrors server.js logic)
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ ok: false, error: 'Requerido' });

    const user = userService.findByUsername(db, username);
    if (!user) {
      auditService.logAction(db, { userId: null, username, action: 'login_failed', ip: req.ip });
      return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
    }
    if (user.active === 0) {
      auditService.logAction(db, { userId: user.id, username: user.username, action: 'login_failed', ip: req.ip });
      return res.status(401).json({ ok: false, error: 'Cuenta desactivada' });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      auditService.logAction(db, { userId: user.id, username: user.username, action: 'login_failed', ip: req.ip });
      return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
    }
    req.session.user = { id: user.id, username: user.username, role: user.role };
    userService.updateLastLogin(db, user.id);
    auditService.logAction(db, { userId: user.id, username: user.username, action: 'login', ip: req.ip });
    res.json({ ok: true, user: req.session.user });
  });

  // Logout endpoint
  app.post('/api/auth/logout', (req, res) => {
    if (req.session?.user) {
      auditService.logAction(db, {
        userId:   req.session.user.id,
        username: req.session.user.username,
        action:   'logout',
        ip:       req.ip,
      });
    }
    req.session.destroy(() => res.json({ ok: true }));
  });

  return { app, db, config, configUsers };
}

/**
 * Return a supertest agent that is logged in as admin.
 */
async function adminAgent(app) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
  return agent;
}

/**
 * Return a supertest agent logged in as operador.
 */
async function operadorAgent(app) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username: 'operador', password: 'operpass' });
  return agent;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('user_management feature', () => {
  let app, db, config, configUsers;

  beforeEach(async () => {
    ({ app, db, config, configUsers } = await buildApp());
  });

  // ── Migration ──────────────────────────────────────────────────
  it('R1 - la migración importa usuarios de config.json al arrancar', () => {
    const rows = db.prepare('SELECT username FROM users').all();
    const usernames = rows.map(r => r.username);
    expect(usernames).toContain('admin');
    expect(usernames).toContain('operador');
  });

  it('R2 - la migración no duplica usuarios existentes al reiniciar', () => {
    // Run migration again with same data
    const insert = db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password, role, active) VALUES (?, ?, ?, ?, 1)`
    );
    const migrate = db.transaction((users) => { for (const u of users) insert.run(u.id, u.username, u.password, u.role); });
    migrate(configUsers);
    const rows = db.prepare(`SELECT username FROM users WHERE username = 'admin'`).all();
    expect(rows.length).toBe(1);
  });

  // ── Listado ────────────────────────────────────────────────────
  it('R4 - GET /admin/users devuelve id, username, role, active, last_login', async () => {
    const agent = await adminAgent(app);
    const res = await agent.get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const users = res.body.data;
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBeGreaterThan(0);
    const u = users[0];
    expect(u).toHaveProperty('id');
    expect(u).toHaveProperty('username');
    expect(u).toHaveProperty('role');
    expect(u).toHaveProperty('active');
    expect(u).toHaveProperty('last_login');
  });

  it('R5 - operador recibe 403 en GET /admin/users', async () => {
    const agent = await operadorAgent(app);
    const res = await agent.get('/api/admin/users');
    expect(res.status).toBe(403);
  });

  it('R6 - sin sesión recibe 401 en /api/admin/users', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  // ── Creación ───────────────────────────────────────────────────
  it('R7 - POST /admin/users crea usuario y devuelve 201', async () => {
    const agent = await adminAgent(app);
    const res = await agent.post('/api/admin/users').send({
      username: 'nuevo',
      password: 'password123',
      role:     'operador',
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.username).toBe('nuevo');
    expect(res.body.data).not.toHaveProperty('password');
  });

  it('R8 - POST con username duplicado devuelve 409', async () => {
    const agent = await adminAgent(app);
    const res = await agent.post('/api/admin/users').send({
      username: 'admin',
      password: 'otropass1',
      role:     'operador',
    });
    expect(res.status).toBe(409);
  });

  it('R9 - POST con role inválido devuelve 400', async () => {
    const agent = await adminAgent(app);
    const res = await agent.post('/api/admin/users').send({
      username: 'testusr',
      password: 'password1',
      role:     'superadmin',
    });
    expect(res.status).toBe(400);
  });

  it('R10 - POST con campos faltantes devuelve 400', async () => {
    const agent = await adminAgent(app);
    const res = await agent.post('/api/admin/users').send({ username: 'testusr' });
    expect(res.status).toBe(400);
  });

  it('R11 - POST con password < 8 chars devuelve 400', async () => {
    const agent = await adminAgent(app);
    const res = await agent.post('/api/admin/users').send({
      username: 'testusr2',
      password: 'short',
      role:     'operador',
    });
    expect(res.status).toBe(400);
  });

  // ── Edición ────────────────────────────────────────────────────
  it('R12 - PATCH actualiza campos parcialmente', async () => {
    const agent = await adminAgent(app);
    // Create a user to edit
    const create = await agent.post('/api/admin/users').send({
      username: 'editme',
      password: 'password1',
      role:     'operador',
    });
    const id = create.body.data.id;

    const res = await agent.patch(`/api/admin/users/${id}`).send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('admin');
    expect(res.body.data.username).toBe('editme'); // unchanged
  });

  it('R13 - PATCH con username duplicado devuelve 409', async () => {
    const agent = await adminAgent(app);
    const create = await agent.post('/api/admin/users').send({
      username: 'dupcheck',
      password: 'password1',
      role:     'operador',
    });
    const id = create.body.data.id;
    const res = await agent.patch(`/api/admin/users/${id}`).send({ username: 'admin' });
    expect(res.status).toBe(409);
  });

  it('R14 - PATCH id inexistente devuelve 404', async () => {
    const agent = await adminAgent(app);
    const res = await agent.patch('/api/admin/users/99999').send({ role: 'operador' });
    expect(res.status).toBe(404);
  });

  it('R16 - PATCH no puede desactivar el único administrador activo', async () => {
    const agent = await adminAgent(app);
    // id=1 is the only admin
    const res = await agent.patch('/api/admin/users/1').send({ active: false });
    expect(res.status).toBe(409);
  });

  // ── Reset de contraseña ────────────────────────────────────────
  it('R17 - POST reset-password devuelve contraseña temporal en plain text', async () => {
    const agent = await adminAgent(app);
    const res = await agent.post('/api/admin/users/2/reset-password');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveProperty('temporaryPassword');
    expect(typeof res.body.data.temporaryPassword).toBe('string');
    expect(res.body.data.temporaryPassword.length).toBeGreaterThan(0);
  });

  it('R18 - POST reset-password con id inexistente devuelve 404', async () => {
    const agent = await adminAgent(app);
    const res = await agent.post('/api/admin/users/99999/reset-password');
    expect(res.status).toBe(404);
  });

  // ── Auditoría ──────────────────────────────────────────────────
  it('R19 - login registra entrada en audit_log con action=login', async () => {
    await request(app).post('/api/auth/login').send({ username: 'admin', password: 'adminpass' });
    const row = db.prepare(`SELECT * FROM audit_log WHERE action = 'login' AND username = 'admin'`).get();
    expect(row).toBeDefined();
    expect(row.action).toBe('login');
    expect(row.user_id).toBe(1);
  });

  it('R20 - logout registra entrada en audit_log con action=logout', async () => {
    const agent = await adminAgent(app);
    await agent.post('/api/auth/logout');
    const row = db.prepare(`SELECT * FROM audit_log WHERE action = 'logout' AND username = 'admin'`).get();
    expect(row).toBeDefined();
    expect(row.action).toBe('logout');
  });

  it('R21 - login fallido registra action=login_failed', async () => {
    await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrongpass' });
    const row = db.prepare(`SELECT * FROM audit_log WHERE action = 'login_failed'`).get();
    expect(row).toBeDefined();
    expect(row.action).toBe('login_failed');
  });

  it('R22 - GET /admin/audit-log devuelve máximo 200 entradas ordenadas DESC', async () => {
    // Insert 5 entries
    for (let i = 0; i < 5; i++) {
      auditService.logAction(db, { userId: 1, username: 'admin', action: 'login', ip: '127.0.0.1' });
    }
    const agent = await adminAgent(app);
    const res = await agent.get('/api/admin/audit-log');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(200);
    // Verify ordering: each entry timestamp >= next
    const timestamps = res.body.data.map(e => e.timestamp);
    for (let i = 0; i < timestamps.length - 1; i++) {
      expect(timestamps[i] >= timestamps[i + 1]).toBe(true);
    }
  });

  it('R23 - operador recibe 403 en GET /admin/audit-log', async () => {
    const agent = await operadorAgent(app);
    const res = await agent.get('/api/admin/audit-log');
    expect(res.status).toBe(403);
  });

  // ── Login con fuente migrada ───────────────────────────────────
  it('R25 - login autentica contra SQLite, no contra config.users', async () => {
    // Add a user only in SQLite (not in config.users) and verify login works
    await userService.createUser(db, { username: 'sqliteonly', password: 'sqlitepass1', role: 'operador' });
    const res = await request(app).post('/api/auth/login').send({ username: 'sqliteonly', password: 'sqlitepass1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('R26 - login rechaza usuario inactivo con 401 y mensaje de cuenta desactivada', async () => {
    // Deactivate operador (first promote another admin to avoid guard trigger)
    const agent = await adminAgent(app);
    await agent.post('/api/admin/users').send({ username: 'admin2', password: 'adminpass2', role: 'admin' });
    await agent.patch('/api/admin/users/2').send({ active: false });

    const res = await request(app).post('/api/auth/login').send({ username: 'operador', password: 'operpass' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/desactivada/i);
  });

  // ── No password in responses ───────────────────────────────────
  it('R28 - ninguna respuesta de listado contiene el campo password', async () => {
    const agent = await adminAgent(app);
    const res = await agent.get('/api/admin/users');
    expect(res.status).toBe(200);
    for (const u of res.body.data) {
      expect(u).not.toHaveProperty('password');
    }
  });
});
