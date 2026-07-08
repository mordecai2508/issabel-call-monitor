'use strict';

/**
 * cdrService.outbound.test.js — Feature #41 tests
 * Verifies that mapOutboundRow includes channel field (R14)
 * and that outbound SQL queries include channel in SELECT.
 */

const cdrService = require('../services/cdrService');

const { mapOutboundRow, queryOutbound, queryOutboundExport } = cdrService;

// Minimal extractChannel stub
function extractChannel(raw) {
  if (!raw) return '';
  return raw.replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
}

describe('mapOutboundRow — R14: channel field', () => {
  const baseRow = {
    calldate:    new Date('2026-06-07T14:35:22.000Z'),
    src:         '101',
    dst:         '3001234567',
    channel:     'SIP/local-ext-00aabbcc',
    dstchannel:  'SIP/troncal-claro-00b3c4d5',
    duration:    185,
    billsec:     180,
    disposition: 'ANSWERED',
  };

  it('should include the channel field in the returned object', () => {
    const result = mapOutboundRow(baseRow, extractChannel, [], '+00:00');
    expect(result).toHaveProperty('channel');
  });

  it('should return the raw channel value (not normalised via extractChannel)', () => {
    const result = mapOutboundRow(baseRow, extractChannel, [], '+00:00');
    // channel is returned raw (row.channel || ''), NOT passed through extractChannel
    expect(result.channel).toBe('SIP/local-ext-00aabbcc');
  });

  it('should default channel to empty string when row.channel is falsy', () => {
    const rowNoChannel = { ...baseRow, channel: null };
    const result = mapOutboundRow(rowNoChannel, extractChannel, [], '+00:00');
    expect(result.channel).toBe('');
  });

  it('should still include all other existing fields', () => {
    const result = mapOutboundRow(baseRow, extractChannel, [], '+00:00');
    expect(result).toHaveProperty('calldate');
    expect(result).toHaveProperty('src');
    expect(result).toHaveProperty('dst');
    expect(result).toHaveProperty('dstchannel');
    expect(result).toHaveProperty('duration');
    expect(result).toHaveProperty('billsec');
    expect(result).toHaveProperty('disposition');
  });
});

describe('queryOutbound SQL — R14: channel in SELECT', () => {
  it('queryOutbound passes a SQL string containing "channel" to pool.query', async () => {
    const capturedSqls = [];
    let callCount = 0;
    const mockPool = {
      query: jest.fn().mockImplementation((sql) => {
        capturedSqls.push(sql);
        callCount++;
        if (callCount === 1) {
          // COUNT query
          return Promise.resolve([[{ total: 0 }]]);
        }
        // DATA query
        return Promise.resolve([[]]);
      }),
    };

    const filters = { from: '2026-06-01', to: '2026-06-07', trunk: null, extension: null, dest: null, disposition: null };
    await queryOutbound(mockPool, filters, { page: 1, limit: 10 }, ['SIP/trunk'], extractChannel, [], '+00:00');

    // The data SELECT query should include the "channel" column
    const dataQuery = capturedSqls[1] || '';
    expect(dataQuery.toLowerCase()).toMatch(/select[\s\S]*\bchannel\b/);
  });

  it('queryOutboundExport passes a SQL string containing "channel" to pool.query', async () => {
    let capturedSql = '';
    const mockPool = {
      query: jest.fn().mockImplementation((sql) => {
        capturedSql = sql;
        return Promise.resolve([[]]);
      }),
    };

    const filters = { from: '2026-06-01', to: '2026-06-07', trunk: null, extension: null, dest: null, disposition: null };
    await queryOutboundExport(mockPool, filters, ['SIP/trunk'], extractChannel, [], '+00:00');

    expect(capturedSql.toLowerCase()).toMatch(/select[\s\S]*\bchannel\b/);
  });
});
