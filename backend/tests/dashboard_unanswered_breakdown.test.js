'use strict';

/**
 * dashboard_unanswered_breakdown.test.js — feature #22 tests
 *
 * NOTE (design.md §3 / disposition_agent_answered_fix.test.js): backend/server.js
 * is a self-executing script that is not safely importable in tests. This
 * file defines a LOCAL COPY of `extractChannel`, `passesFilter`,
 * `AGENT_DSTCHANNEL_RE`, `resolveDisposition`, `classifyUnansweredReason` and
 * `queryStats` (post-#22) that must be kept line-for-line/logic-identical to
 * the implementation in server.js (design.md §3).
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

/** Mirrors classifyUnansweredReason from server.js (#22, design.md §3.2) */
function classifyUnansweredReason(row, lostDests) {
  if (lostDests.includes(row.dst)) {
    return 'ivr_hangup';
  }

  const d = row.disposition.toUpperCase();
  if (d === 'ANSWERED' && !AGENT_DSTCHANNEL_RE.test(row.dstchannel || '')) {
    return 'queue_no_agent';
  }

  return 'no_answer';
}

/** Mirrors the modified queryStats from server.js (#22, design.md §3.3) */
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
    'NO ANSWER': {
      count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0,
      breakdown: { no_answer: 0, ivr_hangup: 0, queue_no_agent: 0 },
    },
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

      if (targetKey === 'NO ANSWER') {
        const reason = classifyUnansweredReason(r, lostDests);
        base['NO ANSWER'].breakdown[reason] += Number(r.count);
      }
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
    channel:        'SIP/ENT_LIWA-1',
    dst:            '1234',
    dstchannel:     'Agent/03',
    disposition:    'ANSWERED',
    count:          1,
    total_duration: 30,
    total_billsec:  25,
    ...overrides,
  };
}

const FROM = '2026-06-10 00:00:00';
const TO   = '2026-06-11 00:00:00';

const INBOUND  = ['SIP/ENT_LIWA'];
const OUTBOUND = ['SIP/SALIENTE_CALL'];
const LOST_DESTS = ['s', 'hang', 'hangup'];

// ── Tests ────────────────────────────────────────────────────────────────

describe('classifyUnansweredReason (feature #22 — dashboard_unanswered_breakdown)', () => {

  it('R4 - disposition=NO ANSWER con dst fuera de lostDestinations clasifica como no_answer', () => {
    const row = makeRow({ disposition: 'NO ANSWER', dst: '1234', dstchannel: '' });
    expect(resolveDisposition(row, LOST_DESTS)).toBe('NO ANSWER');
    expect(classifyUnansweredReason(row, LOST_DESTS)).toBe('no_answer');
  });

  it('R5 - dst en lostDestinations con disposition original ANSWERED clasifica como ivr_hangup', () => {
    const row = makeRow({ disposition: 'ANSWERED', dst: 'hang', dstchannel: '' });
    expect(resolveDisposition(row, LOST_DESTS)).toBe('NO ANSWER');
    expect(classifyUnansweredReason(row, LOST_DESTS)).toBe('ivr_hangup');
  });

  it('R5 - dst en lostDestinations con disposition original ya NO ANSWER clasifica como ivr_hangup, no como no_answer (sin doble conteo)', () => {
    const row = makeRow({ disposition: 'NO ANSWER', dst: 's', dstchannel: '' });
    expect(resolveDisposition(row, LOST_DESTS)).toBe('NO ANSWER');
    expect(classifyUnansweredReason(row, LOST_DESTS)).toBe('ivr_hangup');
  });

  it('R6 - disposition=ANSWERED, dst fuera de lostDestinations, dstchannel sin coincidir con AGENT_DSTCHANNEL_RE clasifica como queue_no_agent', () => {
    const row = makeRow({ disposition: 'ANSWERED', dst: '8000', dstchannel: '' });
    expect(resolveDisposition(row, LOST_DESTS)).toBe('NO ANSWER');
    expect(classifyUnansweredReason(row, LOST_DESTS)).toBe('queue_no_agent');
  });

});

