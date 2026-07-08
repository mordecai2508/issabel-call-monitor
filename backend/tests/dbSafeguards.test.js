'use strict';

/**
 * dbSafeguards.test.js — feature #53 (db_load_safeguards) tests
 *
 * Cubre resolveConnectionLimit, resolvePollIntervalMs y checkCalldateIndex
 * con pool mockeado (nunca BD real).
 */

const createDbSafeguardsService = require('../services/dbSafeguardsService');
const {
  resolveConnectionLimit,
  resolvePollIntervalMs,
} = createDbSafeguardsService;

let warnSpy;
let errorSpy;

beforeEach(() => {
  warnSpy  = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

// ── resolveConnectionLimit ────────────────────────────────────────────────────

describe('resolveConnectionLimit', () => {
  it('R1 - usa connectionLimit default 3 cuando config no lo define', () => {
    expect(resolveConnectionLimit(undefined)).toBe(3);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('R2 - respeta connectionLimit entero valido >= 1 del config', () => {
    expect(resolveConnectionLimit(1)).toBe(1);
    expect(resolveConnectionLimit(5)).toBe(5);
    expect(resolveConnectionLimit(10)).toBe(10);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('R2 - acepta string que representa un entero valido >= 1', () => {
    expect(resolveConnectionLimit('5')).toBe(5);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('R3 - valor invalido de connectionLimit cae al default 3 con advertencia en log', () => {
    const invalids = [0, -1, 2.5, 'abc', null, true];
    for (const value of invalids) {
      warnSpy.mockClear();
      expect(resolveConnectionLimit(value)).toBe(3);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('connectionLimit inválido');
      expect(warnSpy.mock.calls[0][0]).toContain('default 3');
    }
  });
});

// ── resolvePollIntervalMs ─────────────────────────────────────────────────────

describe('resolvePollIntervalMs', () => {
  it('R4 - usa pollIntervalMs default 60000 cuando config no lo define', () => {
    expect(resolvePollIntervalMs(undefined)).toBe(60_000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('R5 - respeta pollIntervalMs configurado >= 15000', () => {
    expect(resolvePollIntervalMs(15_000)).toBe(15_000);
    expect(resolvePollIntervalMs(30_000)).toBe(30_000);
    expect(resolvePollIntervalMs(120_000)).toBe(120_000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('R6 - eleva pollIntervalMs menor a 15000 al minimo con advertencia en log', () => {
    expect(resolvePollIntervalMs(5_000)).toBe(15_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('15000');
  });

  it('R6 - valor invalido definido (NaN, negativo, string no numerica) cae al minimo con advertencia', () => {
    const invalids = ['abc', -1, 0, NaN, null];
    for (const value of invalids) {
      warnSpy.mockClear();
      expect(resolvePollIntervalMs(value)).toBe(15_000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    }
  });
});

// ── checkCalldateIndex ────────────────────────────────────────────────────────

describe('checkCalldateIndex', () => {
  it('R7/R8 - checkCalldateIndex loguea advertencia con el ALTER TABLE sugerido cuando no hay indice', async () => {
    const pool = { query: jest.fn().mockResolvedValue([[]]) };
    const service = createDbSafeguardsService(pool);

    const result = await service.checkCalldateIndex();

    expect(result).toEqual({ checked: true, hasIndex: false, error: null });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('ALTER TABLE cdr ADD INDEX idx_calldate (calldate);');
  });

  it('R7 - checkCalldateIndex detecta indice presente sin advertencia', async () => {
    const rows = [{ Table: 'cdr', Key_name: 'idx_calldate', Column_name: 'calldate' }];
    const pool = { query: jest.fn().mockResolvedValue([rows]) };
    const service = createDbSafeguardsService(pool);

    const result = await service.checkCalldateIndex();

    expect(result).toEqual({ checked: true, hasIndex: true, error: null });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('R9/R10 - checkCalldateIndex loguea el error y no lanza cuando la query falla', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('Access denied')) };
    const service = createDbSafeguardsService(pool);

    await expect(service.checkCalldateIndex()).resolves.toEqual({
      checked: false,
      hasIndex: null,
      error: 'Access denied',
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('No se pudo verificar el índice de calldate');
  });

  it('R9/R10 - checkCalldateIndex resuelve con error de timeout si la query nunca responde', async () => {
    const pool = { query: jest.fn(() => new Promise(() => {})) };
    const service = createDbSafeguardsService(pool, { timeoutMs: 20 });

    const result = await service.checkCalldateIndex();

    expect(result.checked).toBe(false);
    expect(result.hasIndex).toBeNull();
    expect(result.error).toContain('Timeout');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('R11 - checkCalldateIndex solo ejecuta la consulta SHOW INDEX de lectura', async () => {
    const pool = { query: jest.fn().mockResolvedValue([[]]) };
    const service = createDbSafeguardsService(pool);

    await service.checkCalldateIndex();

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith("SHOW INDEX FROM cdr WHERE Column_name = 'calldate'");
  });
});

// ── Compatibilidad ────────────────────────────────────────────────────────────

describe('compatibilidad con configs existentes', () => {
  it('R14 - config existente sin los campos nuevos arranca con defaults', () => {
    const legacyConfig = { db: {}, server: {} };
    expect(resolveConnectionLimit(legacyConfig.db.connectionLimit)).toBe(3);
    expect(resolvePollIntervalMs(legacyConfig.server.pollIntervalMs)).toBe(60_000);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
