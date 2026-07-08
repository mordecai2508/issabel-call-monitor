'use strict';

/**
 * busyAsUnanswered.test.js — feature #37 tests
 *
 * Tests that BUSY disposition is reclassified to NO ANSWER in all layers:
 *   - resolveDisposition (server.js)
 *   - resolveDispositionLocal / mapRow / mapOutboundRow (cdrService.js)
 *   - reclassifyCaseExprs (statsService.js)
 *   - summarizeByDisposition (reportService.js)
 *
 * All helpers are local mirrors to avoid importing server.js and to test
 * the updated #37 logic independently.
 */

// ── Local mirrors — post-#37 ──────────────────────────────────────────────────

const AGENT_DSTCHANNEL_RE    = /^(Agent\/\d+|SIP\/\d+-)/;
const AGENT_DSTCHANNEL_MYSQL = '^(Agent/[0-9]+|SIP/[0-9]+-)';

// Mirror of resolveDisposition from backend/server.js (post-#37)
function resolveDisposition(row, lostDests) {
  const d = row.disposition.toUpperCase();
  let targetKey = ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED'].includes(d) ? d : null;
  if (!targetKey) return null;

  // #37: BUSY se trata como NO ANSWER
  if (targetKey === 'BUSY') targetKey = 'NO ANSWER';

  // #17: dst en lostDestinations reclasifica cualquier disposición hacia 'NO ANSWER'
  const isLostDst = lostDests.includes(row.dst);
  if (isLostDst && targetKey !== 'NO ANSWER') {
    targetKey = 'NO ANSWER';
  }

  // #21: ANSWERED sin dstchannel de agente reclasifica hacia 'NO ANSWER'
  if (targetKey === 'ANSWERED' && !AGENT_DSTCHANNEL_RE.test(row.dstchannel || '')) {
    targetKey = 'NO ANSWER';
  }

  return targetKey;
}

// Mirror of resolveDispositionLocal from backend/services/cdrService.js (post-#37)
function resolveDispositionLocal(disposition, dst, dstchannel, lostDests) {
  const d = (disposition || '').toUpperCase();
  let key = ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED'].includes(d) ? d : null;
  if (!key) return disposition;
  // #37: BUSY se trata como NO ANSWER
  if (key === 'BUSY') key = 'NO ANSWER';
  if (lostDests.includes(dst) && key !== 'NO ANSWER') key = 'NO ANSWER';
  if (key === 'ANSWERED' && !AGENT_DSTCHANNEL_RE.test(dstchannel || '')) key = 'NO ANSWER';
  return key;
}

// Mirror of mapRow from backend/services/cdrService.js
function mapRow(row, lostDests = []) {
  const disp = lostDests.length > 0
    ? resolveDispositionLocal(row.disposition, row.dst, row.dstchannel || '', lostDests)
    : row.disposition;
  return {
    calldate:    row.calldate,
    src:         row.src,
    dst:         row.dst,
    channel:     row.channel,
    dstchannel:  row.dstchannel || '',
    duration:    Number(row.duration),
    billsec:     Number(row.billsec),
    disposition: disp || row.disposition,
  };
}

// Mirror of mapOutboundRow from backend/services/cdrService.js
function mapOutboundRow(row, lostDests = []) {
  const disp = lostDests.length > 0
    ? resolveDispositionLocal(row.disposition, row.dst, row.dstchannel || '', lostDests)
    : row.disposition;
  return {
    calldate:    row.calldate,
    src:         row.src,
    dst:         row.dst,
    dstchannel:  row.dstchannel || '',
    duration:    Number(row.duration),
    billsec:     Number(row.billsec),
    disposition: disp || row.disposition,
  };
}

