'use strict';

/**
 * minutesConfig.js — configuración del plugin minutes-monitor (feature #55).
 * Defaults, load/save en la tabla `system_config` (SQLite) bajo la clave
 * `plugin:minutes-monitor:config` y validación pura del PUT (R24–R27).
 */

const { getConfigValue, setConfigValue } = require('../../services/configService');

const CONFIG_KEY = 'plugin:minutes-monitor:config';

const EXT_NUMERO_RE = /^[0-9]{1,20}$/;
const MAX_MONEDA_LEN = 8;
const MAX_NOMBRE_LEN = 60;

// Defaults (R26)
const DEFAULT_CONFIG = {
  umbralMinutos:         70000,  // umbral global mensual (minutos)
  alertaTempranaP:       85,     // % del umbral para 🟡
  alertaCriticaP:        95,     // % del umbral para 🟠
  costoMinutoExtra:      0,      // costo por minuto excedente
  moneda:                'COP',
  extensiones:           [],     // [{ numero, nombre, umbral: null|number }]
  umbralSoloExtensiones: false,
  intervaloMinutos:      60,     // intervalo del job
};

/**
 * Devuelve una copia fresca de los defaults (sin arrays compartidos).
 */
function defaults() {
  return { ...DEFAULT_CONFIG, extensiones: [] };
}

/**
 * Carga la config persistida y la mergea con los defaults.
 * Campos desconocidos se descartan; JSON corrupto → defaults + warn (R26).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ warn: Function }} [logger]
 * @returns {typeof DEFAULT_CONFIG}
 */
function loadConfig(db, logger) {
  const raw = getConfigValue(db, CONFIG_KEY, null);
  if (!raw) return defaults();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger?.warn?.(`config JSON corrupta bajo "${CONFIG_KEY}"; usando defaults`);
    return defaults();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger?.warn?.(`config inválida bajo "${CONFIG_KEY}"; usando defaults`);
    return defaults();
  }

  const cfg = defaults();
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (parsed[key] !== undefined) cfg[key] = parsed[key];
  }
  return cfg;
}

/**
 * Persiste la config completa como JSON en system_config (R25).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {typeof DEFAULT_CONFIG} cfg
 */
function saveConfig(db, cfg) {
  setConfigValue(db, CONFIG_KEY, JSON.stringify(cfg));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Valida el body del PUT /config (reemplazo completo, R27). Pura.
 * Lanza `{ status: 400, message }` en el primer campo inválido;
 * devuelve la config normalizada lista para persistir.
 *
 * @param {*} body
 * @returns {typeof DEFAULT_CONFIG}
 * @throws {{ status: number, message: string }}
 */
function validateConfig(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw { status: 400, message: 'El cuerpo debe ser un objeto de configuración completo' };
  }

  const {
    umbralMinutos, alertaTempranaP, alertaCriticaP, costoMinutoExtra,
    moneda, extensiones, umbralSoloExtensiones, intervaloMinutos,
  } = body;

  if (!isFiniteNumber(umbralMinutos) || umbralMinutos <= 0) {
    throw { status: 400, message: 'umbralMinutos debe ser un número mayor que 0' };
  }
  if (!isFiniteNumber(alertaTempranaP) || alertaTempranaP < 0 || alertaTempranaP > 100) {
    throw { status: 400, message: 'alertaTempranaP debe ser un número entre 0 y 100' };
  }
  if (!isFiniteNumber(alertaCriticaP) || alertaCriticaP < 0 || alertaCriticaP > 100) {
    throw { status: 400, message: 'alertaCriticaP debe ser un número entre 0 y 100' };
  }
  if (alertaTempranaP >= alertaCriticaP) {
    throw { status: 400, message: 'alertaTempranaP debe ser menor que alertaCriticaP' };
  }
  if (!isFiniteNumber(costoMinutoExtra) || costoMinutoExtra < 0) {
    throw { status: 400, message: 'costoMinutoExtra debe ser un número mayor o igual a 0' };
  }
  if (typeof moneda !== 'string' || !moneda.trim() || moneda.trim().length > MAX_MONEDA_LEN) {
    throw { status: 400, message: `moneda debe ser un texto no vacío de hasta ${MAX_MONEDA_LEN} caracteres` };
  }
  if (!Array.isArray(extensiones)) {
    throw { status: 400, message: 'extensiones debe ser un array' };
  }

  const numerosVistos = new Set();
  const extensionesNorm = extensiones.map((ext) => {
    if (!ext || typeof ext !== 'object' || Array.isArray(ext)) {
      throw { status: 400, message: 'Cada extensión debe ser un objeto { numero, nombre, umbral }' };
    }
    if (typeof ext.numero !== 'string' || !EXT_NUMERO_RE.test(ext.numero)) {
      throw { status: 400, message: 'Cada extensión debe tener un numero numérico (1 a 20 dígitos)' };
    }
    if (numerosVistos.has(ext.numero)) {
      throw { status: 400, message: `Extensión duplicada: ${ext.numero}` };
    }
    numerosVistos.add(ext.numero);

    const nombre = ext.nombre === undefined ? '' : ext.nombre;
    if (typeof nombre !== 'string' || nombre.length > MAX_NOMBRE_LEN) {
      throw { status: 400, message: `El nombre de la extensión debe ser un texto de hasta ${MAX_NOMBRE_LEN} caracteres` };
    }

    const umbral = ext.umbral === undefined ? null : ext.umbral;
    if (umbral !== null && (!isFiniteNumber(umbral) || umbral <= 0)) {
      throw { status: 400, message: 'El umbral de la extensión debe ser null o un número mayor que 0' };
    }

    return { numero: ext.numero, nombre, umbral };
  });

  if (typeof umbralSoloExtensiones !== 'boolean') {
    throw { status: 400, message: 'umbralSoloExtensiones debe ser booleano' };
  }
  if (!isFiniteNumber(intervaloMinutos) || !Number.isInteger(intervaloMinutos) || intervaloMinutos < 1) {
    throw { status: 400, message: 'intervaloMinutos debe ser un entero mayor o igual a 1' };
  }

  return {
    umbralMinutos,
    alertaTempranaP,
    alertaCriticaP,
    costoMinutoExtra,
    moneda: moneda.trim(),
    extensiones: extensionesNorm,
    umbralSoloExtensiones,
    intervaloMinutos,
  };
}

module.exports = { CONFIG_KEY, DEFAULT_CONFIG, loadConfig, saveConfig, validateConfig };
