'use strict';

/**
 * cdrService.test.js — feature #40 tests
 *
 * Tests for formatCalldateLocal, mapRow, and mapOutboundRow in cdrService.js.
 */

const {
  formatCalldateLocal,
  mapRow,
  mapOutboundRow,
} = require('../services/cdrService');

// ── formatCalldateLocal ───────────────────────────────────────────────────────

describe('formatCalldateLocal', () => {
  test('R4 - convierte Date UTC a hora local con offset "-05:00"', () => {
    const input = new Date('2026-06-24T22:30:34.000Z');
    expect(formatCalldateLocal(input, '-05:00')).toBe('2026-06-24 17:30:34');
  });

  test('R4 - maneja offset positivo "+02:00"', () => {
    const input = new Date('2026-06-24T10:00:00.000Z');
    expect(formatCalldateLocal(input, '+02:00')).toBe('2026-06-24 12:00:00');
  });

  test('R5 - usa UTC cuando tzOffset es undefined', () => {
    const input = new Date('2026-06-24T22:30:34.000Z');
    expect(formatCalldateLocal(input, undefined)).toBe('2026-06-24 22:30:34');
  });

  test('R5 - usa UTC cuando tzOffset es cadena vacía', () => {
    const input = new Date('2026-06-24T22:30:34.000Z');
    expect(formatCalldateLocal(input, '')).toBe('2026-06-24 22:30:34');
  });

  test('acepta string ISO como entrada', () => {
    const input = '2026-06-24T22:30:34.000Z';
    expect(formatCalldateLocal(input, '-05:00')).toBe('2026-06-24 17:30:34');
  });

  test('devuelve String(value) para un valor inválido sin lanzar excepción', () => {
    const input = 'not-a-date';
    expect(() => formatCalldateLocal(input, '-05:00')).not.toThrow();
    expect(formatCalldateLocal(input, '-05:00')).toBe('not-a-date');
  });

  test('maneja medianoche correctamente con offset negativo', () => {
    // 2026-06-25T00:00:00Z con -05:00 debe ser 2026-06-24 19:00:00
    const input = new Date('2026-06-25T00:00:00.000Z');
    expect(formatCalldateLocal(input, '-05:00')).toBe('2026-06-24 19:00:00');
  });
});

// ── mapRow ────────────────────────────────────────────────────────────────────

describe('mapRow', () => {
  const extractChannelFn = ch => ch; // identidad

  test('R1 - devuelve calldate como string YYYY-MM-DD HH:MM:SS con tzOffset "-05:00"', () => {
    const row = {
      calldate:    new Date('2026-06-24T22:30:34.000Z'),
      src:         '1234',
      dst:         '5678',
      channel:     'SIP/trunk-abc',
      dstchannel:  'Agent/1001',
      duration:    60,
      billsec:     55,
      disposition: 'ANSWERED',
    };
    const result = mapRow(row, extractChannelFn, [], '-05:00');
    expect(result.calldate).toBe('2026-06-24 17:30:34');
  });

  test('usa "+00:00" por defecto cuando no se pasa tzOffset', () => {
    const row = {
      calldate:    new Date('2026-06-24T22:30:34.000Z'),
      src:         '1234',
      dst:         '5678',
      channel:     'SIP/trunk-abc',
      dstchannel:  'Agent/1001',
      duration:    60,
      billsec:     55,
      disposition: 'ANSWERED',
    };
    const result = mapRow(row, extractChannelFn);
    expect(result.calldate).toBe('2026-06-24 22:30:34');
  });
});

// ── mapOutboundRow ────────────────────────────────────────────────────────────

describe('mapOutboundRow', () => {
  const extractChannelFn = ch => ch; // identidad

  test('R1 - devuelve calldate como string YYYY-MM-DD HH:MM:SS con tzOffset "-05:00"', () => {
    const row = {
      calldate:    new Date('2026-06-24T22:30:34.000Z'),
      src:         '1001',
      dst:         '5551234567',
      dstchannel:  'SIP/SALIENTE_CALL-abc123',
      duration:    120,
      billsec:     115,
      disposition: 'ANSWERED',
    };
    const result = mapOutboundRow(row, extractChannelFn, [], '-05:00');
    expect(result.calldate).toBe('2026-06-24 17:30:34');
  });

  test('usa "+00:00" por defecto cuando no se pasa tzOffset', () => {
    const row = {
      calldate:    new Date('2026-06-24T22:30:34.000Z'),
      src:         '1001',
      dst:         '5551234567',
      dstchannel:  'SIP/SALIENTE_CALL-abc123',
      duration:    120,
      billsec:     115,
      disposition: 'ANSWERED',
    };
    const result = mapOutboundRow(row, extractChannelFn);
    expect(result.calldate).toBe('2026-06-24 22:30:34');
  });
});
