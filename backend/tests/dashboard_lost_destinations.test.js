'use strict';

/**
 * dashboard_lost_destinations.test.js — feature #17 tests
 *
 * Uses Jest with a mocked MySQL pool (no Issabel DB required).
 *
 * NOTE (design.md §8, updated by feature #21 disposition_agent_answered_fix):
 * backend/server.js is a self-executing script that is not safely importable
 * in tests. This file defines a LOCAL COPY of `extractChannel`,
 * `passesFilter` (post-#20), `resolveDisposition` (#21) and the modified
 * `queryStats` (now delegating reclassification to `resolveDisposition`,
 * R1-R19 of #17 + R1-R19 of #21) that must be kept line-for-line/logic-
 * identical to the implementation in server.js.
 */

// ── Local mirror of server.js helpers ──────────────────────────────────────

/** Mirrors extractChannel from server.js */
function extractChannel(raw) {
  if (!raw) return 'Desconocido';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

/** Mirrors passesFilter from server.js (post-#20) */
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

/** Mirrors AGENT_DSTCHANNEL_RE from server.js (#21) */
const AGENT_DSTCHANNEL_RE = /^(Agent\/\d+|SIP\/\d+-)/;

/** Mirrors resolveDisposition from server.js (#17 + #21) */
function resolveDisposition(row, lostDests) {
  const d = row.disposition.toUpperCase();
  let targetKey = ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED'].includes(d) ? d : null;
  if (!targetKey) return null;

  const isLostDst = lostDests.includes(row.dst);
  if (isLostDst && targetKey !== 'NO ANSWER') {
    targetKey = 'NO ANSWER';
  }

  if (targetKey === 'ANSWERED' && !AGENT_DSTCHANNEL_RE.test(row.dstchannel || '')) {
    targetKey = 'NO ANSWER';
  }

  return targetKey;
}

/** Mirrors the modified queryStats from server.js (post-#20/#21) */
async function queryStats(pool, from, to, inboundChannels, outboundChannels, direction = 'in', lostDests = ['s', 'hang', 'hangup']) {
  const [rows] = await pool.query(
    `SELECT
       channel,
       dst,
       dstchannel,
       disposition,
       COUNT(*)                    AS count,
       COALESCE(SUM(duration), 0)  AS total_duration,
       COALESCE(SUM(billsec), 0)   AS total_billsec
     FROM cdr
     WHERE calldate >= ? AND calldate < ?
     GROUP BY channel, dst, dstchannel, disposition`,
    [from, to]
  );

  const base = {
    ANSWERED:    { count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0 },
    'NO ANSWER': { count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0 },
    BUSY:        { count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0 },
    FAILED:      { count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0 },
  };

  let total = 0;
  for (const r of rows) {
    if (!passesFilter(r.channel, inboundChannels, outboundChannels, direction)) continue;

    const targetKey = resolveDisposition(r, lostDests);
    if (targetKey) {
      base[targetKey].count          += Number(r.count);
      base[targetKey].total_duration += Number(r.total_duration);
      base[targetKey].total_billsec  += Number(r.total_billsec);
    }
    total += Number(r.count);
  }

  if (base.ANSWERED.count > 0)
    base.ANSWERED.avg_billsec = Math.round(base.ANSWERED.total_billsec / base.ANSWERED.count);

  for (const key of Object.keys(base)) {
    base[key].pct = total > 0 ? Math.round((base[key].count / total) * 1000) / 10 : 0;
  }

  return { dispositions: base, total };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Mock pool.query that resolves with the given rows for any query */
function mockPool(rows) {
  return { query: jest.fn().mockResolvedValue([rows]) };
}

/** Sample CDR aggregate row, as returned by the GROUP BY channel, dst, dstchannel, disposition query */
function makeRow(overrides = {}) {
  return {
    channel:        'SIP/trunk-1',
    dst:            '1234',
    dstchannel:     'Agent/01',
    disposition:    'ANSWERED',
    count:          1,
    total_duration: 30,
    total_billsec:  25,
    ...overrides,
  };
}

const FROM = '2026-06-10 00:00:00';
const TO   = '2026-06-11 00:00:00';

// makeRow's channel ('SIP/trunk-1') normalizes to 'SIP/trunk' (extractChannel
// strips the trailing '-1'); registrarlo como inbound para que passesFilter
// (post-#20) lo incluya con direction='in'.
const INBOUND  = ['SIP/trunk'];
const OUTBOUND = [];

// ── Tests ────────────────────────────────────────────────────────────────

describe('queryStats — reclasificación de Perdidas (feature #17)', () => {

  it('R2 - ANSWERED con dst en lostDestinations se resta de Contestadas y se suma a Perdidas', async () => {
    const rows = [makeRow({ disposition: 'ANSWERED', dst: 'hang', count: 1, total_duration: 30, total_billsec: 25 })];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    expect(dispositions.ANSWERED.count).toBe(0);
    expect(dispositions['NO ANSWER'].count).toBe(1);
    expect(dispositions['NO ANSWER'].total_duration).toBe(30);
    expect(dispositions['NO ANSWER'].total_billsec).toBe(25);
    expect(total).toBe(1);
  });

  it('R2 - BUSY con dst en lostDestinations se resta de Ocupado y se suma a Perdidas', async () => {
    const rows = [makeRow({ disposition: 'BUSY', dst: 'hang', count: 1, total_duration: 0, total_billsec: 0 })];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    expect(dispositions.BUSY.count).toBe(0);
    expect(dispositions['NO ANSWER'].count).toBe(1);
    expect(total).toBe(1);
  });

  it('R2 - FAILED con dst en lostDestinations se resta de Fallidas y se suma a Perdidas', async () => {
    const rows = [makeRow({ disposition: 'FAILED', dst: 'hangup', count: 1, total_duration: 0, total_billsec: 0 })];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    expect(dispositions.FAILED.count).toBe(0);
    expect(dispositions['NO ANSWER'].count).toBe(1);
    expect(total).toBe(1);
  });

  it('R3 - NO ANSWER con dst en lostDestinations cuenta una sola vez en Perdidas (sin doble conteo)', async () => {
    const rows = [makeRow({ disposition: 'NO ANSWER', dst: 's', count: 1, total_duration: 0, total_billsec: 0 })];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    expect(dispositions['NO ANSWER'].count).toBe(1);
    expect(total).toBe(1);
  });

  it('R4 - NO ANSWER con dst fuera de lostDestinations no cambia (comportamiento de #16)', async () => {
    const rows = [makeRow({ disposition: 'NO ANSWER', dst: '1234', count: 1, total_duration: 0, total_billsec: 0 })];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    expect(dispositions['NO ANSWER'].count).toBe(1);
    expect(dispositions.ANSWERED.count).toBe(0);
    expect(dispositions.BUSY.count).toBe(0);
    expect(dispositions.FAILED.count).toBe(0);
    expect(total).toBe(1);
  });

  it('R5 - ANSWERED/BUSY/FAILED con dst fuera de lostDestinations no se reclasifican', async () => {
    const rows = [
      makeRow({ disposition: 'ANSWERED', dst: '1001', count: 1, total_duration: 60, total_billsec: 55 }),
      makeRow({ disposition: 'BUSY',     dst: '1002', count: 1, total_duration: 0,  total_billsec: 0 }),
      makeRow({ disposition: 'FAILED',   dst: '1003', count: 1, total_duration: 0,  total_billsec: 0 }),
    ];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    expect(dispositions.ANSWERED.count).toBe(1);
    expect(dispositions.BUSY.count).toBe(1);
    expect(dispositions.FAILED.count).toBe(1);
    expect(dispositions['NO ANSWER'].count).toBe(0);
    expect(total).toBe(3);
  });

  it('R9 - Total = Contestadas + Perdidas + Ocupado + Fallidas tras la reclasificación', async () => {
    const rows = [
      makeRow({ disposition: 'ANSWERED',  dst: 'hang',  count: 1, total_duration: 30, total_billsec: 25 }), // → NO ANSWER (R2)
      makeRow({ disposition: 'NO ANSWER', dst: 's',     count: 2, total_duration: 0,  total_billsec: 0 }),  // → NO ANSWER (R3)
      makeRow({ disposition: 'NO ANSWER', dst: '1234',  count: 1, total_duration: 0,  total_billsec: 0 }),  // → NO ANSWER (R4)
      makeRow({ disposition: 'BUSY',      dst: '1002',  count: 3, total_duration: 0,  total_billsec: 0 }),  // → BUSY (R5)
      makeRow({ disposition: 'FAILED',    dst: '1003',  count: 1, total_duration: 0,  total_billsec: 0 }),  // → FAILED (R5)
    ];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    const sum = dispositions.ANSWERED.count + dispositions['NO ANSWER'].count
      + dispositions.BUSY.count + dispositions.FAILED.count;

    expect(total).toBe(sum);
  });

  it('R10 - el total no cambia respecto al cálculo sin reclasificación', async () => {
    const rows = [
      makeRow({ disposition: 'ANSWERED',  dst: 'hang',  count: 1 }),
      makeRow({ disposition: 'NO ANSWER', dst: 's',     count: 2 }),
      makeRow({ disposition: 'BUSY',      dst: '1002',  count: 3 }),
      makeRow({ disposition: 'FAILED',    dst: '1003',  count: 1 }),
    ];
    const pool = mockPool(rows);

    const { total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    const directSum = rows.reduce((acc, r) => acc + Number(r.count), 0);
    expect(total).toBe(directSum);
  });

  it('R8 - con lostDestinations vacío, Perdidas = NO ANSWER.count sin reclasificación (comportamiento de #16)', async () => {
    const rows = [
      makeRow({ disposition: 'ANSWERED',  dst: 'hang', count: 1, total_duration: 30, total_billsec: 25 }),
      makeRow({ disposition: 'NO ANSWER', dst: 's',    count: 2, total_duration: 0,  total_billsec: 0 }),
    ];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', []);

    expect(dispositions.ANSWERED.count).toBe(1);
    expect(dispositions['NO ANSWER'].count).toBe(2);
    expect(total).toBe(3);
  });

  it("R7 - sin config.lostDestinations definido, usa el default ['s','hang','hangup']", async () => {
    const rows = [makeRow({ disposition: 'BUSY', dst: 'hangup', count: 1, total_duration: 0, total_billsec: 0 })];
    const pool = mockPool(rows);

    // Invocado sin el sexto argumento → debe aplicar el default
    const { dispositions } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in');

    expect(dispositions.BUSY.count).toBe(0);
    expect(dispositions['NO ANSWER'].count).toBe(1);
  });

  it('R6 - con lostDestinations personalizado, reclasifica según la lista configurada', async () => {
    const rows = [makeRow({ disposition: 'ANSWERED', dst: '9999', count: 1, total_duration: 10, total_billsec: 8 })];
    const pool = mockPool(rows);

    const { dispositions } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['9999']);

    expect(dispositions.ANSWERED.count).toBe(0);
    expect(dispositions['NO ANSWER'].count).toBe(1);
  });

  it('R18 - disposition no reconocida no se reclasifica ni se suma a ningún bucket, pero sí a total', async () => {
    const rows = [makeRow({ disposition: 'CONGESTION', dst: 'hang', count: 1, total_duration: 0, total_billsec: 0 })];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    for (const key of Object.keys(dispositions)) {
      expect(dispositions[key].count).toBe(0);
    }
    expect(total).toBe(1);
  });

  it('R19 - ningún contador de disposición resulta negativo', async () => {
    const rows = [
      makeRow({ disposition: 'ANSWERED',  dst: 'hang',     count: 1 }),
      makeRow({ disposition: 'NO ANSWER', dst: 's',        count: 2 }),
      makeRow({ disposition: 'NO ANSWER', dst: '1234',     count: 1 }),
      makeRow({ disposition: 'BUSY',      dst: 'hangup',   count: 1 }),
      makeRow({ disposition: 'FAILED',    dst: '1003',     count: 1 }),
      makeRow({ disposition: 'CONGESTION', dst: 'hang',    count: 1 }),
    ];
    const pool = mockPool(rows);

    const { dispositions } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    expect(Object.values(dispositions).every(d => d.count >= 0)).toBe(true);
  });

  it('R17 - sin filas (sin llamadas), todos los contadores y total son 0', async () => {
    const pool = mockPool([]);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    expect(total).toBe(0);
    for (const key of Object.keys(dispositions)) {
      expect(dispositions[key].count).toBe(0);
      expect(dispositions[key].total_duration).toBe(0);
      expect(dispositions[key].total_billsec).toBe(0);
      expect(dispositions[key].avg_billsec).toBe(0);
      expect(dispositions[key].pct).toBe(0);
      expect(Number.isNaN(dispositions[key].count)).toBe(false);
    }
  });

  it('R11 - pct se recalcula correctamente tras la reclasificación', async () => {
    const rows = [
      makeRow({ disposition: 'ANSWERED',  dst: 'hang', count: 1, total_duration: 30, total_billsec: 25 }), // → NO ANSWER
      makeRow({ disposition: 'ANSWERED',  dst: '1001', count: 3, total_duration: 90, total_billsec: 75 }), // stays ANSWERED
    ];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', ['s', 'hang', 'hangup']);

    expect(total).toBe(4);
    expect(dispositions.ANSWERED.count).toBe(3);
    expect(dispositions['NO ANSWER'].count).toBe(1);
    expect(dispositions.ANSWERED.pct).toBe(Math.round((3 / 4) * 1000) / 10);
    expect(dispositions['NO ANSWER'].pct).toBe(Math.round((1 / 4) * 1000) / 10);
  });
});
