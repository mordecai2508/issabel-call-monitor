'use strict';

/**
 * dashboard_perdidas_business_hours.test.js — feature #25 tests
 *
 * Local mirrors of isWithinBusinessHours and queryStats (post-#25) from
 * server.js, kept logic-identical to the implementation there.
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

/** Mirrors isWithinBusinessHours from server.js (#25) */
function isWithinBusinessHours(callHour, callDow, businessHours) {
  if (!businessHours || !Array.isArray(businessHours.days) || !businessHours.start || !businessHours.end) {
    return null;
  }
  const dayIndex = callDow - 1;
  if (!businessHours.days.includes(dayIndex)) return false;
  const startH = parseInt(businessHours.start.split(':')[0], 10);
  const endH   = parseInt(businessHours.end.split(':')[0], 10);
  return callHour >= startH && callHour < endH;
}

/** Mirrors queryStats from server.js (post-#25) */
async function queryStats(pool, from, to, inboundChannels, outboundChannels, direction = 'in', lostDests = ['s', 'hang', 'hangup'], businessHours = null) {
  const [rows] = await pool.query(
    `SELECT channel, dst, dstchannel, disposition,
            HOUR(calldate) AS call_hour, DAYOFWEEK(calldate) AS call_dow,
            COUNT(*) AS count,
            COALESCE(SUM(duration), 0) AS total_duration,
            COALESCE(SUM(billsec), 0)  AS total_billsec
     FROM cdr WHERE calldate >= ? AND calldate < ?
     GROUP BY channel, dst, dstchannel, disposition, HOUR(calldate), DAYOFWEEK(calldate)`,
    [from, to]
  );

  const base = {
    ANSWERED:    { count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0 },
    'NO ANSWER': {
      count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0,
      breakdown: { no_answer: 0, ivr_hangup: 0, queue_no_agent: 0, ivr_hangup_business: 0, ivr_hangup_offhours: 0 },
    },
    BUSY:   { count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0 },
    FAILED: { count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0 },
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
        if (reason === 'ivr_hangup') {
          const inHours = isWithinBusinessHours(Number(r.call_hour), Number(r.call_dow), businessHours);
          if (inHours === true)  base['NO ANSWER'].breakdown.ivr_hangup_business += Number(r.count);
          if (inHours === false) base['NO ANSWER'].breakdown.ivr_hangup_offhours += Number(r.count);
        }
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

// ── Helpers ────────────────────────────────────────────────────────────────

function mockPool(rows) {
  return { query: jest.fn().mockResolvedValue([rows]) };
}

function makeRow(overrides = {}) {
  return {
    channel:        'SIP/ENT_LIWA-1',
    dst:            'hang',
    dstchannel:     '',
    disposition:    'NO ANSWER',
    call_hour:      10,   // 10:xx AM
    call_dow:       2,    // lunes (MySQL DAYOFWEEK: 1=domingo, 2=lunes)
    count:          1,
    total_duration: 15,
    total_billsec:  0,
    ...overrides,
  };
}

const FROM = '2026-06-17 00:00:00';
const TO   = '2026-06-18 00:00:00';
const INBOUND    = ['SIP/ENT_LIWA'];
const OUTBOUND   = ['SIP/SALIENTE_CALL'];
const LOST_DESTS = ['s', 'hang', 'hangup'];

const BH_WEEKDAYS = { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };

// ── isWithinBusinessHours ──────────────────────────────────────────────────

describe('isWithinBusinessHours (feature #25)', () => {

  it('devuelve null cuando businessHours es null', () => {
    expect(isWithinBusinessHours(10, 2, null)).toBeNull();
  });

  it('devuelve null cuando businessHours no tiene days/start/end', () => {
    expect(isWithinBusinessHours(10, 2, {})).toBeNull();
    expect(isWithinBusinessHours(10, 2, { days: [1] })).toBeNull();
  });

  it('devuelve true para hora dentro del horario en día laborable', () => {
    // callDow=2 → dayIndex=1 (lunes), en days=[1-5], hora=10 dentro de 08-18
    expect(isWithinBusinessHours(10, 2, BH_WEEKDAYS)).toBe(true);
  });

  it('devuelve false para hora fuera del horario en día laborable', () => {
    // hora 20 >= endH 18
    expect(isWithinBusinessHours(20, 2, BH_WEEKDAYS)).toBe(false);
  });

  it('devuelve false para día no laborable (sábado)', () => {
    // callDow=7 → dayIndex=6 (sábado), no está en days=[1-5]
    expect(isWithinBusinessHours(10, 7, BH_WEEKDAYS)).toBe(false);
  });

  it('devuelve false para día no laborable (domingo)', () => {
    // callDow=1 → dayIndex=0 (domingo)
    expect(isWithinBusinessHours(10, 1, BH_WEEKDAYS)).toBe(false);
  });

  it('límite inicio: hora exactamente en startH es dentro del horario', () => {
    expect(isWithinBusinessHours(8, 2, BH_WEEKDAYS)).toBe(true);
  });

  it('límite fin: hora exactamente en endH es fuera del horario', () => {
    expect(isWithinBusinessHours(18, 2, BH_WEEKDAYS)).toBe(false);
  });

  it('una hora antes del inicio es fuera del horario', () => {
    expect(isWithinBusinessHours(7, 2, BH_WEEKDAYS)).toBe(false);
  });

});

// ── queryStats con businessHours ──────────────────────────────────────────

describe('queryStats — breakdown ivr_hangup_business/ivr_hangup_offhours (feature #25)', () => {

  it('sin businessHours configurado ambas sub-claves quedan en 0', async () => {
    const rows = [makeRow({ dst: 'hang', call_hour: 10, call_dow: 2, count: 3 })];
    const { dispositions } = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS, null);
    expect(dispositions['NO ANSWER'].breakdown.ivr_hangup).toBe(3);
    expect(dispositions['NO ANSWER'].breakdown.ivr_hangup_business).toBe(0);
    expect(dispositions['NO ANSWER'].breakdown.ivr_hangup_offhours).toBe(0);
  });

  it('ivr_hangup en horario laboral se suma a ivr_hangup_business', async () => {
    const rows = [makeRow({ dst: 'hang', call_hour: 10, call_dow: 2, count: 2 })];
    const { dispositions } = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS, BH_WEEKDAYS);
    const bd = dispositions['NO ANSWER'].breakdown;
    expect(bd.ivr_hangup).toBe(2);
    expect(bd.ivr_hangup_business).toBe(2);
    expect(bd.ivr_hangup_offhours).toBe(0);
  });

  it('ivr_hangup fuera de horario se suma a ivr_hangup_offhours', async () => {
    const rows = [makeRow({ dst: 'hang', call_hour: 21, call_dow: 2, count: 4 })]; // hora 21, fuera de 08-18
    const { dispositions } = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS, BH_WEEKDAYS);
    const bd = dispositions['NO ANSWER'].breakdown;
    expect(bd.ivr_hangup).toBe(4);
    expect(bd.ivr_hangup_business).toBe(0);
    expect(bd.ivr_hangup_offhours).toBe(4);
  });

  it('ivr_hangup en día no laborable (sábado) se suma a ivr_hangup_offhours', async () => {
    const rows = [makeRow({ dst: 'hang', call_hour: 10, call_dow: 7, count: 5 })]; // sábado
    const { dispositions } = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS, BH_WEEKDAYS);
    const bd = dispositions['NO ANSWER'].breakdown;
    expect(bd.ivr_hangup_business).toBe(0);
    expect(bd.ivr_hangup_offhours).toBe(5);
  });

  it('mix de horario y fuera de horario se reparte correctamente', async () => {
    const rows = [
      makeRow({ dst: 'hang',   call_hour: 10, call_dow: 2, count: 3 }), // lunes 10h → en horario
      makeRow({ dst: 's',      call_hour: 20, call_dow: 3, count: 2 }), // martes 20h → fuera
      makeRow({ dst: 'hangup', call_hour:  9, call_dow: 7, count: 1 }), // sábado → fuera
    ];
    const { dispositions } = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS, BH_WEEKDAYS);
    const bd = dispositions['NO ANSWER'].breakdown;
    expect(bd.ivr_hangup).toBe(6);           // 3 + 2 + 1
    expect(bd.ivr_hangup_business).toBe(3);
    expect(bd.ivr_hangup_offhours).toBe(3);  // 2 + 1
  });

  it('ivr_hangup_business + ivr_hangup_offhours = ivr_hangup cuando businessHours está configurado', async () => {
    const rows = [
      makeRow({ dst: 'hang', call_hour: 10, call_dow: 2, count: 5 }),
      makeRow({ dst: 's',    call_hour: 22, call_dow: 4, count: 3 }),
    ];
    const { dispositions } = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS, BH_WEEKDAYS);
    const bd = dispositions['NO ANSWER'].breakdown;
    expect(bd.ivr_hangup_business + bd.ivr_hangup_offhours).toBe(bd.ivr_hangup);
  });

  it('no_answer y queue_no_agent no contribuyen a los sub-buckets de ivr_hangup', async () => {
    const rows = [
      makeRow({ dst: '1234', disposition: 'NO ANSWER', dstchannel: '', call_hour: 10, call_dow: 2, count: 2 }), // no_answer
      makeRow({ dst: '8000', disposition: 'ANSWERED',  dstchannel: '', call_hour: 10, call_dow: 2, count: 3 }), // queue_no_agent
    ];
    const { dispositions } = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS, BH_WEEKDAYS);
    const bd = dispositions['NO ANSWER'].breakdown;
    expect(bd.no_answer).toBe(2);
    expect(bd.queue_no_agent).toBe(3);
    expect(bd.ivr_hangup).toBe(0);
    expect(bd.ivr_hangup_business).toBe(0);
    expect(bd.ivr_hangup_offhours).toBe(0);
  });

  it('la suma total no_answer + ivr_hangup + queue_no_agent sigue igual al count de NO ANSWER', async () => {
    const rows = [
      makeRow({ dst: 'hang', call_hour: 10, call_dow: 2, count: 4 }),                             // ivr_hangup
      makeRow({ dst: '1234', disposition: 'NO ANSWER', dstchannel: '', call_hour: 9, call_dow: 2, count: 3 }), // no_answer
      makeRow({ dst: '8000', disposition: 'ANSWERED',  dstchannel: '', call_hour: 11, call_dow: 3, count: 2 }), // queue_no_agent
      makeRow({ dst: '1234', disposition: 'ANSWERED',  dstchannel: 'Agent/03', call_hour: 10, call_dow: 2, count: 5 }), // contestada real
    ];
    const { dispositions } = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS, BH_WEEKDAYS);
    const noAnswer = dispositions['NO ANSWER'];
    const sumBreakdown = noAnswer.breakdown.no_answer + noAnswer.breakdown.ivr_hangup + noAnswer.breakdown.queue_no_agent;
    expect(sumBreakdown).toBe(noAnswer.count);
    expect(noAnswer.count).toBe(9); // 4 + 3 + 2
  });

  it('breakdown tiene exactamente las 5 claves esperadas', async () => {
    const rows = [makeRow({ dst: 'hang', call_hour: 10, call_dow: 2, count: 1 })];
    const { dispositions } = await queryStats(mockPool(rows), FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS, BH_WEEKDAYS);
    expect(Object.keys(dispositions['NO ANSWER'].breakdown).sort()).toEqual(
      ['ivr_hangup', 'ivr_hangup_business', 'ivr_hangup_offhours', 'no_answer', 'queue_no_agent'].sort()
    );
  });

});
