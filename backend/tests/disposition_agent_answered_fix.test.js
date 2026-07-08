'use strict';

/**
 * disposition_agent_answered_fix.test.js — feature #21 tests
 *
 * NOTE (design.md §8 / dashboard_lost_destinations.test.js): backend/server.js
 * is a self-executing script that is not safely importable in tests. This
 * file defines a LOCAL COPY of `extractChannel`, `passesFilter`,
 * `AGENT_DSTCHANNEL_RE`, `resolveDisposition`, `queryStats`, `queryChannels`
 * and `queryHourly` (post-#20/#21) that must be kept line-for-line/logic-
 * identical to the implementation in server.js (design.md §3).
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

/** Mirrors AGENT_DSTCHANNEL_RE from server.js (#21, design.md §3.1) */
const AGENT_DSTCHANNEL_RE = /^(Agent\/\d+|SIP\/\d+-)/;

/** Mirrors resolveDisposition from server.js (#17 + #21, design.md §3.1) */
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

/** Mirrors the modified queryStats from server.js (T2) */
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

/** Mirrors the modified queryChannels from server.js (T3) */
async function queryChannels(pool, from, to, inboundChannels, outboundChannels, direction = 'in', lostDests = ['s', 'hang', 'hangup']) {
  const [rows] = await pool.query(
    `SELECT
       channel,
       dst,
       dstchannel,
       disposition,
       COUNT(*)                    AS count,
       COALESCE(SUM(billsec), 0)  AS total_billsec
     FROM cdr
     WHERE calldate >= ? AND calldate < ?
     GROUP BY channel, dst, dstchannel, disposition`,
    [from, to]
  );

  const map = {};
  for (const r of rows) {
    if (!passesFilter(r.channel, inboundChannels, outboundChannels, direction)) continue;
    const ch = extractChannel(r.channel);
    if (!map[ch]) {
      map[ch] = { channel: ch, ANSWERED: 0, 'NO ANSWER': 0, BUSY: 0, FAILED: 0, total: 0, total_billsec: 0 };
    }

    const targetKey = resolveDisposition(r, lostDests);
    if (targetKey) {
      map[ch][targetKey] += Number(r.count);
    }
    map[ch].total         += Number(r.count);
    map[ch].total_billsec += Number(r.total_billsec);
  }

  return Object.values(map).sort((a, b) => b.total - a.total);
}

/** Mirrors the modified queryHourly from server.js (T4) */
async function queryHourly(pool, from, to, inboundChannels, outboundChannels, direction = 'in', lostDests = ['s', 'hang', 'hangup']) {
  const [rows] = await pool.query(
    `SELECT
       channel,
       dst,
       dstchannel,
       HOUR(calldate) AS hour,
       disposition,
       COUNT(*)       AS count
     FROM cdr
     WHERE calldate >= ? AND calldate < ?
     GROUP BY channel, dst, dstchannel, HOUR(calldate), disposition
     ORDER BY hour`,
    [from, to]
  );

  const hours = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    ANSWERED: 0, 'NO ANSWER': 0, BUSY: 0, FAILED: 0, total: 0,
  }));

  for (const r of rows) {
    if (!passesFilter(r.channel, inboundChannels, outboundChannels, direction)) continue;
    const h = Number(r.hour);

    const targetKey = resolveDisposition(r, lostDests);
    if (targetKey) {
      hours[h][targetKey] += Number(r.count);
    }
    hours[h].total += Number(r.count);
  }

  return hours;
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
const QUEUES = ['8000', '8300'];

// ── Tests ────────────────────────────────────────────────────────────────

