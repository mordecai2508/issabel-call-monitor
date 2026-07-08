'use strict';

/**
 * multiserver_agent_classification.test.js — feature #56 tests
 *
 * Cubre dos correcciones de clasificación detectadas al comparar exports CDR de
 * distintos servidores Issabel/Asterisk reales:
 *   1. Patrón de canal de agente ampliado a PJSIP/NNN- y Local/NNN@ (extensiones
 *      PJSIP y agentes que contestan vía cola), además de Agent/NNN y SIP/NNN-.
 *   2. La regla #21 "ANSWERED sin agente → NO ANSWER" NO se aplica a salientes
 *      (en una saliente el dstchannel es la troncal, no un agente).
 */

const {
  mapRow,
  mapOutboundRow,
  buildOutboundWhereClause,
  resolveDispositionLocal,
} = require('../services/cdrService');

const extractChannelFn = ch => ch; // identidad
const baseRow = (over) => ({
  calldate:    new Date('2026-07-03T20:00:00.000Z'),
  src:         '573138039435',
  dst:         '9002',
  channel:     'SIP/ENT_LIWA-0001',
  dstchannel:  'Agent/1001',
  duration:    60,
  billsec:     55,
  disposition: 'ANSWERED',
  ...over,
});

// ── #56.1 · Patrones de canal de agente (entrantes) ─────────────────────────

describe('#56 · mapRow reconoce nuevos canales de agente', () => {
  // Con lostDests no vacío se activa la reclasificación (guarda de mapRow).
  const lostDests = ['ivr-colgado'];

  test.each([
    ['Agent/1001',                       'ANSWERED'],  // patrón histórico
    ['SIP/201-000008db',                 'ANSWERED'],  // patrón histórico
    ['PJSIP/2016-0002b4f7',              'ANSWERED'],  // #56: extensión PJSIP
    ['Local/105@from-queue-0000398f;1',  'ANSWERED'],  // #56: agente vía cola
  ])('ANSWERED con dstchannel %s → %s', (dstchannel, expected) => {
    const result = mapRow(baseRow({ dstchannel }), extractChannelFn, lostDests, '+00:00');
    expect(result.disposition).toBe(expected);
  });

  test('ANSWERED sin dstchannel de agente sigue reclasificándose a NO ANSWER', () => {
    const result = mapRow(baseRow({ dstchannel: '' }), extractChannelFn, lostDests, '+00:00');
    expect(result.disposition).toBe('NO ANSWER');
  });

  test('un dstchannel de troncal (no agente) en entrante → NO ANSWER', () => {
    const result = mapRow(
      baseRow({ dstchannel: 'SIP/ORO-IBA-SAL-BEST-0002ab56' }),
      extractChannelFn, lostDests, '+00:00'
    );
    expect(result.disposition).toBe('NO ANSWER');
  });
});

// ── #56.1 · resolveDispositionLocal con applyAgentRule ──────────────────────

describe('#56 · resolveDispositionLocal respeta applyAgentRule', () => {
  test('PJSIP y Local cuentan como agente (applyAgentRule=true, default)', () => {
    expect(resolveDispositionLocal('ANSWERED', '9002', 'PJSIP/2016-0002b4f7', [])).toBe('ANSWERED');
    expect(resolveDispositionLocal('ANSWERED', '9002', 'Local/105@from-queue-1;1', [])).toBe('ANSWERED');
  });

  test('applyAgentRule=false conserva ANSWERED aunque el dstchannel no sea agente', () => {
    expect(
      resolveDispositionLocal('ANSWERED', '3142291010', 'SIP/ORO-IBA-SAL-BEST-0002ab56', [], false)
    ).toBe('ANSWERED');
  });

  test('applyAgentRule=false mantiene la reclasificación por lostDestinations y BUSY', () => {
    expect(resolveDispositionLocal('ANSWERED', 'ivr', 'SIP/tronco-1', ['ivr'], false)).toBe('NO ANSWER');
    expect(resolveDispositionLocal('BUSY', '3001', 'SIP/tronco-1', [], false)).toBe('NO ANSWER');
  });
});

// ── #56.2 · Salientes no aplican la regla de agente ─────────────────────────

describe('#56 · mapOutboundRow preserva ANSWERED en salientes', () => {
  const lostDests = ['ivr-colgado']; // activa la rama de reclasificación

  test('saliente contestada con dstchannel de troncal → ANSWERED (no NO ANSWER)', () => {
    const row = {
      calldate:    new Date('2026-07-03T20:00:00.000Z'),
      src:         '2016',
      dst:         '3142291010',
      channel:     'PJSIP/2016-0002b4f7',
      dstchannel:  'SIP/ORO-IBA-SAL-BEST-0002ab56',
      duration:    35,
      billsec:     35,
      disposition: 'ANSWERED',
    };
    const result = mapOutboundRow(row, extractChannelFn, lostDests, '+00:00');
    expect(result.disposition).toBe('ANSWERED');
  });

  test('saliente BUSY sigue contando como NO ANSWER', () => {
    const row = {
      calldate:    new Date('2026-07-03T20:00:00.000Z'),
      src:         '2016',
      dst:         '3142291010',
      channel:     'PJSIP/2016-0002b4f7',
      dstchannel:  'SIP/ORO-IBA-SAL-BEST-0002ab56',
      duration:    0,
      billsec:     0,
      disposition: 'BUSY',
    };
    const result = mapOutboundRow(row, extractChannelFn, lostDests, '+00:00');
    expect(result.disposition).toBe('NO ANSWER');
  });
});

// ── #56.2 · El filtro SQL de salientes no exige REGEXP de agente ─────────────

describe('#56 · buildOutboundWhereClause sin REGEXP de agente', () => {
  const filters = { from: '2026-07-01', to: '2026-07-03' };
  const channels = ['PJSIP/2016'];

  test('filtro ANSWERED con lostDestinations no incluye dstchannel REGEXP', () => {
    const { conditions, params } = buildOutboundWhereClause(
      { ...filters, disposition: 'ANSWERED' }, channels, ['ivr-colgado']
    );
    const sql = conditions.join(' AND ');
    expect(sql).not.toMatch(/REGEXP/);
    expect(params).not.toContain('^(Agent/[0-9]+|SIP/[0-9]+-|PJSIP/[0-9]+-|Local/[0-9]+@)');
    // sigue excluyendo los destinos perdidos
    expect(sql).toMatch(/dst NOT IN/);
  });

  test('filtro NO ANSWER con lostDestinations no incluye dstchannel REGEXP', () => {
    const { conditions, params } = buildOutboundWhereClause(
      { ...filters, disposition: 'NO ANSWER' }, channels, ['ivr-colgado']
    );
    const sql = conditions.join(' AND ');
    expect(sql).not.toMatch(/REGEXP/);
    expect(params).not.toContain('^(Agent/[0-9]+|SIP/[0-9]+-|PJSIP/[0-9]+-|Local/[0-9]+@)');
  });
});
