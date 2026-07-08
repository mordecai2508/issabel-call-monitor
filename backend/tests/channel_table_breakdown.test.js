'use strict';

/**
 * channel_table_breakdown.test.js — feature #26 tests
 *
 * Local mirror of queryChannels (post-#26) from server.js.
 * Tests that breakdown.ivr_hangup / no_answer / queue_no_agent
 * are accumulated correctly per channel.
 */

// ── Local mirrors of server.js helpers ──────────────────────────────────────

function extractChannel(raw) {
  if (!raw) return 'Desconocido';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

function passesFilter(channel, inboundChannels, outboundChannels, direction) {
  const ch = extractChannel(channel);
  if (direction === 'out') {
    if (ch.startsWith('Local/')) return false;
    return outboundChannels.includes(ch);
  }
  if (direction === 'in') return inboundChannels.includes(ch);
  return true;
}

const AGENT_DSTCHANNEL_RE = /^(Agent\/\d+|SIP\/\d+-)/;

function resolveDisposition(row, lostDests) {
  const d = row.disposition.toUpperCase();
  let targetKey = ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED'].includes(d) ? d : null;
  if (!targetKey) return null;
  if (lostDests.includes(row.dst) && targetKey !== 'NO ANSWER') targetKey = 'NO ANSWER';
  if (targetKey === 'ANSWERED' && !AGENT_DSTCHANNEL_RE.test(row.dstchannel || '')) targetKey = 'NO ANSWER';
  return targetKey;
}

function classifyUnansweredReason(row, lostDests) {
  if (lostDests.includes(row.dst)) return 'ivr_hangup';
  const d = row.disposition.toUpperCase();
  if (d === 'ANSWERED' && !AGENT_DSTCHANNEL_RE.test(row.dstchannel || '')) return 'queue_no_agent';
  return 'no_answer';
}

/** Mirror of queryChannels (post-#26) */
async function queryChannels(pool, from, to, inboundChannels, outboundChannels, direction = 'in', lostDests = ['s', 'hang', 'hangup']) {
  const [rows] = await pool.query(
    `SELECT channel, dst, dstchannel, disposition,
            COUNT(*) AS count, COALESCE(SUM(billsec), 0) AS total_billsec
     FROM cdr WHERE calldate >= ? AND calldate < ?
     GROUP BY channel, dst, dstchannel, disposition`,
    [from, to]
  );

  const map = {};
  for (const r of rows) {
    if (!passesFilter(r.channel, inboundChannels, outboundChannels, direction)) continue;
    const ch = extractChannel(r.channel);
    if (!map[ch]) {
      map[ch] = {
        channel: ch,
        ANSWERED: 0, 'NO ANSWER': 0, BUSY: 0, FAILED: 0,
        total: 0, total_billsec: 0,
        breakdown: { ivr_hangup: 0, no_answer: 0, queue_no_agent: 0 },
      };
    }

    const targetKey = resolveDisposition(r, lostDests);
    if (targetKey) {
      map[ch][targetKey] += Number(r.count);
      if (targetKey === 'NO ANSWER') {
        const reason = classifyUnansweredReason(r, lostDests);
        map[ch].breakdown[reason] += Number(r.count);
      }
    }
    map[ch].total         += Number(r.count);
    map[ch].total_billsec += Number(r.total_billsec);
  }

  return Object.values(map).sort((a, b) => b.total - a.total);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mockPool(rows) {
  return { query: jest.fn().mockResolvedValue([rows]) };
}

function makeRow(overrides = {}) {
  return {
    channel:     'SIP/ENT_LIWA-00a1b2c3',
    dst:         '1234',
    dstchannel:  'Agent/03',
    disposition: 'ANSWERED',
    count:       1,
    total_billsec: 60,
    ...overrides,
  };
}

const FROM      = '2026-06-17 00:00:00';
const TO        = '2026-06-18 00:00:00';
const INBOUND   = ['SIP/ENT_LIWA'];
const OUTBOUND  = ['SIP/SALIENTE_CALL'];
const LOST_DESTS = ['s', 'hang', 'hangup'];

// ── Tests ─────────────────────────────────────────────────────────────────

describe('queryChannels — breakdown por canal (feature #26)', () => {

  it('llamada contestada real → ANSWERED, breakdown vacío', async () => {
    const rows = [makeRow({ count: 5, total_billsec: 300 })];
    const result = await queryChannels(mockPool(rows), FROM, TO, INBOUND, OUTBOUND);
    expect(result).toHaveLength(1);
    const ch = result[0];
    expect(ch.ANSWERED).toBe(5);
    expect(ch['NO ANSWER']).toBe(0);
    expect(ch.breakdown).toEqual({ ivr_hangup: 0, no_answer: 0, queue_no_agent: 0 });
  });

  it('dst en lostDests → ivr_hangup en breakdown', async () => {
    const rows = [makeRow({ dst: 'hang', disposition: 'NO ANSWER', dstchannel: '', count: 3 })];
    const result = await queryChannels(mockPool(rows), FROM, TO, INBOUND, OUTBOUND);
    const ch = result[0];
    expect(ch['NO ANSWER']).toBe(3);
    expect(ch.breakdown.ivr_hangup).toBe(3);
    expect(ch.breakdown.no_answer).toBe(0);
    expect(ch.breakdown.queue_no_agent).toBe(0);
  });

  it('ANSWERED sin dstchannel de agente real → queue_no_agent en breakdown', async () => {
    const rows = [makeRow({ dst: '8001', disposition: 'ANSWERED', dstchannel: '', count: 2 })];
    const result = await queryChannels(mockPool(rows), FROM, TO, INBOUND, OUTBOUND);
    const ch = result[0];
    expect(ch['NO ANSWER']).toBe(2);
    expect(ch.breakdown.queue_no_agent).toBe(2);
    expect(ch.breakdown.ivr_hangup).toBe(0);
    expect(ch.breakdown.no_answer).toBe(0);
  });

  it('NO ANSWER sin lostDest → no_answer en breakdown', async () => {
    const rows = [makeRow({ dst: '1234', disposition: 'NO ANSWER', dstchannel: '', count: 4 })];
    const result = await queryChannels(mockPool(rows), FROM, TO, INBOUND, OUTBOUND);
    const ch = result[0];
    expect(ch['NO ANSWER']).toBe(4);
    expect(ch.breakdown.no_answer).toBe(4);
    expect(ch.breakdown.ivr_hangup).toBe(0);
    expect(ch.breakdown.queue_no_agent).toBe(0);
  });

  it('mix de razones en un mismo canal se acumula correctamente', async () => {
    const rows = [
      makeRow({ dst: 'hang',   disposition: 'NO ANSWER', dstchannel: '',        count: 5 }), // ivr_hangup
      makeRow({ dst: '1234',   disposition: 'NO ANSWER', dstchannel: '',        count: 3 }), // no_answer
      makeRow({ dst: '8001',   disposition: 'ANSWERED',  dstchannel: '',        count: 2 }), // queue_no_agent
      makeRow({ dst: '1234',   disposition: 'ANSWERED',  dstchannel: 'Agent/03', count: 4 }), // answered real
    ];
    const result = await queryChannels(mockPool(rows), FROM, TO, INBOUND, OUTBOUND);
    const ch = result[0];
    expect(ch.ANSWERED).toBe(4);
    expect(ch['NO ANSWER']).toBe(10); // 5 + 3 + 2
    expect(ch.breakdown.ivr_hangup).toBe(5);
    expect(ch.breakdown.no_answer).toBe(3);
    expect(ch.breakdown.queue_no_agent).toBe(2);
    expect(ch.total).toBe(14);
  });

  it('breakdown.ivr_hangup + no_answer + queue_no_agent === ch["NO ANSWER"]', async () => {
    const rows = [
      makeRow({ dst: 's',    disposition: 'NO ANSWER', dstchannel: '',       count: 7 }),
      makeRow({ dst: '1234', disposition: 'NO ANSWER', dstchannel: '',       count: 3 }),
      makeRow({ dst: '9000', disposition: 'ANSWERED',  dstchannel: '',       count: 2 }),
    ];
    const result = await queryChannels(mockPool(rows), FROM, TO, INBOUND, OUTBOUND);
    const ch = result[0];
    const sumBreakdown = ch.breakdown.ivr_hangup + ch.breakdown.no_answer + ch.breakdown.queue_no_agent;
    expect(sumBreakdown).toBe(ch['NO ANSWER']);
  });

  it('dos canales distintos tienen breakdown independiente', async () => {
    const rows = [
      makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c3',     dst: 'hang',  disposition: 'NO ANSWER', dstchannel: '', count: 3 }),
      makeRow({ channel: 'SIP/SALIENTE_CALL-00b2c3d4', dst: '1234',  disposition: 'NO ANSWER', dstchannel: '', count: 5 }),
    ];
    const result = await queryChannels(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'all');
    const byName = Object.fromEntries(result.map(c => [c.channel, c]));
    expect(byName['SIP/ENT_LIWA'].breakdown.ivr_hangup).toBe(3);
    expect(byName['SIP/ENT_LIWA'].breakdown.no_answer).toBe(0);
    expect(byName['SIP/SALIENTE_CALL'].breakdown.no_answer).toBe(5);
    expect(byName['SIP/SALIENTE_CALL'].breakdown.ivr_hangup).toBe(0);
  });

  it('BUSY y FAILED no contribuyen al breakdown de NO ANSWER', async () => {
    const rows = [
      makeRow({ dst: '1234', disposition: 'BUSY',   dstchannel: '', count: 2 }),
      makeRow({ dst: '1234', disposition: 'FAILED',  dstchannel: '', count: 1 }),
    ];
    const result = await queryChannels(mockPool(rows), FROM, TO, INBOUND, OUTBOUND);
    const ch = result[0];
    expect(ch.BUSY).toBe(2);
    expect(ch.FAILED).toBe(1);
    expect(ch.breakdown).toEqual({ ivr_hangup: 0, no_answer: 0, queue_no_agent: 0 });
  });

  it('canal filtrado no aparece en el resultado', async () => {
    const rows = [
      makeRow({ channel: 'SIP/OTRO-00a1b2c3', count: 3 }), // no está en INBOUND
    ];
    const result = await queryChannels(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'in');
    expect(result).toHaveLength(0);
  });

  it('resultado vacío cuando no hay filas', async () => {
    const result = await queryChannels(mockPool([]), FROM, TO, INBOUND, OUTBOUND);
    expect(result).toHaveLength(0);
  });

  it('el breakdown tiene exactamente las 3 claves esperadas', async () => {
    const rows = [makeRow({ count: 1 })];
    const result = await queryChannels(mockPool(rows), FROM, TO, INBOUND, OUTBOUND);
    expect(Object.keys(result[0].breakdown).sort()).toEqual(
      ['ivr_hangup', 'no_answer', 'queue_no_agent'].sort()
    );
  });

  it('total_billsec se acumula correctamente', async () => {
    const rows = [
      makeRow({ dst: '1234', disposition: 'ANSWERED', dstchannel: 'Agent/03', count: 2, total_billsec: 120 }),
      makeRow({ dst: '5678', disposition: 'ANSWERED', dstchannel: 'Agent/04', count: 1, total_billsec:  60 }),
    ];
    const result = await queryChannels(mockPool(rows), FROM, TO, INBOUND, OUTBOUND);
    expect(result[0].total_billsec).toBe(180);
  });

});