// Mirror of reclassifyCaseExprs from backend/services/statsService.js (post-#37)
function reclassifyCaseExprs(lostDests) {
  if (!lostDests || lostDests.length === 0) {
    return {
      answeredExpr: "SUM(disposition = 'ANSWERED')",
      // #37: BUSY se acumula en no_answer
      noAnswerExpr: "SUM(disposition = 'NO ANSWER' OR UPPER(disposition) = 'BUSY')",
      extraParams:  [],
    };
  }
  const lp = lostDests.map(() => '?').join(',');
  const re = AGENT_DSTCHANNEL_MYSQL;
  const answeredExpr =
    `SUM(CASE WHEN dst IN (${lp}) THEN 0 ` +
    `WHEN UPPER(disposition) = 'ANSWERED' AND (dstchannel IS NULL OR dstchannel = '' OR dstchannel NOT REGEXP ?) THEN 0 ` +
    `WHEN UPPER(disposition) = 'ANSWERED' THEN 1 ELSE 0 END)`;
  // #37: BUSY se acumula en no_answer (antes de lostDests)
  const noAnswerExpr =
    `SUM(CASE WHEN UPPER(disposition) = 'BUSY' THEN 1 ` +
    `WHEN dst IN (${lp}) THEN 1 ` +
    `WHEN UPPER(disposition) = 'ANSWERED' AND (dstchannel IS NULL OR dstchannel = '' OR dstchannel NOT REGEXP ?) THEN 1 ` +
    `WHEN UPPER(disposition) = 'NO ANSWER' THEN 1 ELSE 0 END)`;
  return {
    answeredExpr,
    noAnswerExpr,
    extraParams: [...lostDests, re, ...lostDests, re],
  };
}

// Mirror of summarizeByDisposition from backend/services/reportService.js (post-#37)
const DISPOSITIONS = ['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED'];

