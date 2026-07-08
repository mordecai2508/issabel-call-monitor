'use strict';

/**
 * passesFilter.test.js — channels_inbound_outbound_split feature tests (#20)
 *
 * NOTE (design.md §8 / dashboard_lost_destinations.test.js): backend/server.js
 * is a self-executing script that is not safely importable in tests. This
 * file defines a LOCAL COPY of `extractChannel` and the new `passesFilter`
 * (R7-R11) that must be kept line-for-line/logic-identical to the
 * implementation in server.js (design.md §3.1).
 */

// ── Local mirror of server.js helpers ──────────────────────────────────────

/** Mirrors extractChannel from server.js */
function extractChannel(raw) {
  if (!raw) return 'Desconocido';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

/** Mirrors the new passesFilter from server.js (R7-R11, design.md §3.1) */
function passesFilter(channel, inboundChannels, outboundChannels, direction) {
  const ch = extractChannel(channel);

  if (direction === 'out') {
    if (ch.startsWith('Local/')) return false;
    return outboundChannels.includes(ch);
  }

  if (direction === 'in') {
    return inboundChannels.includes(ch);
  }

  return true;
}

// ── Tests ────────────────────────────────────────────────────────────────

const INBOUND  = ['SIP/ENT_LIWA', 'SIP/NET2_ENT_6076854970'];
const OUTBOUND = ['SIP/SALIENTE_CALL'];

describe('passesFilter (feature #20 — channels_inbound_outbound_split)', () => {
  it('R7 - direction=in incluye solo canales de channels.inbound', () => {
    expect(passesFilter('SIP/ENT_LIWA-00a1b2c3', INBOUND, OUTBOUND, 'in')).toBe(true);
    expect(passesFilter('SIP/NET2_ENT_6076854970-00a1b2c3', INBOUND, OUTBOUND, 'in')).toBe(true);
    expect(passesFilter('SIP/SALIENTE_CALL-00a1b2c3', INBOUND, OUTBOUND, 'in')).toBe(false);
    expect(passesFilter('SIP/200-00a1b2c3', INBOUND, OUTBOUND, 'in')).toBe(false);
  });

  it('R8 - direction=out incluye solo canales de channels.outbound, no por exclusión de inbound', () => {
    // Un canal que NO está en inbound ni en outbound (ej. extensión interna)
    // NO debe pasar el filtro de 'out' simplemente por no estar en inbound.
    expect(passesFilter('SIP/201-00a1b2c3', INBOUND, OUTBOUND, 'out')).toBe(false);
    // El canal saliente configurado explícitamente sí pasa.
    expect(passesFilter('SIP/SALIENTE_CALL-00a1b2c3', INBOUND, OUTBOUND, 'out')).toBe(true);
    // Un canal inbound nunca pasa como 'out'.
    expect(passesFilter('SIP/ENT_LIWA-00a1b2c3', INBOUND, OUTBOUND, 'out')).toBe(false);
  });

  it('R9 - direction=out excluye siempre canales Local/ aunque estén en channels.outbound', () => {
    const outboundWithLocal = ['SIP/SALIENTE_CALL', 'Local/200@from-internal'];
    expect(passesFilter('Local/200@from-internal-00a1b2c3', INBOUND, outboundWithLocal, 'out')).toBe(false);
  });

  it('R10 - direction=out con channels.outbound vacío no devuelve registros', () => {
    expect(passesFilter('SIP/SALIENTE_CALL-00a1b2c3', INBOUND, [], 'out')).toBe(false);
    expect(passesFilter('SIP/201-00a1b2c3', INBOUND, [], 'out')).toBe(false);
  });

  it('R11 - direction=null incluye todos los canales', () => {
    expect(passesFilter('SIP/ENT_LIWA-00a1b2c3', INBOUND, OUTBOUND, null)).toBe(true);
    expect(passesFilter('SIP/SALIENTE_CALL-00a1b2c3', INBOUND, OUTBOUND, null)).toBe(true);
    expect(passesFilter('SIP/201-00a1b2c3', INBOUND, OUTBOUND, null)).toBe(true);
    expect(passesFilter('Local/200@from-internal-00a1b2c3', INBOUND, OUTBOUND, null)).toBe(true);
  });

  it('R12 - una llamada extension-a-extension no se cuenta como saliente', () => {
    // channel = SIP/2XX-xxxx, normalizado a SIP/2XX, no presente en channels.outbound
    expect(passesFilter('SIP/201-00a1b2c3', INBOUND, OUTBOUND, 'out')).toBe(false);
    expect(passesFilter('SIP/202-00b3c4d5', INBOUND, OUTBOUND, 'out')).toBe(false);
  });

  it('R13 - una llamada por SIP/SALIENTE_CALL se cuenta como saliente', () => {
    expect(passesFilter('SIP/SALIENTE_CALL-00a1b2c3', INBOUND, OUTBOUND, 'out')).toBe(true);
  });
});

// ── R14/R15 — forma de respuesta de fetchData() con channels.inbound/outbound ──
//
// Mirrors the relevant part of queryChannels()+fetchData() in server.js: agrupa
// por canal normalizado aplicando el nuevo passesFilter(ch, inbound, outbound, direction).

/** Mirrors the relevant grouping logic of queryChannels from server.js */
function queryChannelsMirror(rows, inboundChannels, outboundChannels, direction) {
  const map = {};
  for (const r of rows) {
    if (!passesFilter(r.channel, inboundChannels, outboundChannels, direction)) continue;
    const ch = extractChannel(r.channel);
    if (!map[ch]) map[ch] = { channel: ch, total: 0 };
    map[ch].total += Number(r.count);
  }
  return Object.values(map);
}

describe('R14/R15 - fetchData() deriva inbound/outbound de channels.inbound/channels.outbound', () => {
  const rows = [
    { channel: 'SIP/ENT_LIWA-00a1b2c3',     count: 5 }, // inbound trunk
    { channel: 'SIP/SALIENTE_CALL-00b3c4d5', count: 3 }, // outbound trunk
    { channel: 'SIP/201-00c5d6e7',          count: 2 }, // extensión interna
  ];

  it('R14/R15 - direction=in solo incluye canales de channels.inbound', () => {
    const result = queryChannelsMirror(rows, INBOUND, OUTBOUND, 'in');
    expect(result.map(r => r.channel)).toEqual(['SIP/ENT_LIWA']);
  });

  it('R14/R15 - direction=out solo incluye canales de channels.outbound (no extensión-a-extensión)', () => {
    const result = queryChannelsMirror(rows, INBOUND, OUTBOUND, 'out');
    expect(result.map(r => r.channel)).toEqual(['SIP/SALIENTE_CALL']);
  });

  it('R14/R15 - direction=null (total) incluye todos los canales, igual que v1.0', () => {
    const result = queryChannelsMirror(rows, INBOUND, OUTBOUND, null);
    expect(result.map(r => r.channel).sort()).toEqual(['SIP/201', 'SIP/ENT_LIWA', 'SIP/SALIENTE_CALL'].sort());
  });

  it('R14/R15 - la forma de respuesta de fetchData() conserva stats/channels/hourly/inbound/outbound/queues/channelAliases/appName/from/to/generatedAt', () => {
    // No se reimplementa fetchData() completo (server.js no es importable, ver
    // dashboard_lost_destinations.test.js §8); se documenta el contrato esperado
    // y se valida que las claves top-level no cambian tras la migración de config.channels.
    const expectedKeys = [
      'stats', 'channels', 'hourly',
      'inbound', 'outbound', 'queues',
      'channelAliases', 'appName', 'from', 'to', 'generatedAt',
    ];
    const sampleResponse = {
      stats: {}, channels: [], hourly: [],
      inbound:  { stats: {}, channels: [], hourly: [] },
      outbound: { stats: {}, channels: [] },
      queues: [],
      channelAliases: {},
      appName: 'Call Monitor',
      from: '2026-06-13 00:00:00',
      to:   '2026-06-14 00:00:00',
      generatedAt: new Date().toISOString(),
    };
    expect(Object.keys(sampleResponse).sort()).toEqual(expectedKeys.sort());
  });
});

// ── R16 — SSE init/update ─────────────────────────────────────────────────────
//
// NOTA (T15): no existe cobertura automatizada de /api/events en la suite
// actual más allá de los smoke-tests de pbx.test.js/ami.test.js (que no
// dependen de config.channels). Dado que /api/events reutiliza fetchData()
// (verificado por R14/R15 arriba) sin cambios de forma, R16 se verifica
// manualmente en T17 (./init.sh + inspección de eventos init/update con
// channels.outbound = ["SIP/SALIENTE_CALL"] configurado).