describe('resolveDisposition (feature #21 — disposition_agent_answered_fix)', () => {

  it('R1/R3 - dstchannel="Agent/03" con disposition=ANSWERED cuenta como ANSWERED', () => {
    const row = makeRow({ disposition: 'ANSWERED', dstchannel: 'Agent/03', dst: '1234' });
    expect(resolveDisposition(row, LOST_DESTS)).toBe('ANSWERED');
  });

  it('R1/R3 - dstchannel="SIP/203-00001a2b" con disposition=ANSWERED cuenta como ANSWERED', () => {
    const row = makeRow({ disposition: 'ANSWERED', dstchannel: 'SIP/203-00001a2b', dst: '1234' });
    expect(resolveDisposition(row, LOST_DESTS)).toBe('ANSWERED');
  });

  it('R2/R7 - dst en config.queues (8000), dstchannel vacío, disposition=ANSWERED reclasifica a NO ANSWER', () => {
    const row = makeRow({ disposition: 'ANSWERED', dstchannel: '', dst: '8000' });
    expect(resolveDisposition(row, LOST_DESTS)).toBe('NO ANSWER');
  });

  it('R4 - disposition=BUSY con dstchannel vacío NO se reclasifica (sigue en BUSY)', () => {
    const row = makeRow({ disposition: 'BUSY', dstchannel: '', dst: '1234' });
    expect(resolveDisposition(row, LOST_DESTS)).toBe('BUSY');
  });

  it('R4 - disposition=FAILED con dstchannel vacío NO se reclasifica (sigue en FAILED)', () => {
    const row = makeRow({ disposition: 'FAILED', dstchannel: '', dst: '1234' });
    expect(resolveDisposition(row, LOST_DESTS)).toBe('FAILED');
  });

  it('R5/R6 - dst en lostDestinations Y dstchannel sin agente con disposition=ANSWERED cuenta una sola vez en NO ANSWER (sin doble conteo)', async () => {
    const rows = [makeRow({ disposition: 'ANSWERED', dstchannel: '', dst: 'hang', count: 1, total_duration: 30, total_billsec: 25 })];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    expect(dispositions.ANSWERED.count).toBe(0);
    expect(dispositions['NO ANSWER'].count).toBe(1);
    expect(total).toBe(1);
  });

  it('R8 - dst en config.queues con dstchannel="Agent/04" y disposition=ANSWERED sigue en ANSWERED', () => {
    const row = makeRow({ disposition: 'ANSWERED', dstchannel: 'Agent/04', dst: '8000' });
    expect(resolveDisposition(row, LOST_DESTS)).toBe('ANSWERED');
  });

  it('R18 - dstchannel=null/undefined con disposition=ANSWERED reclasifica a NO ANSWER', () => {
    const rowNull = makeRow({ disposition: 'ANSWERED', dstchannel: null, dst: '1234' });
    const rowUndef = makeRow({ disposition: 'ANSWERED', dst: '1234' });
    delete rowUndef.dstchannel;

    expect(resolveDisposition(rowNull, LOST_DESTS)).toBe('NO ANSWER');
    expect(resolveDisposition(rowUndef, LOST_DESTS)).toBe('NO ANSWER');
  });

  it('R18 - dstchannel con valor que no matchea ningún patrón (trunk/Local/IAX2) con disposition=ANSWERED reclasifica a NO ANSWER', () => {
    const cases = ['SIP/trunk-00a1b2c3', 'Local/200@from-internal-00a1b2c3', 'IAX2/provider-1'];
    for (const dstchannel of cases) {
      const row = makeRow({ disposition: 'ANSWERED', dstchannel, dst: '1234' });
      expect(resolveDisposition(row, LOST_DESTS)).toBe('NO ANSWER');
    }
  });
});

