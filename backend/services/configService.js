'use strict';

const TIMEZONE_RE = /^[+-]\d{2}:\d{2}$/;
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SUPPORTED_LANGUAGES = ['es', 'en'];

const DEFAULT_THEME_PRIMARY = '#3b82f6';
const DEFAULT_THEME_ACCENT = '#1e3a5f';
const DEFAULT_LANGUAGE = 'es';

/**
 * Read a single key from the `system_config` key-value table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {*} [fallback]
 * @returns {string|null|*}
 */
function getConfigValue(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM system_config WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

/**
 * Upsert a single key in the `system_config` key-value table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {string} value
 */
function setConfigValue(db, key, value) {
  db.prepare(
    `INSERT INTO system_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

/**
 * Build the general configuration object exposed by GET /api/admin/config,
 * applying defaults/fallbacks per requirements R1-R3.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ fallbackAppName: string, fallbackTimezone: string }} fallbacks
 * @returns {{
 *   companyName: string,
 *   timezone: string,
 *   language: string,
 *   themeColors: { primary: string, accent: string },
 *   logoPath: string|null,
 * }}
 */
function getGeneralConfig(db, { fallbackAppName, fallbackTimezone }) {
  return {
    companyName: getConfigValue(db, 'companyName', fallbackAppName) || fallbackAppName,
    timezone: getConfigValue(db, 'timezone', fallbackTimezone) || fallbackTimezone,
    language: getConfigValue(db, 'language', DEFAULT_LANGUAGE) || DEFAULT_LANGUAGE,
    themeColors: {
      primary: getConfigValue(db, 'themeColorPrimary', DEFAULT_THEME_PRIMARY),
      accent: getConfigValue(db, 'themeColorAccent', DEFAULT_THEME_ACCENT),
    },
    logoPath: getLogoPath(db),
    subcompanyName: getConfigValue(db, 'subcompanyName', '') || '',
  };
}

/**
 * Validate and persist the provided general-config fields (R4-R10).
 * Validation happens for ALL provided fields BEFORE anything is persisted
 * (atomic at the validation level): if any field is invalid, throws
 * `{ status: 400, message: '...' }` and writes nothing.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ companyName?: string, timezone?: string, language?: string,
 *           themeColors?: { primary?: string, accent?: string } }} fields
 * @throws {{ status: number, message: string }}
 */
function updateGeneralConfig(db, fields) {
  const { companyName, timezone, language, themeColors, subcompanyName } = fields || {};

  // ── Validate everything first (no partial writes on error) ──────
  if (companyName !== undefined) {
    if (typeof companyName !== 'string' || !companyName.trim()) {
      throw { status: 400, message: 'El campo companyName debe ser una cadena no vacía' };
    }
  }

  if (timezone !== undefined) {
    if (typeof timezone !== 'string' || !TIMEZONE_RE.test(timezone)) {
      throw { status: 400, message: 'El campo timezone debe tener el formato ±HH:MM (ej. -05:00)' };
    }
  }

  if (language !== undefined) {
    if (typeof language !== 'string' || !SUPPORTED_LANGUAGES.includes(language)) {
      throw { status: 400, message: `El campo language debe ser uno de: ${SUPPORTED_LANGUAGES.join(', ')}` };
    }
  }

  if (themeColors !== undefined) {
    if (typeof themeColors !== 'object' || themeColors === null) {
      throw { status: 400, message: 'El campo themeColors debe ser un objeto con primary y accent' };
    }
    const { primary, accent } = themeColors;
    if (primary !== undefined && (typeof primary !== 'string' || !HEX_COLOR_RE.test(primary))) {
      throw { status: 400, message: 'El campo themeColors.primary debe ser un color hexadecimal válido (#RGB o #RRGGBB)' };
    }
    if (accent !== undefined && (typeof accent !== 'string' || !HEX_COLOR_RE.test(accent))) {
      throw { status: 400, message: 'El campo themeColors.accent debe ser un color hexadecimal válido (#RGB o #RRGGBB)' };
    }
  }

  if (subcompanyName !== undefined) {
    if (typeof subcompanyName !== 'string' || subcompanyName.length > 100) {
      throw { status: 400, message: 'subcompanyName debe ser una cadena de hasta 100 caracteres' };
    }
  }

  // ── Persist only the provided fields ─────────────────────────────
  if (companyName !== undefined) {
    setConfigValue(db, 'companyName', companyName.trim());
  }
  if (timezone !== undefined) {
    setConfigValue(db, 'timezone', timezone);
  }
  if (language !== undefined) {
    setConfigValue(db, 'language', language);
  }
  if (themeColors !== undefined) {
    if (themeColors.primary !== undefined) {
      setConfigValue(db, 'themeColorPrimary', themeColors.primary);
    }
    if (themeColors.accent !== undefined) {
      setConfigValue(db, 'themeColorAccent', themeColors.accent);
    }
  }
  if (subcompanyName !== undefined) {
    setConfigValue(db, 'subcompanyName', subcompanyName.trim());
  }
}

/**
 * Persist the absolute filesystem path of the current logo.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} absolutePath
 */
function setLogoPath(db, absolutePath) {
  setConfigValue(db, 'logoPath', absolutePath);
}

/**
 * Read the absolute filesystem path of the current logo (or null).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string|null}
 */
function getLogoPath(db) {
  return getConfigValue(db, 'logoPath', null);
}

/**
 * Remove the persisted logo path reference (does not touch the filesystem).
 *
 * @param {import('better-sqlite3').Database} db
 */
function clearLogoPath(db) {
  db.prepare('DELETE FROM system_config WHERE key = ?').run('logoPath');
}

/**
 * Create/update/delete the per-extension override row, applying R26:
 * if the resulting row would have `display_name IS NULL/'' AND hidden = 0`,
 * the row is deleted instead of being persisted.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} extension
 * @param {{ displayName?: string, hidden?: boolean }} fields
 * @returns {{ extension: string, displayName: string|null, hidden: boolean }}
 */
function upsertExtensionOverride(db, extension, { displayName, hidden }) {
  const existing = db.prepare(
    'SELECT extension, display_name, hidden FROM extensions_config WHERE extension = ?'
  ).get(extension);

  let nextDisplayName = existing ? existing.display_name : null;
  let nextHidden = existing ? existing.hidden : 0;

  if (displayName !== undefined) {
    nextDisplayName = displayName.trim() === '' ? null : displayName;
  }
  if (hidden !== undefined) {
    nextHidden = hidden ? 1 : 0;
  }

  const isEmpty = (nextDisplayName === null || nextDisplayName === '') && nextHidden === 0;

  if (isEmpty) {
    db.prepare('DELETE FROM extensions_config WHERE extension = ?').run(extension);
    return { extension, displayName: null, hidden: false };
  }

  db.prepare(
    `INSERT INTO extensions_config (extension, display_name, hidden) VALUES (?, ?, ?)
     ON CONFLICT(extension) DO UPDATE SET display_name = excluded.display_name, hidden = excluded.hidden`
  ).run(extension, nextDisplayName, nextHidden);

  return { extension, displayName: nextDisplayName, hidden: !!nextHidden };
}

/**
 * Fetch overrides for a list of extensions (used to enrich rankings).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} extensions
 * @returns {Map<string, { displayName: string|null, hidden: boolean }>}
 */
function getExtensionOverrides(db, extensions) {
  const map = new Map();
  if (!Array.isArray(extensions) || extensions.length === 0) return map;

  const placeholders = extensions.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT extension, display_name, hidden FROM extensions_config WHERE extension IN (${placeholders})`
  ).all(...extensions);

  for (const row of rows) {
    map.set(row.extension, { displayName: row.display_name, hidden: !!row.hidden });
  }
  return map;
}

/**
 * Set/clear the visibility override for a trunk, applying R31:
 * `hidden = false` removes the row entirely (no row with hidden = 0 is stored).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} trunk
 * @param {boolean} hidden
 * @returns {{ trunk: string, hidden: boolean }}
 */
function upsertTrunkOverride(db, trunk, hidden) {
  if (hidden) {
    db.prepare('INSERT OR REPLACE INTO trunks_config (trunk, hidden) VALUES (?, 1)').run(trunk);
    return { trunk, hidden: true };
  }
  db.prepare('DELETE FROM trunks_config WHERE trunk = ?').run(trunk);
  return { trunk, hidden: false };
}

/**
 * Fetch visibility overrides for a list of trunks (used to enrich rankings).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} trunks
 * @returns {Map<string, boolean>}
 */
function getTrunkOverrides(db, trunks) {
  const map = new Map();
  if (!Array.isArray(trunks) || trunks.length === 0) return map;

  const placeholders = trunks.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT trunk, hidden FROM trunks_config WHERE trunk IN (${placeholders})`
  ).all(...trunks);

  for (const row of rows) {
    map.set(row.trunk, !!row.hidden);
  }
  return map;
}

/**
 * Read the business_hours config as a parsed object, or null if not set.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ days: number[], start: string, end: string }|null}
 */
function getBusinessHours(db) {
  const raw = getConfigValue(db, 'business_hours', null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Persist or clear the business_hours config.
 * Pass null to remove it.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ days: number[], start: string, end: string }|null} value
 */
function setBusinessHours(db, value) {
  if (value === null) {
    db.prepare('DELETE FROM system_config WHERE key = ?').run('business_hours');
  } else {
    setConfigValue(db, 'business_hours', JSON.stringify(value));
  }
}

/**
 * Read all channel aliases stored in SQLite.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Record<string, string>}
 */
function getChannelAliases(db) {
  const raw = getConfigValue(db, 'channel_aliases', null);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Set or clear a single channel alias in SQLite.
 * Passing an empty/blank alias removes the entry.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} channel
 * @param {string} alias
 */
function setChannelAlias(db, channel, alias) {
  const aliases = getChannelAliases(db);
  if (alias && alias.trim()) {
    aliases[channel] = alias.trim();
  } else {
    delete aliases[channel];
  }
  setConfigValue(db, 'channel_aliases', JSON.stringify(aliases));
}

/**
 * Read all queue aliases stored in SQLite.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Record<string, string>}
 */
function getQueueAliases(db) {
  const raw = getConfigValue(db, 'queue_aliases', null);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Set or clear a single queue alias in SQLite.
 * Passing an empty/blank alias removes the entry.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} queue
 * @param {string} alias
 */
function setQueueAlias(db, queue, alias) {
  const aliases = getQueueAliases(db);
  if (alias && alias.trim()) {
    aliases[queue] = alias.trim();
  } else {
    delete aliases[queue];
  }
  setConfigValue(db, 'queue_aliases', JSON.stringify(aliases));
}

module.exports = {
  getConfigValue,
  setConfigValue,
  getGeneralConfig,
  updateGeneralConfig,
  setLogoPath,
  getLogoPath,
  clearLogoPath,
  upsertExtensionOverride,
  getExtensionOverrides,
  upsertTrunkOverride,
  getTrunkOverrides,
  getBusinessHours,
  setBusinessHours,
  getChannelAliases,
  setChannelAlias,
  getQueueAliases,
  setQueueAlias,
};