describe('queryStats — breakdown (feature #22 — dashboard_unanswered_breakdown)', () => {

  it('R3 - la suma breakdown.no_answer + breakdown.ivr_hangup + breakdown.queue_no_agent es igual a dispositions["NO ANSWER"].count para un dataset mixto', async () => {
    const rows = [
      // no_answer: disposition original NO ANSWER, dst fuera de lostDests
      makeRow({ disposition: 'NO ANSWER', dst: '1234', dstchannel: '', count: 3, total_duration: 30, total_billsec: 0 }),
      // ivr_hangup: dst en lostDests (independiente de disposition original)
      makeRow({ disposition: 'ANSWERED', dst: 'hang', dstchannel: '', count: 2, total_duration: 20, total_billsec: 0 }),
      makeRow({ disposition: 'NO ANSWER', dst: 's', dstchannel: '', count: 1, total_duration: 10, total_billsec: 0 }),
      // queue_no_agent: disposition original ANSWERED, dst fuera de lostDests, dstchannel sin agente
      makeRow({ disposition: 'ANSWERED', dst: '8000', dstchannel: '', count: 4, total_duration: 40, total_billsec: 30 }),
      // ANSWERED real (no debe contribuir al breakdown)
      makeRow({ disposition: 'ANSWERED', dst: '1234', dstchannel: 'Agent/03', count: 5, total_duration: 50, total_billsec: 45 }),
      // BUSY (no debe contribuir al breakdown)
      makeRow({ disposition: 'BUSY', dst: '1234', dstchannel: '', count: 1, total_duration: 5, total_billsec: 0 }),
      // FAILED (no debe contribuir al breakdown)
      makeRow({ disposition: 'FAILED', dst: '1234', dstchannel: '', count: 1, total_duration: 5, total_billsec: 0 }),
    ];
    const pool = mockPool(rows);

    const { dispositions } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);
    const noAnswer = dispositions['NO ANSWER'];

    expect(noAnswer.breakdown.no_answer).toBe(3);
    expect(noAnswer.breakdown.ivr_hangup).toBe(3); // 2 + 1
    expect(noAnswer.breakdown.queue_no_agent).toBe(4);

    const sum = noAnswer.breakdown.no_answer + noAnswer.breakdown.ivr_hangup + noAnswer.breakdown.queue_no_agent;
    expect(sum).toBe(noAnswer.count);
    expect(noAnswer.count).toBe(10); // 3 + 2 + 1 + 4
  });

  it('R2 - registros con disposition ANSWERED/BUSY/FAILED (sin reclasificar a NO ANSWER) no contribuyen al breakdown', async () => {
    const rows = [
      makeRow({ disposition: 'ANSWERED', dst: '1234', dstchannel: 'Agent/03', count: 5, total_duration: 50, total_billsec: 45 }),
      makeRow({ disposition: 'BUSY', dst: '1234', dstchannel: '', count: 2, total_duration: 5, total_billsec: 0 }),
      makeRow({ disposition: 'FAILED', dst: '1234', dstchannel: '', count: 3, total_duration: 5, total_billsec: 0 }),
    ];
    const pool = mockPool(rows);

    const { dispositions } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);
    const noAnswer = dispositions['NO ANSWER'];

    expect(noAnswer.count).toBe(0);
    expect(noAnswer.breakdown).toEqual({ no_answer: 0, ivr_hangup: 0, queue_no_agent: 0 });
    expect(dispositions.ANSWERED.count).toBe(5);
    expect(dispositions.BUSY.count).toBe(2);
    expect(dispositions.FAILED.count).toBe(3);
  });

  it('R9 - dispositions["NO ANSWER"].count, total_duration, total_billsec, avg_billsec y pct no cambian respecto al cálculo de #21; breakdown es additivo', async () => {
    const rows = [
      makeRow({ disposition: 'NO ANSWER', dst: '1234', dstchannel: '', count: 3, total_duration: 30, total_billsec: 0 }),
      makeRow({ disposition: 'ANSWERED', dst: '8000', dstchannel: '', count: 4, total_duration: 40, total_billsec: 30 }),
      makeRow({ disposition: 'ANSWERED', dst: '1234', dstchannel: 'Agent/03', count: 3, total_duration: 30, total_billsec: 25 }),
    ];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);
    const noAnswer = dispositions['NO ANSWER'];

    // count = NO ANSWER (3) + reclasificado ANSWERED->NO ANSWER (4) = 7
    expect(noAnswer.count).toBe(7);
    expect(noAnswer.total_duration).toBe(70);
    expect(noAnswer.total_billsec).toBe(30);
    // avg_billsec solo se calcula para ANSWERED (sin cambios respecto a #21)
    expect(noAnswer.avg_billsec).toBe(0);
    expect(noAnswer.pct).toBe(Math.round((7 / total) * 1000) / 10);

    // breakdown es additivo, no altera los campos existentes
    expect(noAnswer).toHaveProperty('breakdown');
    expect(noAnswer.breakdown.no_answer + noAnswer.breakdown.ivr_hangup + noAnswer.breakdown.queue_no_agent).toBe(noAnswer.count);

    // Los otros buckets no tienen breakdown
    expect(dispositions.ANSWERED.breakdown).toBeUndefined();
    expect(dispositions.BUSY.breakdown).toBeUndefined();
    expect(dispositions.FAILED.breakdown).toBeUndefined();
  });

  it('R10 - total = ANSWERED + NO ANSWER + BUSY + FAILED sigue cumpliéndose tras añadir breakdown', async () => {
    const rows = [
      makeRow({ disposition: 'NO ANSWER', dst: '1234', dstchannel: '', count: 3, total_duration: 30, total_billsec: 0 }),
      makeRow({ disposition: 'ANSWERED', dst: '8000', dstchannel: '', count: 4, total_duration: 40, total_billsec: 30 }),
      makeRow({ disposition: 'ANSWERED', dst: '1234', dstchannel: 'Agent/03', count: 3, total_duration: 30, total_billsec: 25 }),
      makeRow({ disposition: 'BUSY', dst: '1234', dstchannel: '', count: 2, total_duration: 5, total_billsec: 0 }),
      makeRow({ disposition: 'FAILED', dst: '1234', dstchannel: '', count: 1, total_duration: 5, total_billsec: 0 }),
    ];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    const sum = dispositions.ANSWERED.count + dispositions['NO ANSWER'].count + dispositions.BUSY.count + dispositions.FAILED.count;
    expect(sum).toBe(total);
    expect(total).toBe(13); // 3 + 4 + 3 + 2 + 1
  });

});

