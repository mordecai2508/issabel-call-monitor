'use strict';

/**
 * Insert an audit log entry.
 *
 * @param {Database} db
 * @param {{ userId: number|null, username: string, action: string, ip: string }} opts
 */
function logAction(db, { userId, username, action, ip }) {
  db.prepare(
    `INSERT INTO audit_log (user_id, username, action, ip)
     VALUES (?, ?, ?, ?)`
  ).run(userId ?? null, username ?? null, action, ip ?? null);
}

/**
 * Return the most recent `limit` audit log entries ordered newest-first.
 *
 * @param {Database} db
 * @param {number} [limit=200]
 * @returns {object[]}
 */
function getRecentLog(db, limit = 200) {
  return db.prepare(
    `SELECT id, user_id, username, action, ip, timestamp
     FROM audit_log
     ORDER BY timestamp DESC
     LIMIT ?`
  ).all(limit);
}

module.exports = { logAction, getRecentLog };
