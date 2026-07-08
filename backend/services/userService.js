'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const BCRYPT_ROUNDS = 12;

/**
 * Find a user by username (includes password field for auth comparison).
 * @param {Database} db
 * @param {string} username
 * @returns {object|undefined}
 */
function findByUsername(db, username) {
  return db.prepare(
    `SELECT id, username, password, role, active, last_login
     FROM users
     WHERE username = ?`
  ).get(username);
}

/**
 * Find a user by id (does NOT return password).
 * @param {Database} db
 * @param {number|string} id
 * @returns {object|undefined}
 */
function findById(db, id) {
  return db.prepare(
    `SELECT id, username, role, active, last_login
     FROM users
     WHERE id = ?`
  ).get(id);
}

/**
 * List all users without the password field.
 * @param {Database} db
 * @returns {object[]}
 */
function listUsers(db) {
  return db.prepare(
    `SELECT id, username, role, active, last_login
     FROM users
     ORDER BY id ASC`
  ).all();
}

/**
 * Create a new user. Hashes the password before storing.
 * @param {Database} db
 * @param {{ username: string, password: string, role: string }} fields
 * @returns {{ id: number, username: string, role: string, active: number }}
 */
async function createUser(db, { username, password, role }) {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  let info;
  try {
    info = db.prepare(
      `INSERT INTO users (username, password, role, active)
       VALUES (?, ?, ?, 1)`
    ).run(username, hash, role);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE constraint failed'))) {
      const dup = new Error('El nombre de usuario ya existe');
      dup.statusCode = 409;
      throw dup;
    }
    throw err;
  }

  return findById(db, info.lastInsertRowid);
}

/**
 * Update an existing user (partial update). Enforces last-admin guard.
 * @param {Database} db
 * @param {number|string} id
 * @param {{ username?: string, role?: string, active?: boolean|number }} fields
 * @returns {object} updated user (no password)
 */
function updateUser(db, id, fields) {
  const current = findById(db, id);
  if (!current) {
    const err = new Error('Usuario no encontrado');
    err.statusCode = 404;
    throw err;
  }

  const { username, role, active } = fields;

  // Last-admin guard (R16): prevent deactivating or demoting the sole active admin
  const willDeactivate = active !== undefined && Number(active) === 0 && current.active === 1;
  const willDemote     = role !== undefined && role !== 'admin' && current.role === 'admin';

  if ((willDeactivate || willDemote) && current.role === 'admin') {
    const { cnt } = db.prepare(
      `SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND active = 1`
    ).get();

    if (cnt === 1) {
      const err = new Error('No se puede desactivar o degradar al único administrador activo');
      err.statusCode = 409;
      throw err;
    }
  }

  // Build dynamic SET clause using only provided fields
  const sets   = [];
  const params = [];

  if (username !== undefined) { sets.push('username = ?'); params.push(username); }
  if (role     !== undefined) { sets.push('role = ?');     params.push(role); }
  if (active   !== undefined) { sets.push('active = ?');   params.push(Number(active) ? 1 : 0); }

  if (sets.length === 0) return current;

  params.push(id);

  try {
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      const dup = new Error('El nombre de usuario ya existe');
      dup.statusCode = 409;
      throw dup;
    }
    throw err;
  }

  return findById(db, id);
}

/**
 * Generate a temporary password, store its bcrypt hash, return the plain text.
 * @param {Database} db
 * @param {number|string} id
 * @returns {{ temporaryPassword: string }}
 */
async function resetPassword(db, id) {
  const user = findById(db, id);
  if (!user) {
    const err = new Error('Usuario no encontrado');
    err.statusCode = 404;
    throw err;
  }

  const temporaryPassword = crypto.randomBytes(12).toString('base64url');
  const hash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);

  db.prepare(`UPDATE users SET password = ? WHERE id = ?`).run(hash, id);

  return { temporaryPassword };
}

/**
 * Update last_login timestamp for the given user id.
 * @param {Database} db
 * @param {number|string} id
 */
function updateLastLogin(db, id) {
  db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(id);
}

module.exports = {
  findByUsername,
  findById,
  listUsers,
  createUser,
  updateUser,
  resetPassword,
  updateLastLogin,
};