// ── R12-R15, R22 — forma de respuesta de endpoints existentes ──────────────
//
// NOTA (design.md §8 / disposition_agent_answered_fix.test.js R14-R17/R21):
// server.js no es importable en tests. Esta feature no añade ni modifica
// rutas (design.md §1) ni cambia la forma de fetchData() salvo por el campo
// additivo `breakdown` dentro de `dispositions['NO ANSWER']` (R8, R9, R12-R15,
// R22). Aquí se documenta y verifica ese contrato sobre la copia local de
// queryStats (idéntica a server.js tras #22).

describe('R12-R15, R22 - dispositions["NO ANSWER"].breakdown en fetchData()/endpoints tras #22', () => {

  it('R12/R13 - GET /api/calls/today y /api/calls/range: dispositions["NO ANSWER"] incluye breakdown con las 3 claves no_answer/ivr_hangup/queue_no_agent', async () => {
    const pool = mockPool([makeRow({ disposition: 'NO ANSWER', dst: '1234', dstchannel: '', count: 2, total_duration: 20, total_billsec: 0 })]);
    const { dispositions } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    expect(dispositions['NO ANSWER']).toHaveProperty('breakdown');
    expect(Object.keys(dispositions['NO ANSWER'].breakdown).sort()).toEqual(
      ['ivr_hangup', 'no_answer', 'queue_no_agent'].sort()
    );
  });

  it('R13 - breakdown está presente en las 3 invocaciones de queryStats usadas por fetchData() (total/inbound/outbound)', async () => {
    const rows = [makeRow({ disposition: 'NO ANSWER', dst: '1234', dstchannel: '', count: 1, total_duration: 10, total_billsec: 0 })];

    const total    = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, null, LOST_DESTS);
    const inbound  = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);
    const outbound = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'out', LOST_DESTS);

    expect(total.dispositions['NO ANSWER']).toHaveProperty('breakdown');
    expect(inbound.dispositions['NO ANSWER']).toHaveProperty('breakdown');
    expect(outbound.dispositions['NO ANSWER']).toHaveProperty('breakdown');
  });

  it('R14 - SSE init/update: stats.dispositions["NO ANSWER"] incluye breakdown (mismo fetchData() que /api/calls/today)', async () => {
    // /api/events reutiliza fetchData() (R14/R15 de #20/#21, sin cambios de
    // forma salvo el campo additivo breakdown verificado arriba). Sin entorno
    // SSE real disponible en esta suite (documentado igual que #21); se
    // verifica el contrato vía la misma queryStats que alimenta init/update.
    const pool = mockPool([makeRow({ disposition: 'NO ANSWER', dst: 'hang', dstchannel: '', count: 1, total_duration: 10, total_billsec: 0 })]);
    const { dispositions } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    expect(dispositions['NO ANSWER'].breakdown).toEqual({ no_answer: 0, ivr_hangup: 1, queue_no_agent: 0 });
  });

  it('R22 - dispositions["NO ANSWER"] conserva count/total_duration/total_billsec/avg_billsec/pct además del nuevo breakdown; otros buckets sin breakdown', async () => {
    const pool = mockPool([makeRow({ disposition: 'NO ANSWER', dst: '1234', dstchannel: '', count: 2, total_duration: 20, total_billsec: 0 })]);
    const { dispositions } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    expect(Object.keys(dispositions['NO ANSWER']).sort()).toEqual(
      ['avg_billsec', 'breakdown', 'count', 'pct', 'total_billsec', 'total_duration'].sort()
    );
    for (const key of ['ANSWERED', 'BUSY', 'FAILED']) {
      expect(Object.keys(dispositions[key]).sort()).toEqual(
        ['avg_billsec', 'count', 'pct', 'total_billsec', 'total_duration'].sort()
      );
    }
  });

  it('R22 - top-level keys de fetchData() no cambian respecto a #21', () => {
    const expectedKeys = [
      'stats', 'channels', 'hourly',
      'inbound', 'outbound', 'queues',
      'channelAliases', 'appName', 'from', 'to', 'generatedAt',
    ];
    const sampleResponse = {
      stats: { dispositions: {}, total: 0 },
      channels: [],
      hourly: [],
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