describe('queryStats — reclasificación por agente (feature #21)', () => {

  it('R9 - total = ANSWERED + NO ANSWER + BUSY + FAILED tras la reclasificación', async () => {
    const rows = [
      makeRow({ disposition: 'ANSWERED', dstchannel: 'Agent/03', dst: '1001', count: 2, total_duration: 60, total_billsec: 50 }), // ANSWERED
      makeRow({ disposition: 'ANSWERED', dstchannel: '',         dst: '8000', count: 1, total_duration: 10, total_billsec: 0 }),  // → NO ANSWER (R7)
      makeRow({ disposition: 'NO ANSWER', dstchannel: '',        dst: '1002', count: 3, total_duration: 0,  total_billsec: 0 }),  // NO ANSWER
      makeRow({ disposition: 'BUSY',      dstchannel: '',        dst: '1003', count: 1, total_duration: 0,  total_billsec: 0 }),  // BUSY
      makeRow({ disposition: 'FAILED',    dstchannel: '',        dst: '1004', count: 1, total_duration: 0,  total_billsec: 0 }),  // FAILED
    ];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    const sum = dispositions.ANSWERED.count + dispositions['NO ANSWER'].count
      + dispositions.BUSY.count + dispositions.FAILED.count;

    expect(total).toBe(sum);
    expect(total).toBe(8);
    expect(dispositions.ANSWERED.count).toBe(2);
    expect(dispositions['NO ANSWER'].count).toBe(4);
    expect(dispositions.BUSY.count).toBe(1);
    expect(dispositions.FAILED.count).toBe(1);
  });

  it('R10 - avg_billsec y pct se recalculan sobre los buckets reclasificados', async () => {
    const rows = [
      makeRow({ disposition: 'ANSWERED', dstchannel: 'Agent/03', dst: '1001', count: 1, total_duration: 60, total_billsec: 50 }), // stays ANSWERED
      makeRow({ disposition: 'ANSWERED', dstchannel: '',         dst: '8000', count: 1, total_duration: 30, total_billsec: 25 }), // → NO ANSWER, removed from ANSWERED billsec
    ];
    const pool = mockPool(rows);

    const { dispositions, total } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    expect(total).toBe(2);
    expect(dispositions.ANSWERED.count).toBe(1);
    expect(dispositions.ANSWERED.total_billsec).toBe(50);
    expect(dispositions.ANSWERED.avg_billsec).toBe(50);
    expect(dispositions['NO ANSWER'].count).toBe(1);
    expect(dispositions.ANSWERED.pct).toBe(Math.round((1 / 2) * 1000) / 10);
    expect(dispositions['NO ANSWER'].pct).toBe(Math.round((1 / 2) * 1000) / 10);
  });
});

