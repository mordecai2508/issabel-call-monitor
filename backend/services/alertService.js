'use strict';

const VALID_TYPES = ['trunk_down', 'ext_unreachable', 'lost_spike', 'pbx_disconnect'];
const TYPES_REQUIRING_THRESHOLD = ['lost_spike', 'trunk_down'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_INTERVAL_MS = 30_000;
const LOST_SPIKE_WINDOW_MINUTES = 60;

// ── Helpers de fecha (zona local del servidor) ────────────────────
// Copia local idéntica a la de server.js (design.md §6.5) — server.js no
// exporta `toMySQLDate` y no se modifica su estructura.
function toMySQLDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── Etiquetas legibles por tipo (usadas en descripciones/correos) ──
const TYPE_LABELS = {
  trunk_down: 'Troncal fuera de servicio',
  ext_unreachable: 'Extensión sin registrar',
  lost_spike: 'Pico de llamadas perdidas',
  pbx_disconnect: 'PBX desconectado',
};

/**
 * Map a raw `alert_rules` row to the API/JS shape (booleans, etc.).
 * @param {object} row
 * @returns {object}
 */
function mapRule(row) {
  return {
    id: row.id,
    type: row.type,
    threshold: row.threshold === null || row.threshold === undefined ? null : Number(row.threshold),
    enabled: row.enabled === 1,
    notify_email: row.notify_email || null,
  };
}

/**
 * Map a raw `alerts` row to the API/JS shape (booleans, etc.).
 * @param {object} row
 * @returns {object}
 */
function mapAlert(row) {
  return {
    id: row.id,
    rule_id: row.rule_id,
    type: row.type,
    description: row.description,
    created_at: row.created_at,
    resolved: row.resolved === 1,
    resolved_at: row.resolved_at || null,
  };
}

/**
 * Validate the `type`/`threshold`/`notify_email` fields for create/update
 * (R4-R6). Throws `{ status: 400, message }` on the first invalid field.
 *
 * @param {{ type?: string, threshold?: any, notify_email?: any }} fields
 * @param {{ requireType: boolean, effectiveType: string|undefined }} ctx
 */
function validateRuleFields({ type, threshold, notify_email }, { requireType, effectiveType }) {
  // R4 — type must be one of the valid values (only checked when provided).
  if (requireType) {
    if (typeof type !== 'string' || !VALID_TYPES.includes(type)) {
      const err = new Error(`El campo type debe ser uno de: ${VALID_TYPES.join(', ')}`);
      err.status = 400;
      throw err;
    }
  } else if (type !== undefined && !VALID_TYPES.includes(type)) {
    const err = new Error(`El campo type debe ser uno de: ${VALID_TYPES.join(', ')}`);
    err.status = 400;
    throw err;
  }

  // R5 — threshold required and numeric >= 0 for lost_spike/trunk_down.
  if (TYPES_REQUIRING_THRESHOLD.includes(effectiveType)) {
    if (threshold !== undefined) {
      if (typeof threshold !== 'number' || Number.isNaN(threshold) || threshold < 0) {
        const err = new Error('El campo threshold debe ser un número mayor o igual a 0');
        err.status = 400;
        throw err;
      }
    }
  }

  // R6 — notify_email, if non-empty, must look like an e-mail address.
  if (notify_email !== undefined && notify_email !== null && notify_email !== '') {
    if (typeof notify_email !== 'string' || !EMAIL_RE.test(notify_email)) {
      const err = new Error('El campo notify_email debe ser una dirección de correo válida');
      err.status = 400;
      throw err;
    }
  }
}

/**
 * Factory for the alert evaluation/notification service (feature #15 —
 * alerts_monitoring).
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} config
 * @param {import('better-sqlite3').Database} db
 * @param {(event: string, data: any) => void} broadcast
 * @param {ReturnType<typeof import('./pbxHealthService')>} pbxHealthService
 * @param {ReturnType<typeof import('./mailService')>} mailService
 * @param {{ windowMinutes?: number }} [options]
 * @returns {{
 *   listRules: () => object[],
 *   createRule: (fields: object) => object,
 *   updateRule: (id: number|string, fields: object) => object,
 *   deleteRule: (id: number|string) => { id: number },
 *   getActiveAlerts: () => object[],
 *   resolveAlert: (id: number|string) => object,
 *   evaluateOnce: () => Promise<void>,
 *   start: (intervalMs?: number) => () => void,
 * }}
 */
module.exports = function createAlertService(pool, config, db, broadcast, pbxHealthService, mailService, amiExtensionsService, options = {}) {
  const windowMinutes = options.windowMinutes || LOST_SPIKE_WINDOW_MINUTES;

  // ── CRUD de reglas (R1-R9) ───────────────────────────────────────

  function listRules() {
    const rows = db.prepare(
      'SELECT id, type, threshold, enabled, notify_email FROM alert_rules ORDER BY id'
    ).all();
    return rows.map(mapRule);
  }

  function createRule(fields) {
    const { type, threshold, enabled, notify_email } = fields || {};

    validateRuleFields({ type, threshold, notify_email }, { requireType: true, effectiveType: type });

    if (TYPES_REQUIRING_THRESHOLD.includes(type) && (threshold === undefined || threshold === null)) {
      const err = new Error('El campo threshold es requerido para este tipo de regla');
      err.status = 400;
      throw err;
    }

    const enabledValue = enabled === undefined ? 1 : (enabled ? 1 : 0);
    const thresholdValue = threshold === undefined ? null : threshold;
    const notifyEmailValue = (notify_email === undefined || notify_email === null || notify_email === '')
      ? null
      : notify_email;

    const result = db.prepare(
      `INSERT INTO alert_rules (type, threshold, enabled, notify_email)
       VALUES (?, ?, ?, ?)`
    ).run(type, thresholdValue, enabledValue, notifyEmailValue);

    return mapRule(db.prepare(
      'SELECT id, type, threshold, enabled, notify_email FROM alert_rules WHERE id = ?'
    ).get(result.lastInsertRowid));
  }

  function updateRule(id, fields) {
    const existing = db.prepare(
      'SELECT id, type, threshold, enabled, notify_email FROM alert_rules WHERE id = ?'
    ).get(id);

    if (!existing) {
      const err = new Error('Regla de alerta no encontrada');
      err.status = 404;
      throw err;
    }

    const { threshold, enabled, notify_email } = fields || {};

    validateRuleFields({ threshold, notify_email }, { requireType: false, effectiveType: existing.type });

    if (TYPES_REQUIRING_THRESHOLD.includes(existing.type) && threshold === null) {
      const err = new Error('El campo threshold es requerido para este tipo de regla');
      err.status = 400;
      throw err;
    }

    const newThreshold = threshold === undefined ? existing.threshold : threshold;
    const newEnabled = enabled === undefined ? existing.enabled : (enabled ? 1 : 0);
    const newNotifyEmail = notify_email === undefined
      ? existing.notify_email
      : (notify_email === null || notify_email === '' ? null : notify_email);

    db.prepare(
      `UPDATE alert_rules SET threshold = ?, enabled = ?, notify_email = ? WHERE id = ?`
    ).run(newThreshold, newEnabled, newNotifyEmail, id);

    return mapRule(db.prepare(
      'SELECT id, type, threshold, enabled, notify_email FROM alert_rules WHERE id = ?'
    ).get(id));
  }

  function deleteRule(id) {
    const existing = db.prepare('SELECT id FROM alert_rules WHERE id = ?').get(id);
    if (!existing) {
      const err = new Error('Regla de alerta no encontrada');
      err.status = 404;
      throw err;
    }

    db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
    // R9 — alertas históricas (alerts.rule_id) se conservan, no se borran.
    return { id: existing.id };
  }

  // ── Consulta y resolución de alertas activas (R29-R33) ───────────

  function getActiveAlerts() {
    const rows = db.prepare(
      `SELECT id, rule_id, type, description, resolved, created_at, resolved_at
       FROM alerts
       WHERE resolved = 0
       ORDER BY created_at DESC`
    ).all();
    return rows.map(mapAlert);
  }

  function resolveAlert(id) {
    const existing = db.prepare(
      'SELECT id, rule_id, type, description, resolved, created_at, resolved_at FROM alerts WHERE id = ?'
    ).get(id);

    if (!existing) {
      const err = new Error('Alerta no encontrada');
      err.status = 404;
      throw err;
    }

    if (existing.resolved === 1) {
      const err = new Error('La alerta ya fue resuelta');
      err.status = 409;
      throw err;
    }

    const resolvedAt = new Date().toISOString();
    db.prepare('UPDATE alerts SET resolved = 1, resolved_at = ? WHERE id = ?').run(resolvedAt, id);

    return mapAlert(db.prepare(
      'SELECT id, rule_id, type, description, resolved, created_at, resolved_at FROM alerts WHERE id = ?'
    ).get(id));
  }

  // ── Creación interna de alertas (R14/R15/R25-R28) ────────────────

  /**
   * Returns true if there is already an unresolved alert for `ruleId`.
   * @param {number} ruleId
   * @returns {boolean}
   */
  function hasUnresolvedAlert(ruleId) {
    const row = db.prepare(
      'SELECT id FROM alerts WHERE rule_id = ? AND resolved = 0 LIMIT 1'
    ).get(ruleId);
    return Boolean(row);
  }

  /**
   * Persist a new alert, broadcast it (R25), and notify by e-mail if
   * configured (R26-R28). Skips creation if an unresolved alert already
   * exists for the rule (R15).
   *
   * @param {object} rule - mapped rule (`mapRule` shape)
   * @param {string} description
   * @returns {Promise<object|null>} the created alert, or null if skipped (R15)
   */
  async function createAlert(rule, description) {
    if (hasUnresolvedAlert(rule.id)) return null; // R15 — no duplicados

    const result = db.prepare(
      `INSERT INTO alerts (rule_id, type, description, resolved)
       VALUES (?, ?, ?, 0)`
    ).run(rule.id, rule.type, description);

    const alert = mapAlert(db.prepare(
      'SELECT id, rule_id, type, description, resolved, created_at, resolved_at FROM alerts WHERE id = ?'
    ).get(result.lastInsertRowid));

    // R25 — broadcast SSE
    broadcast('alert', alert);

    // R26-R28 — notificación por correo
    if (rule.notify_email) {
      try {
        await mailService.sendAlertEmail({
          to: rule.notify_email,
          subject: `[Issabel Monitor] ${TYPE_LABELS[rule.type] || rule.type}`,
          text: `${description}\n\nFecha: ${alert.created_at}`,
        });
      } catch (err) {
        // R27 — no bloquear la persistencia/broadcast por fallos de envío
        console.error('[alerts] sendAlertEmail:', err.message);
      }
    }

    return alert;
  }

  // ── Evaluación de reglas (R12-R24) ───────────────────────────────

  /**
   * Evaluate a `pbx_disconnect` rule (R18/R19, design.md §6.3).
   * @param {object} rule
   */
  async function evaluatePbxDisconnect(rule) {
    const status = pbxHealthService.getStatus();

    if (status.connected === false) {
      const description = `El PBX está desconectado (último error: ${status.lastError || 'desconocido'}, última verificación: ${status.lastCheck || 'nunca'})`;
      await createAlert(rule, description);
    } else {
      // R19 — auto-resolución cuando vuelve a estar conectado.
      const unresolved = db.prepare(
        'SELECT id FROM alerts WHERE rule_id = ? AND resolved = 0 LIMIT 1'
      ).get(rule.id);
      if (unresolved) {
        const resolvedAt = new Date().toISOString();
        db.prepare('UPDATE alerts SET resolved = 1, resolved_at = ? WHERE id = ?').run(resolvedAt, unresolved.id);
      }
    }
  }

  /**
   * Evaluate a `lost_spike` rule (R16/R17, design.md §6.4).
   * @param {object} rule
   */
  async function evaluateLostSpike(rule) {
    // R17 — si la conexión a Issabel no está disponible, omitir sin error.
    if (pbxHealthService.getStatus().connected === false) return;

    const lostDestinations = config.lostDestinations || ['s', 'hang', 'hangup'];

    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMinutes * 60_000);

    const placeholders = lostDestinations.map(() => '?').join(', ');
    const sql = `SELECT COUNT(*) AS lost_count
                 FROM cdr
                 WHERE calldate >= ? AND calldate <= ?
                   AND (disposition = 'NO ANSWER' OR dst IN (${placeholders}))`;

    const [rows] = await pool.query(sql, [
      toMySQLDate(windowStart), toMySQLDate(now), ...lostDestinations,
    ]);

    const lostCount = Number(rows?.[0]?.lost_count || 0);

    if (lostCount >= rule.threshold) {
      const description = `Se detectaron ${lostCount} llamadas perdidas en los últimos ${windowMinutes} minutos (umbral: ${rule.threshold})`;
      await createAlert(rule, description);
    }
    // lost_spike no se auto-resuelve (design.md §6.4) — requiere resolución manual.
  }

  /**
   * Evaluate a `trunk_down` rule.
   *
   * When AMI is configured and has returned at least one result, uses the
   * live SIP registration status (`up`/`down`) of each configured inbound
   * channel.  A trunk whose peer name is not yet in the AMI snapshot is
   * skipped for that cycle (avoids false positives on first boot).
   *
   * Auto-resolution: when all trunks are `up` and there is an unresolved
   * alert for this rule, it is automatically resolved.
   *
   * Fallback: when AMI is not configured, the original CDR-based heuristic
   * is used (no activity in CDR for `threshold` minutes → alert, no
   * auto-resolution).
   *
   * @param {object} rule
   */
  async function evaluateTrunkDown(rule) {
    const channels = (config.channels && config.channels.inbound) || [];
    if (channels.length === 0) return;

    const useAmi = amiExtensionsService && amiExtensionsService.isConfigured();

    if (useAmi) {
      const { available, trunks } = amiExtensionsService.getTrunksStatus();

      // Skip evaluation if AMI has not yet returned a successful snapshot.
      if (!available) return;

      let downChannel = null;
      let downRawStatus = null;

      for (const channel of channels) {
        // Strip protocol prefix (SIP/ or PJSIP/) to get the AMI peer name.
        const peerName = channel.replace(/^(?:SIP|PJSIP)\//i, '');
        const trunkInfo = trunks.find(t => t.trunk === peerName);

        // Peer not in AMI snapshot — skip (unknown state, avoid false positive).
        if (!trunkInfo) continue;

        if (trunkInfo.status === 'down') {
          downChannel    = channel;
          downRawStatus  = trunkInfo.rawStatus || 'sin respuesta';
          break;
        }
      }

      if (downChannel) {
        const description = `La troncal "${downChannel}" está fuera de servicio (estado AMI: ${downRawStatus})`;
        await createAlert(rule, description);
      } else {
        // All known trunks are up — auto-resolve any open alert for this rule.
        const unresolved = db.prepare(
          'SELECT id FROM alerts WHERE rule_id = ? AND resolved = 0 LIMIT 1'
        ).get(rule.id);
        if (unresolved) {
          db.prepare('UPDATE alerts SET resolved = 1, resolved_at = ? WHERE id = ?')
            .run(new Date().toISOString(), unresolved.id);
        }
      }
      return;
    }

    // ── CDR-based fallback (AMI not configured) ──────────────────────
    const now = new Date();
    const thresholdMs = rule.threshold * 60_000;

    for (const channel of channels) {
      const likePattern = `${channel}%`;
      const [rows] = await pool.query(
        `SELECT MAX(calldate) AS last_activity
         FROM cdr
         WHERE channel LIKE ? OR dstchannel LIKE ?`,
        [likePattern, likePattern]
      );

      const lastActivity = rows?.[0]?.last_activity;
      const lastActivityDate = lastActivity ? new Date(lastActivity) : null;
      const isDown = !lastActivityDate || (now.getTime() - lastActivityDate.getTime()) >= thresholdMs;

      if (isDown) {
        const lastActivityLabel = lastActivityDate
          ? lastActivityDate.toLocaleString()
          : 'sin actividad registrada';
        const description = `No se detectó actividad CDR para el canal "${channel}" en los últimos ${rule.threshold} minutos (última actividad: ${lastActivityLabel})`;
        await createAlert(rule, description);
        return;
      }
    }
  }

  /**
   * Run a single evaluation cycle over all enabled alert rules (R12-R24).
   * @returns {Promise<void>}
   */
  async function evaluateOnce() {
    const rules = db.prepare(
      'SELECT id, type, threshold, enabled, notify_email FROM alert_rules WHERE enabled = 1'
    ).all().map(mapRule);

    for (const rule of rules) {
      switch (rule.type) {
        case 'pbx_disconnect':
          await evaluatePbxDisconnect(rule);
          break;
        case 'lost_spike':
          await evaluateLostSpike(rule);
          break;
        case 'trunk_down':
          await evaluateTrunkDown(rule);
          break;
        case 'ext_unreachable':
          // R23/R24, design.md §6.6 — fuera de alcance de evaluación en esta
          // iteración: la regla se persiste y gestiona vía CRUD, pero nunca
          // se evalúa ni genera alertas (estado de registro SIP/PJSIP no
          // disponible sin acceso a AMI).
          break;
        default:
          break;
      }
    }
  }

  // ── Timer propio (design.md §6.2) ────────────────────────────────

  function start(intervalMs) {
    const ms = intervalMs || config.server?.pollIntervalMs || DEFAULT_INTERVAL_MS;

    const timer = setInterval(() => {
      evaluateOnce().catch(err => console.error('[alerts] evaluateOnce:', err.message));
    }, ms);

    return function stop() {
      clearInterval(timer);
    };
  }

  return {
    listRules,
    createRule,
    updateRule,
    deleteRule,
    getActiveAlerts,
    resolveAlert,
    evaluateOnce,
    start,
  };
};
