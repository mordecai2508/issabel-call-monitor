'use strict';

/**
 * reclassification_consistency.test.js — feature #27 tests
 *
 * Tests that cdrService and statsService apply resolveDisposition logic
 * consistently: ANSWERED with wrong dstchannel → NO ANSWER, dst in
 * lostDests → NO ANSWER, and that disposition filters work on reclassified
 * values.
 *
 * All helpers are local mirrors to avoid importing server.js.
 */

// ── Local mirrors ─────────────────────────────────────────────────────────────

const AGENT_DSTCHANNEL_RE    = /^(Agent\/\d+|SIP\/\d+-)/;
const AGENT_DSTCHANNEL_MYSQL = '^(Agent/[0-9]+|SIP/[0-9]+-)';

function resolveDispositionLocal(disposition, dst, dstchannel, lostDests) {
  const d = (disposition || '').toUpperCase();
  let key = ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED'].includes(d) ? d : null;
  if (!key) return disposition;
  if (lostDests.includes(dst) && key !== 'NO ANSWER') key = 'NO ANSWER';
  if (key === 'ANSWERED' && !AGENT_DSTCHANNEL_RE.test(dstchannel || '')) key = 'NO ANSWER';
  return key;
}

function reclassifyCaseExprs(lostDests) {
  if (!lostDests || lostDests.length === 0) {
    return {
      answeredExpr: "SUM(disposition = 'ANSWERED')",
      noAnswerExpr: "SUM(disposition = 'NO ANSWER')",
      extraParams:  [],
    };
  }
  const lp = lostDests.map(() => '?').join(',');
  const re = AGENT_DSTCHANNEL_MYSQL;
  const answeredExpr =
    `SUM(CASE WHEN dst IN (${lp}) THEN 0 ` +
    `WHEN UPPER(disposition) = 'ANSWERED' AND (dstchannel IS NULL OR dstchannel = '' OR dstchannel NOT REGEXP ?) THEN 0 ` +
    `WHEN UPPER(disposition) = 'ANSWERED' THEN 1 ELSE 0 END)`;
  const noAnswerExpr =
    `SUM(CASE WHEN dst IN (${lp}) THEN 1 ` +
    `WHEN UPPER(disposition) = 'ANSWERED' AND (dstchannel IS NULL OR dstchannel = '' OR dstchannel NOT REGEXP ?) THEN 1 ` +
    `WHEN UPPER(disposition) = 'NO ANSWER' THEN 1 ELSE 0 END)`;
  return {
    answeredExpr,
    noAnswerExpr,
    extraParams: [...lostDests, re, ...lostDests, re],
  };
}

// Local mirror of mapRow (post-#27 cdrService)
function mapRow(row, extractChannelFn, lostDests = []) {
  const disp = lostDests.length > 0
    ? resolveDispositionLocal(row.disposition, row.dst, row.dstchannel || '', lostDests)
    : row.disposition;
  return {
    calldate:    row.calldate instanceof Date ? row.calldate.toISOString() : row.calldate,
    src:         row.src,
    dst:         row.dst,
    channel:     extractChannelFn ? extractChannelFn(row.channel) : row.channel,
    dstchannel:  row.dstchannel || '',
    duration:    Number(row.duration),
    billsec:     Number(row.billsec),
    disposition: disp || row.disposition,
  };
}

// Local mirror of buildWhereClause (post-#27 cdrService)
function buildWhereClause(filters, lostDests = []) {
  const { from, to, trunk, origin, disposition } = filters;
  const conditions = [];
  const params = [];

  conditions.push('calldate >= ?'); params.push(from + ' 00:00:00');
  conditions.push('calldate <= ?'); params.push(to + ' 23:59:59');

  if (trunk)  { conditions.push("channel LIKE CONCAT(?, '%')");        params.push(trunk); }
  if (origin) { conditions.push("src LIKE CONCAT('%', ?, '%')");       params.push(origin); }

  if (disposition) {
    const d = disposition.toUpperCase();
    if (lostDests.length > 0 && d === 'NO ANSWER') {
      const lp = lostDests.map(() => '?').join(',');
      conditions.push(
        `(UPPER(disposition) = 'NO ANSWER' OR dst IN (${lp}) OR ` +
        `(UPPER(disposition) = 'ANSWERED' AND (dstchannel IS NULL OR dstchannel = '' OR dstchannel NOT REGEXP ?)))`
      );
      params.push(...lostDests, AGENT_DSTCHANNEL_MYSQL);
    } else if (lostDests.length > 0 && d === 'ANSWERED') {
      const lp = lostDests.map(() => '?').join(',');
      conditions.push(
        `(UPPER(disposition) = 'ANSWERED' AND dst NOT IN (${lp}) AND dstchannel REGEXP ?)`
      );
      params.push(...lostDests, AGENT_DSTCHANNEL_MYSQL);
    } else {
      conditions.push('UPPER(disposition) = UPPER(?)');
      params.push(disposition);
    }
  }

  return { conditions, params };
}