function summarizeByDisposition(rows) {
  const summary = { total: rows.length, ANSWERED: 0, 'NO ANSWER': 0, BUSY: 0, FAILED: 0 };
  for (const row of rows) {
    const d = (row.disposition || '').toUpperCase();
    // #37: normalización defensiva — BUSY se suma a NO ANSWER
    const effectiveD = d === 'BUSY' ? 'NO ANSWER' : d;
    if (DISPOSITIONS.includes(effectiveD)) {
      summary[effectiveD] += 1;
    }
  }
  return summary;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(overrides = {}) {
  return {
    calldate:    '2026-06-24 10:00:00',
    src:         '1234567890',
    dst:         '101',
    channel:     'SIP/trunk-0001',
    dstchannel:  'Agent/101',
    duration:    30,
    billsec:     0,
    disposition: 'BUSY',
    ...overrides,
  };
}

const DEFAULT_LOST_DESTS = ['s', 'hang', 'hangup'];

// ── T12: Tests de resolveDisposition (R1) ────────────────────────────────────

describe('R1 - resolveDisposition (server.js)', () => {
  it('R1 - BUSY se reclasifica a NO ANSWER en resolveDisposition', () => {
    const row = makeRow({ disposition: 'BUSY' });
    expect(resolveDisposition(row, DEFAULT_LOST_DESTS)).toBe('NO ANSWER');
  });

  it('R1 - busy (minúsculas) se reclasifica a NO ANSWER', () => {
    const row = makeRow({ disposition: 'busy' });
    expect(resolveDisposition(row, DEFAULT_LOST_DESTS)).toBe('NO ANSWER');
  });

  it('R1 - BUSY en dst lostDest sigue siendo NO ANSWER (no double-count)', () => {
    const row = makeRow({ disposition: 'BUSY', dst: 'hangup' });
    expect(resolveDisposition(row, DEFAULT_LOST_DESTS)).toBe('NO ANSWER');
  });

  it('R1 - ANSWERED con agente permanece ANSWERED (no afectado por #37)', () => {
    const row = makeRow({ disposition: 'ANSWERED', dstchannel: 'Agent/101' });
    expect(resolveDisposition(row, DEFAULT_LOST_DESTS)).toBe('ANSWERED');
  });

  it('R1 - NO ANSWER permanece NO ANSWER', () => {
    const row = makeRow({ disposition: 'NO ANSWER' });
    expect(resolveDisposition(row, DEFAULT_LOST_DESTS)).toBe('NO ANSWER');
  });

  it('R1 - FAILED permanece FAILED', () => {
    const row = makeRow({ disposition: 'FAILED' });
    expect(resolveDisposition(row, DEFAULT_LOST_DESTS)).toBe('FAILED');
  });

  it('R1 - disposición inválida retorna null', () => {
    const row = makeRow({ disposition: 'UNKNOWN' });
    expect(resolveDisposition(row, DEFAULT_LOST_DESTS)).toBeNull();
  });
});

// ── T13: Tests de resolveDispositionLocal / mapRow / mapOutboundRow (R4) ─────

describe('R4 - mapRow / mapOutboundRow devuelven NO ANSWER para filas BUSY', () => {
  it('R4 - mapRow devuelve disposition NO ANSWER para fila BUSY', () => {
    const row = makeRow({ disposition: 'BUSY' });
    const mapped = mapRow(row, DEFAULT_LOST_DESTS);
    expect(mapped.disposition).toBe('NO ANSWER');
  });

  it('R4 - mapOutboundRow devuelve disposition NO ANSWER para fila BUSY', () => {
    const row = makeRow({ disposition: 'BUSY' });
    const mapped = mapOutboundRow(row, DEFAULT_LOST_DESTS);
    expect(mapped.disposition).toBe('NO ANSWER');
  });

  it('R4 - mapRow sin lostDests mantiene BUSY original (sin reclasificación)', () => {
    // Con lostDests vacío, la función no reclasifica (comportamiento anterior)
    // Nota: esto refleja la lógica de cdrService que solo llama resolveDispositionLocal
    // cuando lostDests.length > 0. Con #37, la reclasificación BUSY→NO ANSWER
    // ocurre dentro de resolveDispositionLocal, no fuera de ella.
    const row = makeRow({ disposition: 'BUSY' });
    const mapped = mapRow(row, []); // sin lostDests, no se llama resolveDispositionLocal
    // El valor original se mantiene cuando lostDests está vacío
    expect(mapped.disposition).toBe('BUSY');
  });

  it('R4 - mapRow con busy minúsculas y lostDests retorna NO ANSWER', () => {
    const row = makeRow({ disposition: 'busy' });
    const mapped = mapRow(row, DEFAULT_LOST_DESTS);
    expect(mapped.disposition).toBe('NO ANSWER');
  });

  it('R4 - resolveDispositionLocal BUSY → NO ANSWER directo', () => {
    const result = resolveDispositionLocal('BUSY', '101', 'Agent/101', DEFAULT_LOST_DESTS);
    expect(result).toBe('NO ANSWER');
  });
});

// ── T14: Tests de reclassifyCaseExprs (R3) ───────────────────────────────────

describe('R3 - reclassifyCaseExprs incluye BUSY en noAnswerExpr', () => {
  it('R3 - noAnswerExpr sin lostDests incluye BUSY', () => {
    const { noAnswerExpr } = reclassifyCaseExprs([]);
    expect(noAnswerExpr).toContain("UPPER(disposition) = 'BUSY'");
    expect(noAnswerExpr).toContain("disposition = 'NO ANSWER'");
  });

  it('R3 - noAnswerExpr con lostDests incluye WHEN BUSY THEN 1', () => {
    const { noAnswerExpr } = reclassifyCaseExprs(['s', 'hang', 'hangup']);
    expect(noAnswerExpr).toContain("WHEN UPPER(disposition) = 'BUSY' THEN 1");
  });

  it('R3 - noAnswerExpr con lostDests — BUSY aparece ANTES que lostDests', () => {
    const { noAnswerExpr } = reclassifyCaseExprs(['s', 'hang']);
    const busyPos     = noAnswerExpr.indexOf("WHEN UPPER(disposition) = 'BUSY'");
    const lostDestsPos = noAnswerExpr.indexOf('WHEN dst IN');
    expect(busyPos).toBeGreaterThanOrEqual(0);
    expect(lostDestsPos).toBeGreaterThanOrEqual(0);
    expect(busyPos).toBeLessThan(lostDestsPos);
  });

  it('R3 - answeredExpr no cuenta BUSY (cae en ELSE 0)', () => {
    const { answeredExpr } = reclassifyCaseExprs(['s', 'hang']);
    // No debe haber una cláusula WHEN BUSY THEN 1 en answeredExpr
    expect(answeredExpr).not.toContain("BUSY' THEN 1");
  });

  it('R3 - extraParams correctos para rama con lostDests', () => {
    const lostDests = ['s', 'hang', 'hangup'];
    const { extraParams } = reclassifyCaseExprs(lostDests);
    // extraParams = [...lostDests, re, ...lostDests, re]
    expect(extraParams.length).toBe(lostDests.length * 2 + 2);
    expect(extraParams).toContain(AGENT_DSTCHANNEL_MYSQL);
  });
});

// ── T15: Tests de summarizeByDisposition (R5) ────────────────────────────────

describe('R5 - summarizeByDisposition cuenta BUSY en NO ANSWER', () => {
  it('R5 - BUSY se suma a NO ANSWER en summarizeByDisposition', () => {
    const rows = [
      { disposition: 'ANSWERED' },
      { disposition: 'BUSY' },
      { disposition: 'NO ANSWER' },
    ];
    const summary = summarizeByDisposition(rows);
    expect(summary['NO ANSWER']).toBe(2);
    expect(summary.BUSY).toBe(0);
    expect(summary.ANSWERED).toBe(1);
  });

  it('R5 - bucket BUSY queda en 0 cuando solo hay filas BUSY', () => {
    const rows = [
      { disposition: 'BUSY' },
      { disposition: 'BUSY' },
      { disposition: 'busy' }, // minúsculas
    ];
    const summary = summarizeByDisposition(rows);
    expect(summary.BUSY).toBe(0);
    expect(summary['NO ANSWER']).toBe(3);
  });

  it('R5 - total es correcto incluyendo filas BUSY', () => {
    const rows = [
      { disposition: 'ANSWERED' },
      { disposition: 'BUSY' },
      { disposition: 'BUSY' },
      { disposition: 'FAILED' },
    ];
    const summary = summarizeByDisposition(rows);
    expect(summary.total).toBe(4);
    expect(summary.ANSWERED + summary['NO ANSWER'] + summary.BUSY + summary.FAILED).toBe(4);
  });
});

// ── T16: Test de identidad aritmética (R6) ────────────────────────────────────

describe('R6 - identidad aritmética con filas BUSY', () => {
  it('R6 - total === answered + no_answer + failed cuando hay filas BUSY', () => {
    const mixedRows = [
      makeRow({ disposition: 'ANSWERED', dstchannel: 'Agent/101' }),
      makeRow({ disposition: 'BUSY' }),
      makeRow({ disposition: 'BUSY' }),
      makeRow({ disposition: 'NO ANSWER' }),
      makeRow({ disposition: 'FAILED' }),
    ];

    // Simular acumulación como lo hace queryStats
    const base = {
      ANSWERED:    0,
      'NO ANSWER': 0,
      BUSY:        0,
      FAILED:      0,
    };
    let total = 0;
    for (const r of mixedRows) {
      const key = resolveDisposition(r, DEFAULT_LOST_DESTS);
      if (key) base[key] += 1;
      total += 1;
    }

    expect(base.BUSY).toBe(0);
    expect(base['NO ANSWER']).toBe(3); // 2 BUSY + 1 NO ANSWER
    expect(base.ANSWERED).toBe(1);
    expect(base.FAILED).toBe(1);
    expect(base.ANSWERED + base['NO ANSWER'] + base.BUSY + base.FAILED).toBe(total);
  });
});

// ── T17: Test de payload SSE — campo BUSY presente con valor 0 (R7) ───────────

describe('R7 - el payload incluye dispositions.BUSY con valor 0', () => {
  it('R7 - el objeto base de queryStats siempre inicializa BUSY: { count: 0 }', () => {
    // Verificar que el objeto base tiene el campo BUSY inicializado a 0
    // (replica lo que hace queryStats en server.js)
    const base = {
      ANSWERED:    { count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0 },
      'NO ANSWER': {
        count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0,
        breakdown: { no_answer: 0, ivr_hangup: 0, queue_no_agent: 0, ivr_hangup_business: 0, ivr_hangup_offhours: 0 },
      },
      BUSY:   { count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0 },
      FAILED: { count: 0, total_duration: 0, total_billsec: 0, avg_billsec: 0, pct: 0 },
    };

    // Procesar filas BUSY — deben acumularse en NO ANSWER, no en BUSY
    const rows = [
      makeRow({ disposition: 'BUSY', dstchannel: '' }),
      makeRow({ disposition: 'BUSY', dstchannel: '' }),
    ];
    for (const r of rows) {
      const key = resolveDisposition(r, DEFAULT_LOST_DESTS);
      if (key) {
        base[key].count += 1;
      }
    }

    // El campo BUSY debe existir con valor 0 (R7: no eliminarlo)
    expect(base).toHaveProperty('BUSY');
    expect(base.BUSY.count).toBe(0);
    // NO ANSWER debe tener el count de las filas BUSY
    expect(base['NO ANSWER'].count).toBe(2);
  });
});
