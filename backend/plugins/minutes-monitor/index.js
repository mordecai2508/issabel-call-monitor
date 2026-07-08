'use strict';

/**
 * Plugin minutes-monitor (feature #55) — monitor de minutos mensuales con
 * umbrales, sobre la infraestructura de plugins de #54. Job periódico que
 * mide el consumo del mes en curso directamente en MySQL (solo lectura),
 * estado enriquecido en memoria, endpoints bajo /api/plugins/minutes-monitor
 * y eventos SSE namespaced `plugin:minutes-monitor:update`.
 */

const express = require('express');

const { loadConfig, saveConfig, validateConfig } = require('./minutesConfig');
const { monthRange, queryMonth } = require('./minutesQuery');
const { enrich } = require('./minutesEnrich');
const { getChannelAliases } = require('../../services/configService');

const MAX_HISTORY = 100;

// Estado en memoria del módulo (singleton por proceso), compartido entre
// init, router y el job (§2 del design). Se reinicia en cada init(ctx).
const state = {
  estado: null,     // último estado enriquecido
  historial: [],    // mediciones del mes en curso (tope MAX_HISTORY)
  mesActual: null,  // 'YYYY-MM' del historial
};

/**
 * Ejecuta una medición completa: query → enrich → historial → broadcast
 * (R2–R6, R9–R21). Errores de MySQL: log + estado previo intacto, sin
 * evento ni entrada de historial (R7).
 *
 * @param {object} ctx contexto del plugin manager (#54)
 */
async function runMeasurement(ctx) {
  try {
    const config = loadConfig(ctx.db, ctx.logger);
    const range  = monthRange(ctx.config?.db?.timezone);
    const raw    = await queryMonth(ctx.pool, range, config.extensiones);
    const estado = enrich(raw, config, getChannelAliases(ctx.db));

    if (raw.mes !== state.mesActual) {           // R20: reset por cambio de mes
      state.historial = [];
      state.mesActual = raw.mes;
    }

    state.historial.push({
      timestamp:         estado.timestamp,
      minutosConsumidos: estado.minutosConsumidos,
      baseComparacion:   estado.baseComparacion,
      porcentajeUso:     estado.porcentajeUso,
      nivelAlerta:       estado.nivelAlerta,
    });
    if (state.historial.length > MAX_HISTORY) state.historial.shift(); // R19

    state.estado = estado;
    ctx.broadcast('update', { estado, historial: state.historial });   // R21
  } catch (err) {
    ctx.logger.error('medición falló:', err.message);                 // R7
  }
}

module.exports = {
  manifest: {
    name:    'minutes-monitor',
    title:   'Monitor de minutos',
    version: '1.0.0',
    hasView: true,
  },

  /**
   * init(ctx): corre UNA vez en el arranque (habilitado o no). Carga la
   * config persistida para ajustar el intervalo del job ANTES de que el
   * manager lea `jobs` (fases 4 y 5 de pluginManagerService.init(), §8)
   * y reinicia el estado en memoria.
   */
  async init(ctx) {
    state.estado    = null;
    state.historial = [];
    state.mesActual = null;

    const config = loadConfig(ctx.db, ctx.logger);
    // El manager vuelve a aplicar el floor de 60 s (MIN_JOB_INTERVAL_MS).
    module.exports.jobs[0].intervalMs = Math.max(60_000, config.intervaloMinutos * 60_000);
  },

  /**
   * router(ctx): rutas RELATIVAS montadas por el manager bajo
   * /api/plugins/minutes-monitor con requireAuth + gate enabled (§7).
   */
  router(ctx) {
    const router = express.Router();

    // Check de rol espejo de requireAdmin de server.js (el ctx de #54 no lo
    // expone). requireAuth del manager ya garantiza req.session.user (R28).
    function requireAdminInline(req, res, next) {
      if (req.session.user.role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Se requiere rol de administrador' });
      }
      next();
    }

    // GET /api/plugins/minutes-monitor/status (R22, R23)
    router.get('/status', (req, res) => {
      try {
        const hasData = state.estado !== null;
        res.json({
          ok: true,
          data: {
            hasData,
            estado:         state.estado,
            historial:      state.historial,
            ultimaMedicion: hasData ? state.estado.timestamp : null,
          },
        });
      } catch (err) {
        console.error('[plugin:minutes-monitor] GET /status:', err.message);
        res.status(500).json({ ok: false, error: 'Error al obtener el estado' });
      }
    });

    // GET /api/plugins/minutes-monitor/config (R24, R28)
    router.get('/config', requireAdminInline, (req, res) => {
      try {
        res.json({ ok: true, data: loadConfig(ctx.db, ctx.logger) });
      } catch (err) {
        console.error('[plugin:minutes-monitor] GET /config:', err.message);
        res.status(500).json({ ok: false, error: 'Error al obtener la configuración' });
      }
    });

    // PUT /api/plugins/minutes-monitor/config (R25, R27, R28, R29)
    router.put('/config', requireAdminInline, (req, res) => {
      try {
        const cfg = validateConfig(req.body);   // 400 atómico: nada se persiste si falla
        saveConfig(ctx.db, cfg);
        res.json({ ok: true, data: cfg });
        // Recalculo inmediato fire-and-forget post-respuesta (R29, §11):
        // el estado nuevo llega a todos los clientes por SSE.
        runMeasurement(ctx).catch(err =>
          ctx.logger.error('recálculo post-config falló:', err.message)
        );
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('[plugin:minutes-monitor] PUT /config:', err.message);
        res.status(status).json({ ok: false, error: err.message || 'Error al guardar la configuración' });
      }
    });

    return router;
  },

  jobs: [
    { name: 'measure', intervalMs: 3_600_000, run: runMeasurement },   // R1
  ],
};

module.exports.MAX_HISTORY = MAX_HISTORY;
