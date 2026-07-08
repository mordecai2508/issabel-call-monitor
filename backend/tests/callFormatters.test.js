'use strict';

const { extractAgentName, formatBillsec, dispositionLabel } = require('../services/callFormatters');

describe('extractAgentName', () => {
  // R8/R9 — Agent/ pattern
  test('Agent/03 → "Agent/03"', () => {
    expect(extractAgentName('Agent/03')).toBe('Agent/03');
  });

  test('Agent/03-000001ab → "Agent/03"', () => {
    expect(extractAgentName('Agent/03-000001ab')).toBe('Agent/03');
  });

  // R8/R9 — SIP/<numeric>-<suffix> pattern
  test('SIP/202-00a1b2c3 → "202"', () => {
    expect(extractAgentName('SIP/202-00a1b2c3')).toBe('202');
  });

  // R8/R9 — empty string
  test('"" → ""', () => {
    expect(extractAgentName('')).toBe('');
  });

  // R8/R9 — unrecognised pattern (Local/)
  test('Local/s@from-internal → ""', () => {
    expect(extractAgentName('Local/s@from-internal')).toBe('');
  });

  // PJSIP variant
  test('PJSIP/303-0000abcd → "303"', () => {
    expect(extractAgentName('PJSIP/303-0000abcd')).toBe('303');
  });

  // null/undefined safety
  test('null → ""', () => {
    expect(extractAgentName(null)).toBe('');
  });

  test('undefined → ""', () => {
    expect(extractAgentName(undefined)).toBe('');
  });
});

describe('formatBillsec', () => {
  // R10
  test('0 → "0:00"', () => {
    expect(formatBillsec(0)).toBe('0:00');
  });

  test('59 → "0:59"', () => {
    expect(formatBillsec(59)).toBe('0:59');
  });

  test('225 → "3:45"', () => {
    expect(formatBillsec(225)).toBe('3:45');
  });

  test('3661 → "61:01"', () => {
    expect(formatBillsec(3661)).toBe('61:01');
  });

  test('null/undefined → "0:00"', () => {
    expect(formatBillsec(null)).toBe('0:00');
    expect(formatBillsec(undefined)).toBe('0:00');
  });
});

describe('dispositionLabel', () => {
  // R11
  test('ANSWERED → "Contestada"', () => {
    expect(dispositionLabel('ANSWERED')).toBe('Contestada');
  });

  test('NO ANSWER → "No contestada"', () => {
    expect(dispositionLabel('NO ANSWER')).toBe('No contestada');
  });

  test('BUSY → "Ocupado"', () => {
    expect(dispositionLabel('BUSY')).toBe('Ocupado');
  });

  test('FAILED → "Fallida"', () => {
    expect(dispositionLabel('FAILED')).toBe('Fallida');
  });

  test('OTHER → "OTHER" (unknown passed through)', () => {
    expect(dispositionLabel('OTHER')).toBe('OTHER');
  });

  test('case-insensitive: answered → "Contestada"', () => {
    expect(dispositionLabel('answered')).toBe('Contestada');
  });

  test('empty string → ""', () => {
    expect(dispositionLabel('')).toBe('');
  });

  test('null → ""', () => {
    expect(dispositionLabel(null)).toBe('');
  });
});
