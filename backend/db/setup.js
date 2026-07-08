'use strict';

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = path.join(__dirname, 'monitor.sqlite');

/**
 * Initialise (or open) the local SQLite database, create tables,
 * and migrate users from config.json on first run.
 *
 * @param {object} config  The parsed config.json object
 * @returns {Database}     The open better-sqlite3 instance
 */
function initDb(config) {
  const db = new Database(DB_PATH);

  // Ensure WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // better-sqlite3 enables `foreign_keys` by default (unlike stock SQLite).
  // alerts.rule_id intentionally has no ON DELETE behaviour: deleting an
  // alert_rules row must succeed while preserving historical alerts whose
  // rule_id may then point to a no-longer-existing rule (R9, alerts_monitoring).
  db.pragma('foreign_keys = OFF');

  // ── users table ────────────────────────────────────────────────
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

  // ── audit_log table ────────────────────────────────────────────
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

  // ── index for fast audit queries ───────────────────────────────
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp
    ON audit_log (timestamp DESC)
  `);

  // ── system_config table (key-value, system_config feature) ─────
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // ── extensions_config table (per-extension overrides) ──────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS extensions_config (
      extension    TEXT PRIMARY KEY,
      display_name TEXT,
      hidden       INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
    )
  `);

  // ── trunks_config table (trunk visibility overrides) ────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS trunks_config (
      trunk  TEXT PRIMARY KEY,
      hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
    )
  `);

  // ── alert_rules table (alerts_monitoring feature) ───────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT    NOT NULL CHECK (type IN ('trunk_down', 'ext_unreachable', 'lost_spike', 'pbx_disconnect')),
      threshold    REAL,
      enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      notify_email TEXT
    )
  `);

  // ── alerts table (alerts_monitoring feature) ────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id     INTEGER REFERENCES alert_rules(id),
      type        TEXT    NOT NULL,
      description TEXT,
      resolved    INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    )
  `);

  // ── indexes for alerts queries ───────────────────────────────────
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_resolved
    ON alerts (resolved, created_at DESC)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_rule_unresolved
    ON alerts (rule_id, resolved)
  `);

  // ── plugins table (plugin_system feature) ───────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugins (
      name       TEXT    PRIMARY KEY,
      enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── migrate users from config.json → SQLite ────────────────────
  const insert = db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password, role, active)
     VALUES (?, ?, ?, ?, 1)`
  );

  const migrateAll = db.transaction((users) => {
    for (const u of users) {
      insert.run(u.id, u.username, u.password, u.role);
    }
  });

  if (Array.isArray(config.users) && config.users.length > 0) {
    migrateAll(config.users);
  }

  return db;
}

module.exports = { initDb };
