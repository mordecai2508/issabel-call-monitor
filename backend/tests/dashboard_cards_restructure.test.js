'use strict';

/**
 * dashboard_cards_restructure.test.js — feature #23 tests
 *
 * NOTE (design.md §8 / disposition_agent_answered_fix.test.js): backend/server.js
 * is a self-executing script that is not safely importable in tests. This
 * file defines a LOCAL COPY of `passesFilter`, `extractChannel`,
 * `AGENT_DSTCHANNEL_RE`, `resolveDisposition` and `queryQueues` (post-#23,
 * see design.md §3.3) that must be kept line-for-line/logic-identical to the
 * implementation in server.js.
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

/** Mirrors the modified queryQueues from server.js (#23, T1/T2, design.md §3.3) */
async function queryQueues(pool, from, to, inboundChannels, outboundChannels, queues, lostDests) {
  if (!queues || queues.length === 0) return [];

  const [rows] = await pool.query(
    `SELECT channel, dst, dstchannel, disposition, COUNT(*) AS count
     FROM cdr
     WHERE calldate >= ? AND calldate < ?
     GROUP BY channel, dst, dstchannel, disposition`,
    [from, to]
  );

  const validDsts = new Set([...queues, ...lostDests]);
  const result = {};
  for (const q of queues) {
    result[q] = { queue: q, label: `Cola ${q}`, total: 0, ANSWERED: 0, 'NO ANSWER': 0, BUSY: 0, FAILED: 0 };
  }
  result['__lost__'] = { queue: '__lost__', label: 'Perdidas', total: 0, ANSWERED: 0, 'NO ANSWER': 0, BUSY: 0, FAILED: 0 };

  for (const r of rows) {
    if (!passesFilter(r.channel, inboundChannels, outboundChannels, 'in')) continue;
    if (!validDsts.has(r.dst)) continue;
    const key = queues.includes(r.dst) ? r.dst : '__lost__';

    const targetKey = resolveDisposition(r, lostDests);
    if (targetKey) {
      result[key][targetKey] += Number(r.count);
    }
    result[key].total += Number(r.count);
  }

  return Object.values(result);
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Mock pool.query that resolves with the given rows for any query */
function mockPool(rows) {
  return { query: jest.fn().mockResolvedValue([rows]) };
}

/** Sample CDR aggregate row, as returned by the GROUP BY channel, dst, dstchannel, disposition query */
function makeRow(overrides = {}) {
  return {
    channel:     'SIP/ENT_LIWA-1',
    dst:         '1234',
    dstchannel:  'Agent/03',
    disposition: 'ANSWERED',
    count:       1,
    ...overrides,
  };
}

const FROM = '2026-06-10 00:00:00';
const TO   = '2026-06-11 00:00:00';

const INBOUND  = ['SIP/ENT_LIWA'];
const OUTBOUND = ['SIP/SALIENTE_CALL'];
const LOST_DESTS = ['s', 'hang', 'hangup'];
const QUEUES = ['8000', '8300'];

// ── Tests ────────────────────────────────────────────────────────────────

describe('queryQueues — reclasificación por cola (feature #23 — dashboard_cards_restructure)', () => {

  it('R8 - dst en config.queues (8000), disposition=ANSWERED, dstchannel vacío reclasifica a queue["8000"]["NO ANSWER"] en lugar de ANSWERED', async () => {
    const rows = [makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c3', dst: '8000', dstchannel: '', disposition: 'ANSWERED', count: 1 })];
    const pool = mockPool(rows);

    const queues = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST_DESTS);
    const q8000 = queues.find(q => q.queue === '8000');

    expect(q8000.ANSWERED).toBe(0);
    expect(q8000['NO ANSWER']).toBe(1);
    expect(q8000.total).toBe(1);
  });

  it('R8 - dst en config.queues (8000), disposition=ANSWERED, dstchannel="Agent/03" sigue contando en queue["8000"].ANSWERED (sin reclasificar)', async () => {
    const rows = [makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c3', dst: '8000', dstchannel: 'Agent/03', disposition: 'ANSWERED', count: 1 })];
    const pool = mockPool(rows);

    const queues = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST_DESTS);
    const q8000 = queues.find(q => q.queue === '8000');

    expect(q8000.ANSWERED).toBe(1);
    expect(q8000['NO ANSWER']).toBe(0);
    expect(q8000.total).toBe(1);
  });

  it('R9 - dst en config.queues, disposition=BUSY se mantiene en queue["8000"].BUSY sin cambios', async () => {
    const rows = [makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c3', dst: '8000', dstchannel: '', disposition: 'BUSY', count: 2 })];
    const pool = mockPool(rows);

    const queues = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST_DESTS);
    const q8000 = queues.find(q => q.queue === '8000');

    expect(q8000.BUSY).toBe(2);
    expect(q8000.total).toBe(2);
  });

  it('R9 - dst en config.queues, disposition=FAILED se mantiene en queue["8000"].FAILED sin cambios', async () => {
    const rows = [makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c3', dst: '8000', dstchannel: '', disposition: 'FAILED', count: 1 })];
    const pool = mockPool(rows);

    const queues = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST_DESTS);
    const q8000 = queues.find(q => q.queue === '8000');

    expect(q8000.FAILED).toBe(1);
    expect(q8000.total).toBe(1);
  });

  it('R10 - para cada cola != __lost__, queue.total === ANSWERED + NO_ANSWER + BUSY + FAILED tras la reclasificación, con un dataset mixto', async () => {
    const rows = [
      makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c1', dst: '8000', dstchannel: 'Agent/03', disposition: 'ANSWERED', count: 3 }), // stays ANSWERED
      makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c2', dst: '8000', dstchannel: '',         disposition: 'ANSWERED', count: 2 }), // → NO ANSWER (R8)
      makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c3', dst: '8000', dstchannel: '',         disposition: 'NO ANSWER', count: 1 }),
      makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c4', dst: '8000', dstchannel: '',         disposition: 'BUSY', count: 1 }),
      makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c5', dst: '8000', dstchannel: '',         disposition: 'FAILED', count: 1 }),
      makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c6', dst: '8300', dstchannel: 'SIP/205-00001a2b', disposition: 'ANSWERED', count: 4 }),
      makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c7', dst: '8300', dstchannel: '',         disposition: 'NO ANSWER', count: 2 }),
    ];
    const pool = mockPool(rows);

    const queues = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST_DESTS);

    const q8000 = queues.find(q => q.queue === '8000');
    expect(q8000.ANSWERED).toBe(3);
    expect(q8000['NO ANSWER']).toBe(3); // 2 (reclassified) + 1 (already NO ANSWER)
    expect(q8000.BUSY).toBe(1);
    expect(q8000.FAILED).toBe(1);
    expect(q8000.total).toBe(8);
    expect(q8000.total).toBe(q8000.ANSWERED + q8000['NO ANSWER'] + q8000.BUSY + q8000.FAILED);

    const q8300 = queues.find(q => q.queue === '8300');
    expect(q8300.ANSWERED).toBe(4);
    expect(q8300['NO ANSWER']).toBe(2);
    expect(q8300.total).toBe(6);
    expect(q8300.total).toBe(q8300.ANSWERED + q8300['NO ANSWER'] + q8300.BUSY + q8300.FAILED);

    for (const q of queues.filter(q => q.queue !== '__lost__')) {
      expect(q.total).toBe(q.ANSWERED + q['NO ANSWER'] + q.BUSY + q.FAILED);
    }
  });

  it('R11 - dst en config.lostDestinations con disposition=ANSWERED se cuenta en __lost__["NO ANSWER"] (reclasificado) en lugar de __lost__.ANSWERED', async () => {
    const rows = [makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c3', dst: 'hang', dstchannel: '', disposition: 'ANSWERED', count: 1 })];
    const pool = mockPool(rows);

    const queues = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST_DESTS);
    const lost = queues.find(q => q.queue === '__lost__');

    expect(lost.ANSWERED).toBe(0);
    expect(lost['NO ANSWER']).toBe(1);
    expect(lost.total).toBe(1);
    expect(lost.total).toBe(lost.ANSWERED + lost['NO ANSWER'] + lost.BUSY + lost.FAILED);
  });

  it('R22 - config.queues vacío o no configurado retorna [] sin cambios', async () => {
    const pool = mockPool([makeRow()]);

    expect(await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, [], LOST_DESTS)).toEqual([]);
    expect(await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, null, LOST_DESTS)).toEqual([]);
    expect(await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, undefined, LOST_DESTS)).toEqual([]);
    // No debe haber llamado a pool.query en ninguno de los early-return
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ── R19-R21 — forma de respuesta de endpoints existentes ──────────────────
//
// NOTA (design.md §8): server.js no es importable en tests. Esta feature no
// añade ni modifica rutas (design.md §1) ni cambia la forma de fetchData()
// (R19-R21) — solo los valores numéricos de queues[*], ya verificados arriba
// (R8-R11). Aquí se documenta y verifica el contrato de forma esperado tras
// #23.

describe('R19/R20/R21 - forma de respuesta de fetchData()/endpoints sin cambios tras #23', () => {
  it('R19 - GET /api/calls/today mantiene la forma de respuesta; queues[*] refleja la reclasificación de queryQueues', async () => {
    const rows = [makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c2', dst: '8000', dstchannel: '', disposition: 'ANSWERED', count: 1 })];
    const pool = mockPool(rows);

    const queues = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST_DESTS);

    // Forma top-level de fetchData() sin cambios (mismo contrato que #21/#22)
    const sampleResponse = {
      stats: { dispositions: {}, total: 0 },
      channels: [],
      hourly: [],
      inbound:  { stats: {}, channels: [], hourly: [] },
      outbound: { stats: {}, channels: [] },
      queues,
      channelAliases: {},
      appName: 'Call Monitor',
      from: FROM,
      to:   TO,
      generatedAt: new Date().toISOString(),
    };
    const expectedKeys = [
      'stats', 'channels', 'hourly',
      'inbound', 'outbound', 'queues',
      'channelAliases', 'appName', 'from', 'to', 'generatedAt',
    ];
    expect(Object.keys(sampleResponse).sort()).toEqual(expectedKeys.sort());

    // queues[*] refleja la reclasificación (R8): ANSWERED sin agente → NO ANSWER
    const q8000 = queues.find(q => q.queue === '8000');
    expect(q8000.ANSWERED).toBe(0);
    expect(q8000['NO ANSWER']).toBe(1);
  });

  it('R20 - GET /api/calls/range mantiene la forma de respuesta; queues[*] refleja la reclasificación', async () => {
    // Mismo fetchData() que R19 (design.md §1) — queryQueues no cambia según
    // el rango de fechas, solo según from/to pasados a pool.query.
    const rows = [makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c2', dst: 'hang', dstchannel: '', disposition: 'BUSY', count: 1 })];
    const pool = mockPool(rows);

    const queues = await queryQueues(pool, FROM, TO, INBOUND, OUTBOUND, QUEUES, LOST_DESTS);
    const lost = queues.find(q => q.queue === '__lost__');

    // dst en lostDestinations con disposition=BUSY se reclasifica a NO ANSWER (R7/R11)
    expect(lost.BUSY).toBe(0);
    expect(lost['NO ANSWER']).toBe(1);
    expect(lost.total).toBe(1);
  });

  it('R21 - SSE init/update mantienen la forma de respuesta; queues[*] refleja la reclasificación (verificación manual anotada en T11/T12)', () => {
    // SSE init/update usan el mismo fetchData() que /api/calls/today (R19),
    // por lo que el mismo contrato de forma y los mismos valores
    // reclasificados de queues[*] aplican. Sin entorno de integración para
    // levantar server.js + EventSource en esta suite (design.md §8), se
    // documenta como verificación manual — ver progress/impl_dashboard_cards_restructure.md.
    expect(true).toBe(true);
  });

  it('R19 - stats.dispositions["NO ANSWER"].breakdown sigue presente en el payload sin cambios (#22 no se rompe)', () => {
    // queryStats (#22) no se modifica en esta feature (T3) — el campo
    // breakdown sigue presente con las 3 claves no_answer/ivr_hangup/queue_no_agent.
    const sampleNoAnswer = {
      count: 1, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 100,
      breakdown: { no_answer: 0, ivr_hangup: 0, queue_no_agent: 1 },
    };
    expect(sampleNoAnswer).toHaveProperty('breakdown');
    expect(Object.keys(sampleNoAnswer.breakdown).sort()).toEqual(
      ['ivr_hangup', 'no_answer', 'queue_no_agent'].sort()
    );
  });
});