// Local mirror of queryHistorical (post-#27 statsService) — simplified to 'custom' only
async function queryHistoricalCustom(pool, from, to, lostDests = []) {
  const fromTs = from + ' 00:00:00';
  const toTs   = to   + ' 23:59:59';
  const { answeredExpr, noAnswerExpr, extraParams } = reclassifyCaseExprs(lostDests);

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total, ${answeredExpr} AS answered, ${noAnswerExpr} AS no_answer,
            SUM(disposition = 'BUSY') AS busy, SUM(disposition = 'FAILED') AS failed,
            ROUND(AVG(duration), 2) AS avg_duration
     FROM cdr WHERE calldate >= ? AND calldate <= ?`,
    [...extraParams, fromTs, toTs]
  );
  const r = rows[0];
  return {
    total:    Number(r.total),
    answered: Number(r.answered),
    no_answer: Number(r.no_answer),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockPool(rows) {
  return { query: jest.fn().mockResolvedValue([rows]) };
}

function extractChannel(raw) {
  if (!raw) return 'Desconocido';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

const LOST_DESTS = ['s', 'hang', 'hangup'];

function makeCdrRow(overrides = {}) {
  return {
    calldate:    new Date('2026-06-17T10:00:00.000Z'),
    src:         '3001234567',
    dst:         '1000',
    channel:     'SIP/ENT_LIWA-00a1b2c3',
    dstchannel:  'Agent/03',
    duration:    90,
    billsec:     85,
    disposition: 'ANSWERED',
    ...overrides,
  };
}

// ── resolveDispositionLocal ───────────────────────────────────────────────────

describe('resolveDispositionLocal (mirrors server.js resolveDisposition)', () => {

  it('ANSWERED con dstchannel de agente real → ANSWERED', () => {
    expect(resolveDispositionLocal('ANSWERED', '1000', 'Agent/03', LOST_DESTS)).toBe('ANSWERED');
    expect(resolveDispositionLocal('ANSWERED', '1000', 'SIP/1001-001', LOST_DESTS)).toBe('ANSWERED');
  });

  it('ANSWERED con dstchannel vacío → NO ANSWER (queue_no_agent)', () => {
    expect(resolveDispositionLocal('ANSWERED', '1000', '',   LOST_DESTS)).toBe('NO ANSWER');
    expect(resolveDispositionLocal('ANSWERED', '1000', null, LOST_DESTS)).toBe('NO ANSWER');
  });

  it('ANSWERED con dst en lostDests → NO ANSWER (ivr_hangup)', () => {
    expect(resolveDispositionLocal('ANSWERED', 'hang', 'Agent/03', LOST_DESTS)).toBe('NO ANSWER');
  });

  it('NO ANSWER puro → NO ANSWER sin cambio', () => {
    expect(resolveDispositionLocal('NO ANSWER', '1000', '', LOST_DESTS)).toBe('NO ANSWER');
  });

  it('BUSY y FAILED no son reclasificados', () => {
    expect(resolveDispositionLocal('BUSY',   '1000', '', LOST_DESTS)).toBe('BUSY');
    expect(resolveDispositionLocal('FAILED', '1000', '', LOST_DESTS)).toBe('FAILED');
  });

  it('con lostDests vacío la regla de dstchannel sigue activa (la guarda de omisión es en mapRow)', () => {
    // resolveDispositionLocal siempre aplica ambas reglas; mapRow es quien decide
    // si llamar a la función según lostDests.length > 0
    expect(resolveDispositionLocal('ANSWERED', '1000', '', [])).toBe('NO ANSWER');
    expect(resolveDispositionLocal('ANSWERED', '1000', 'Agent/03', [])).toBe('ANSWERED');
  });

});

// ── mapRow reclassification ───────────────────────────────────────────────────

describe('mapRow — reclasificación de disposition (feature #27)', () => {

  it('ANSWERED con agente real → disposition permanece ANSWERED', () => {
    const row = makeCdrRow({ disposition: 'ANSWERED', dstchannel: 'Agent/03' });
    const mapped = mapRow(row, extractChannel, LOST_DESTS);
    expect(mapped.disposition).toBe('ANSWERED');
  });

  it('ANSWERED con dstchannel sin agente → disposition reclasificada a NO ANSWER', () => {
    const row = makeCdrRow({ disposition: 'ANSWERED', dstchannel: '' });
    const mapped = mapRow(row, extractChannel, LOST_DESTS);
    expect(mapped.disposition).toBe('NO ANSWER');
  });

  it('dst en lostDests → disposition reclasificada a NO ANSWER independientemente del dstchannel', () => {
    const row = makeCdrRow({ disposition: 'ANSWERED', dst: 'hang', dstchannel: 'Agent/03' });
    const mapped = mapRow(row, extractChannel, LOST_DESTS);
    expect(mapped.disposition).toBe('NO ANSWER');
  });

  it('mapRow incluye el campo dstchannel en la salida', () => {
    const row = makeCdrRow({ dstchannel: 'Agent/03' });
    const mapped = mapRow(row, extractChannel, LOST_DESTS);
    expect(mapped).toHaveProperty('dstchannel');
    expect(mapped.dstchannel).toBe('Agent/03');
  });

  it('con lostDests vacío mapRow no reclasifica', () => {
    const row = makeCdrRow({ disposition: 'ANSWERED', dstchannel: '' });
    const mapped = mapRow(row, extractChannel, []);
    expect(mapped.disposition).toBe('ANSWERED');
  });

});

// ── buildWhereClause — expansión de filtro disposition ───────────────────────

describe('buildWhereClause — filtro disposition reclasificado (feature #27)', () => {

  it('sin lostDests → filtro disposition simple', () => {
    const { conditions, params } = buildWhereClause(
      { from: '2026-06-01', to: '2026-06-17', disposition: 'ANSWERED' }, []
    );
    const condStr = conditions.join(' AND ');
    expect(condStr).toContain("UPPER(disposition) = UPPER(?)");
    expect(params).toContain('ANSWERED');
  });

  it('disposition=NO ANSWER con lostDests → condición expandida incluye ANSWERED reclasificadas', () => {
    const { conditions, params } = buildWhereClause(
      { from: '2026-06-01', to: '2026-06-17', disposition: 'NO ANSWER' },
      LOST_DESTS
    );
    const condStr = conditions.join(' AND ');
    expect(condStr).toContain("UPPER(disposition) = 'NO ANSWER'");
    expect(condStr).toContain('dst IN (');
    expect(condStr).toContain("UPPER(disposition) = 'ANSWERED'");
    expect(condStr).toContain('REGEXP');
    for (const d of LOST_DESTS) expect(params).toContain(d);
    expect(params).toContain(AGENT_DSTCHANNEL_MYSQL);
  });

  it('disposition=ANSWERED con lostDests → excluye lostDests y exige dstchannel de agente', () => {
    const { conditions, params } = buildWhereClause(
      { from: '2026-06-01', to: '2026-06-17', disposition: 'ANSWERED' },
      LOST_DESTS
    );
    const condStr = conditions.join(' AND ');
    expect(condStr).toContain("UPPER(disposition) = 'ANSWERED'");
    expect(condStr).toContain('dst NOT IN (');
    expect(condStr).toContain('dstchannel REGEXP');
    for (const d of LOST_DESTS) expect(params).toContain(d);
    expect(params).toContain(AGENT_DSTCHANNEL_MYSQL);
  });

  it('disposition=BUSY con lostDests → filtro simple (BUSY no se reclasifica)', () => {
    const { conditions, params } = buildWhereClause(
      { from: '2026-06-01', to: '2026-06-17', disposition: 'BUSY' },
      LOST_DESTS
    );
    const condStr = conditions.join(' AND ');
    expect(condStr).toContain('UPPER(disposition) = UPPER(?)');
    expect(params).toContain('BUSY');
    expect(condStr).not.toContain('dst IN');
  });

  it('sin disposition → no se añade condición de disposition', () => {
    const { conditions } = buildWhereClause(
      { from: '2026-06-01', to: '2026-06-17' },
      LOST_DESTS
    );
    const condStr = conditions.join(' AND ');
    expect(condStr).not.toContain('disposition');
  });

});

// ── reclassifyCaseExprs para statsService ────────────────────────────────────

describe('reclassifyCaseExprs — CASE SQL para statsService (feature #27)', () => {

  it('con lostDests vacío devuelve expresiones SUM simples y extraParams vacío', () => {
    const { answeredExpr, noAnswerExpr, extraParams } = reclassifyCaseExprs([]);
    expect(answeredExpr).toBe("SUM(disposition = 'ANSWERED')");
    expect(noAnswerExpr).toBe("SUM(disposition = 'NO ANSWER')");
    expect(extraParams).toHaveLength(0);
  });

  it('con lostDests no vacío devuelve CASE expressions que incluyen IN y REGEXP', () => {
    const { answeredExpr, noAnswerExpr, extraParams } = reclassifyCaseExprs(LOST_DESTS);
    expect(answeredExpr).toContain('CASE');
    expect(answeredExpr).toContain('dst IN (');
    expect(answeredExpr).toContain('REGEXP');
    expect(noAnswerExpr).toContain('CASE');
    expect(noAnswerExpr).toContain('dst IN (');
    expect(extraParams.length).toBeGreaterThan(0);
  });

  it('extraParams contiene todos los lostDests (x2 para answered + no_answer) y el patrón REGEXP (x2)', () => {
    const { extraParams } = reclassifyCaseExprs(['s', 'hang']);
    // 2 lostDests for answered + 1 re + 2 lostDests for no_answer + 1 re = 6
    expect(extraParams).toHaveLength(6);
    expect(extraParams.filter(p => p === 's')).toHaveLength(2);
    expect(extraParams.filter(p => p === 'hang')).toHaveLength(2);
    expect(extraParams.filter(p => p === AGENT_DSTCHANNEL_MYSQL)).toHaveLength(2);
  });

});

// ── queryHistoricalCustom — totales con reclasificación ──────────────────────

describe('queryHistoricalCustom — totales reclasificados (feature #27)', () => {

  function makeHistRow(overrides = {}) {
    return {
      total:        '10',
      answered:     '6',
      no_answer:    '2',
      busy:         '1',
      failed:       '1',
      avg_duration: '45.00',
      ...overrides,
    };
  }

  it('sin lostDests usa SUM simple y pasa solo [fromTs, toTs]', async () => {
    const pool = mockPool([makeHistRow()]);
    const result = await queryHistoricalCustom(pool, '2026-06-01', '2026-06-17', []);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("SUM(disposition = 'ANSWERED')");
    expect(sql).toContain("SUM(disposition = 'NO ANSWER')");
    expect(params).toHaveLength(2); // only fromTs and toTs
  });

  it('con lostDests usa CASE expressions y prefija extraParams', async () => {
    const pool = mockPool([makeHistRow()]);
    await queryHistoricalCustom(pool, '2026-06-01', '2026-06-17', LOST_DESTS);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('CASE WHEN dst IN');
    expect(sql).toContain('REGEXP');
    // extraParams (3 lostDests + re) x2 + fromTs + toTs = 10
    expect(params).toHaveLength(10);
  });

  it('devuelve los valores numéricos correctos del mock', async () => {
    const pool = mockPool([makeHistRow({ total: '8', answered: '5', no_answer: '2' })]);
    const result = await queryHistoricalCustom(pool, '2026-06-01', '2026-06-17', []);
    expect(result.total).toBe(8);
    expect(result.answered).toBe(5);
    expect(result.no_answer).toBe(2);
  });

});