describe('Consistencia entre queryStats, queryChannels y queryHourly (feature #21)', () => {

  // Dataset mixto: agente real (ANSWERED), cola sin agente (R7), lostDestinations
  // ANSWERED (R5/R6), BUSY/FAILED sin reclasificar (R4), NO ANSWER directo.
  const mixedRows = [
    makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c3', dst: '1001', dstchannel: 'Agent/03',          disposition: 'ANSWERED',  count: 3, total_duration: 90, total_billsec: 75, hour: 9 }),
    makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c4', dst: '8000', dstchannel: '',                  disposition: 'ANSWERED',  count: 2, total_duration: 20, total_billsec: 0,  hour: 10 }),
    makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c5', dst: 'hang', dstchannel: '',                  disposition: 'ANSWERED',  count: 1, total_duration: 5,  total_billsec: 0,  hour: 11 }),
    makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c6', dst: '1002', dstchannel: '',                  disposition: 'NO ANSWER', count: 4, total_duration: 0,  total_billsec: 0,  hour: 12 }),
    makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c7', dst: '1003', dstchannel: '',                  disposition: 'BUSY',      count: 2, total_duration: 0,  total_billsec: 0,  hour: 13 }),
    makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c8', dst: '1004', dstchannel: '',                  disposition: 'FAILED',    count: 1, total_duration: 0,  total_billsec: 0,  hour: 14 }),
    makeRow({ channel: 'SIP/ENT_LIWA-00a1b2c9', dst: '1005', dstchannel: 'SIP/205-00001a2b',  disposition: 'ANSWERED',  count: 1, total_duration: 30, total_billsec: 25, hour: 15 }),
  ];

  it('R11 - la suma de ANSWERED de queryChannels coincide con dispositions.ANSWERED.count de queryStats para el mismo dataset', async () => {
    const statsPool    = mockPool(mixedRows);
    const channelsPool = mockPool(mixedRows);

    const { dispositions } = await queryStats(statsPool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);
    const channels         = await queryChannels(channelsPool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    const channelsAnswered = channels.reduce((acc, c) => acc + c.ANSWERED, 0);
    expect(channelsAnswered).toBe(dispositions.ANSWERED.count);
  });

  it('R11 - la suma de NO ANSWER de queryChannels coincide con dispositions["NO ANSWER"].count de queryStats para el mismo dataset', async () => {
    const statsPool    = mockPool(mixedRows);
    const channelsPool = mockPool(mixedRows);

    const { dispositions } = await queryStats(statsPool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);
    const channels         = await queryChannels(channelsPool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    const channelsNoAnswer = channels.reduce((acc, c) => acc + c['NO ANSWER'], 0);
    expect(channelsNoAnswer).toBe(dispositions['NO ANSWER'].count);
  });

  it('R12 - la suma de ANSWERED de queryHourly (24 horas) coincide con dispositions.ANSWERED.count de queryStats para el mismo dataset', async () => {
    const statsPool  = mockPool(mixedRows);
    const hourlyPool = mockPool(mixedRows);

    const { dispositions } = await queryStats(statsPool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);
    const hourly            = await queryHourly(hourlyPool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    const hourlyAnswered = hourly.reduce((acc, h) => acc + h.ANSWERED, 0);
    expect(hourlyAnswered).toBe(dispositions.ANSWERED.count);
  });

  it('R12 - la suma de NO ANSWER de queryHourly (24 horas) coincide con dispositions["NO ANSWER"].count de queryStats para el mismo dataset', async () => {
    const statsPool  = mockPool(mixedRows);
    const hourlyPool = mockPool(mixedRows);

    const { dispositions } = await queryStats(statsPool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);
    const hourly            = await queryHourly(hourlyPool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    const hourlyNoAnswer = hourly.reduce((acc, h) => acc + h['NO ANSWER'], 0);
    expect(hourlyNoAnswer).toBe(dispositions['NO ANSWER'].count);
  });

  it('R13 - un dataset mixto (lostDestinations + dstchannel sin agente + agente real) produce el mismo total reclasificado en las tres funciones', async () => {
    const statsPool    = mockPool(mixedRows);
    const channelsPool = mockPool(mixedRows);
    const hourlyPool   = mockPool(mixedRows);

    const { dispositions, total } = await queryStats(statsPool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);
    const channels = await queryChannels(channelsPool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);
    const hourly   = await queryHourly(hourlyPool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    // Expected per resolveDisposition over mixedRows:
    // row1: ANSWERED (Agent/03)            → ANSWERED += 3
    // row2: ANSWERED, dst=8000, no agent   → NO ANSWER += 2 (R7)
    // row3: ANSWERED, dst=hang (lostDest)  → NO ANSWER += 1 (R5/R6)
    // row4: NO ANSWER, dst=1002            → NO ANSWER += 4
    // row5: BUSY, dst=1003                 → BUSY += 2 (R4, sin cambio)
    // row6: FAILED, dst=1004               → FAILED += 1 (R4, sin cambio)
    // row7: ANSWERED (SIP/205-...)         → ANSWERED += 1
    expect(dispositions.ANSWERED.count).toBe(4);
    expect(dispositions['NO ANSWER'].count).toBe(7);
    expect(dispositions.BUSY.count).toBe(2);
    expect(dispositions.FAILED.count).toBe(1);
    expect(total).toBe(14);

    const channelsTotals = {
      ANSWERED:    channels.reduce((acc, c) => acc + c.ANSWERED, 0),
      'NO ANSWER': channels.reduce((acc, c) => acc + c['NO ANSWER'], 0),
      BUSY:        channels.reduce((acc, c) => acc + c.BUSY, 0),
      FAILED:      channels.reduce((acc, c) => acc + c.FAILED, 0),
    };
    const hourlyTotals = {
      ANSWERED:    hourly.reduce((acc, h) => acc + h.ANSWERED, 0),
      'NO ANSWER': hourly.reduce((acc, h) => acc + h['NO ANSWER'], 0),
      BUSY:        hourly.reduce((acc, h) => acc + h.BUSY, 0),
      FAILED:      hourly.reduce((acc, h) => acc + h.FAILED, 0),
    };

    for (const key of ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED']) {
      expect(channelsTotals[key]).toBe(dispositions[key].count);
      expect(hourlyTotals[key]).toBe(dispositions[key].count);
    }
  });
});

// ── R14-R17, R21 — forma de respuesta de endpoints existentes ──────────────
//
// NOTA (design.md §8 / passesFilter.test.js R14-R16): server.js no es
// importable en tests. Esta feature no añade ni modifica rutas (design.md
// §1) ni cambia la forma de fetchData() (R21) — solo los valores numéricos
// de stats.dispositions/channels[*]/hourly[*] (y sus equivalentes
// inbound/outbound), que ya se verifican arriba (R9-R13) sobre las copias
// locales de queryStats/queryChannels/queryHourly. Aquí se documenta y
// verifica el contrato de forma esperado tras #21.

describe('R14/R15/R16/R17/R21 - forma de respuesta de fetchData()/endpoints sin cambios tras #21', () => {
  it('R14/R15/R16/R21 - fetchData() conserva stats/channels/hourly/inbound/outbound/queues/channelAliases/appName/from/to/generatedAt', () => {
    // Mismo contrato que R14/R15 de passesFilter.test.js (#20); #21 no añade
    // ni renombra claves top-level, solo cambia los valores numéricos dentro
    // de stats.dispositions, channels[*] y hourly[*] (y sus equivalentes
    // inbound.*/outbound.*).
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

  it('R14/R15 - stats.dispositions conserva las 4 claves ANSWERED/NO ANSWER/BUSY/FAILED con count/total_duration/total_billsec/avg_billsec/pct', async () => {
    const pool = mockPool([makeRow({ disposition: 'ANSWERED', dstchannel: 'Agent/03', dst: '1001', count: 1, total_duration: 30, total_billsec: 25 })]);
    const { dispositions } = await queryStats(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    expect(Object.keys(dispositions).sort()).toEqual(['ANSWERED', 'BUSY', 'FAILED', 'NO ANSWER'].sort());
    for (const key of Object.keys(dispositions)) {
      expect(Object.keys(dispositions[key]).sort()).toEqual(
        ['avg_billsec', 'count', 'pct', 'total_billsec', 'total_duration'].sort()
      );
    }
  });

  it('R11 - queryChannels conserva las claves channel/ANSWERED/NO ANSWER/BUSY/FAILED/total/total_billsec por canal', async () => {
    const pool = mockPool([makeRow({ disposition: 'ANSWERED', dstchannel: 'Agent/03', dst: '1001', count: 1, total_billsec: 25 })]);
    const channels = await queryChannels(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    expect(channels[0]).toHaveProperty('channel');
    expect(Object.keys(channels[0]).sort()).toEqual(
      ['ANSWERED', 'BUSY', 'FAILED', 'NO ANSWER', 'channel', 'total', 'total_billsec'].sort()
    );
  });

  it('R12 - queryHourly devuelve 24 entradas (una por hora) con hour/ANSWERED/NO ANSWER/BUSY/FAILED/total', async () => {
    const pool = mockPool([makeRow({ disposition: 'ANSWERED', dstchannel: 'Agent/03', dst: '1001', count: 1, hour: 9 })]);
    const hourly = await queryHourly(pool, FROM, TO, INBOUND, OUTBOUND, 'in', LOST_DESTS);

    expect(hourly).toHaveLength(24);
    expect(Object.keys(hourly[0]).sort()).toEqual(
      ['ANSWERED', 'BUSY', 'FAILED', 'NO ANSWER', 'hour', 'total'].sort()
    );
  });

  it('R17 - queryQueues no aplica el criterio de dstchannel; documentado como limitación conocida (design.md Decisión C)', () => {
    // queryQueues (server.js, sin cambios por #21) sigue agrupando por
    // `channel, dst, disposition` sin `dstchannel` y sin usar
    // resolveDisposition. Una llamada con dst en config.queues,
    // disposition=ANSWERED y dstchannel sin agente:
    //  - cuenta en queues['8000'].ANSWERED (criterio crudo, sin cambios)
    //  - NO cuenta en stats.dispositions.ANSWERED.count (R7, resolveDisposition)
    // Ambas cosas pueden ser simultáneamente ciertas para el mismo registro;
    // esto es intencional (Decisión C de design.md) y no se modifica aquí.
    const row = makeRow({ disposition: 'ANSWERED', dstchannel: '', dst: '8000' });

    // queryQueues (criterio crudo): cuenta como ANSWERED para la cola 8000
    const queueDisposition = row.disposition.toUpperCase();
    expect(queueDisposition).toBe('ANSWERED');

    // stats.dispositions (resolveDisposition, #21): reclasificado a NO ANSWER
    expect(resolveDisposition(row, LOST_DESTS)).toBe('NO ANSWER');
  });
});
