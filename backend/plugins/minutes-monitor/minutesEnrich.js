'use strict';

/**
 * minutesEnrich.js — enriquecimiento del estado del plugin minutes-monitor
 * (feature #55). Función PURA portada del `enrich()` de serverv3 de
 * issabel-monitor: niveles de alerta, excedentes, costos y desglose por
 * troncal/extensión (R9–R18).
 */

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Nivel/estado global por cortes porcentuales (R10–R13).
 *
 * @param {number} consumo minutos base de comparación
 * @param {number} umbral umbral global en minutos
 * @param {number} tempranaP % de alerta temprana
 * @param {number} criticaP % de alerta crítica
 * @returns {{ nivel: string, estado: string }}
 */
function nivelesGlobal(consumo, umbral, tempranaP, criticaP) {
  if (consumo >= umbral)                     return { nivel: 'CRITICO',     estado: '🔴 UMBRAL SUPERADO' };
  if (consumo >= umbral * criticaP / 100)    return { nivel: 'CRITICO',     estado: '🟠 ALERTA CRÍTICA' };
  if (consumo >= umbral * tempranaP / 100)   return { nivel: 'ADVERTENCIA', estado: '🟡 ALERTA TEMPRANA' };
  return { nivel: 'OK', estado: '🟢 NORMAL' };
}

/**
 * Estado por extensión con los mismos cortes que el global (R16).
 *
 * @returns {'SUPERADO'|'CRITICO'|'ADVERTENCIA'|'OK'}
 */
function estadoExtension(consumo, umbral, tempranaP, criticaP) {
  if (consumo >= umbral)                   return 'SUPERADO';
  if (consumo >= umbral * criticaP / 100)  return 'CRITICO';
  if (consumo >= umbral * tempranaP / 100) return 'ADVERTENCIA';
  return 'OK';
}

/**
 * Enriquece la medición cruda con estado global y desgloses (§5 del design).
 *
 * @param {object} raw resultado de queryMonth()
 * @param {object} config config del plugin (minutesConfig)
 * @param {Record<string, string>} [channelAliases] aliases de troncales (R18)
 * @returns {object} estado enriquecido (payload de /status y del evento SSE)
 */
function enrich(raw, config, channelAliases = {}) {
  const extensiones = config.extensiones.map((ext) => {
    const fila = raw.extensionesRaw.find(r => r.extension === ext.numero)
      || { minutos: 0, llamadas: 0 };                                   // R17
    const umbralEfectivo = ext.umbral != null ? ext.umbral : config.umbralMinutos; // R15
    return {
      numero:   ext.numero,
      nombre:   ext.nombre || '',
      minutos:  fila.minutos,
      llamadas: fila.llamadas,
      umbral:   umbralEfectivo,
      esUmbralPropio: ext.umbral != null,
      porcentaje: round1(fila.minutos / umbralEfectivo * 100),
      excedente:  Math.max(0, round2(fila.minutos - umbralEfectivo)),
      estado: estadoExtension(fila.minutos, umbralEfectivo, config.alertaTempranaP, config.alertaCriticaP), // R16
      promMinPorLlamada: fila.llamadas > 0 ? round2(fila.minutos / fila.llamadas) : 0,
    };
  });

  const baseComparacion = config.umbralSoloExtensiones
    ? round2(extensiones.reduce((s, e) => s + e.minutos, 0))            // R14
    : raw.total.minutos;

  const { nivel, estado } = nivelesGlobal(
    baseComparacion, config.umbralMinutos, config.alertaTempranaP, config.alertaCriticaP
  );

  const excedente = Math.max(0, round2(baseComparacion - config.umbralMinutos)); // R9

  return {
    timestamp: raw.timestamp,
    mes: raw.mes,
    nivelAlerta: nivel,
    estadoAlerta: estado,
    minutosConsumidos: raw.total.minutos,
    llamadas: raw.total.llamadas,
    baseComparacion,
    baseEsExtensiones: Boolean(config.umbralSoloExtensiones),
    umbralMinutos: config.umbralMinutos,
    porcentajeUso: round1(baseComparacion / config.umbralMinutos * 100),
    minutosRestantes: Math.max(0, round2(config.umbralMinutos - baseComparacion)),
    excedente,
    costoExcedente: round2(excedente * config.costoMinutoExtra),
    moneda: config.moneda,
    promMinPorLlamada: raw.total.llamadas > 0 ? round2(raw.total.minutos / raw.total.llamadas) : 0,
    alertaTempranaP: config.alertaTempranaP,
    alertaCriticaP: config.alertaCriticaP,
    troncales: raw.troncales.map(t => ({
      troncal:  t.troncal,
      alias:    channelAliases[t.troncal] || null,                      // R18
      minutos:  t.minutos,
      llamadas: t.llamadas,
      promMinPorLlamada: t.llamadas > 0 ? round2(t.minutos / t.llamadas) : 0,
    })),
    extensiones,
  };
}

module.exports = { enrich, nivelesGlobal, estadoExtension };
