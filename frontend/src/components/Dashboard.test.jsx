import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { api } from '../api';
import { useSSE } from '../hooks/useSSE';
import Dashboard from './Dashboard';

// Mock src/api.js — Dashboard.jsx must never `fetch()` directly (conventions),
// so we isolate the component from the network entirely.
vi.mock('../api', () => ({
  api: {
    pbxExtensions: vi.fn(),
  },
}));

// Mock useSSE so the dashboard renders its KPIs/StatCards (which only render
// when `data` is truthy) without opening a real EventSource/SSE connection.
vi.mock('../hooks/useSSE', () => ({
  useSSE: vi.fn(),
}));

// Mock the chart components — they wrap Recharts' ResponsiveContainer, which
// needs real layout dimensions to render meaningfully in jsdom. Mocking keeps
// these tests focused on the "Extensiones"/"Activas" indicators (R14-R17)
// and avoids unrelated noise/instability from chart rendering.
vi.mock('./DispositionChart', () => ({
  DispositionChart: () => <div data-testid="disposition-chart" />,
}));
vi.mock('./HourlyChart', () => ({
  HourlyChart: () => <div data-testid="hourly-chart" />,
}));
vi.mock('./ChannelTable', () => ({
  ChannelTable: () => <div data-testid="channel-table" />,
}));

const SAMPLE_DATA = {
  generatedAt: '2026-06-12T10:00:00.000Z',
  stats: {
    total: 100,
    dispositions: {
      ANSWERED:     { count: 70, pct: 70, avg_billsec: 120, total_billsec: 8400 },
      'NO ANSWER':  {
        count: 20, pct: 20,
        breakdown: { no_answer: 8, ivr_hangup: 5, queue_no_agent: 7 },
      },
      BUSY:         { count: 5,  pct: 5 },
      FAILED:       { count: 5,  pct: 5 },
    },
  },
  inbound:  { stats: { total: 60 }, channels: [] },
  outbound: { stats: { total: 40 } },
  hourly: [],
  queues: [],
  channelAliases: {},
};

// Helper: builds a SAMPLE_DATA-like payload with a custom `breakdown` for
// dispositions['NO ANSWER'] (or no breakdown key at all if `breakdown` is
// `undefined`), used by the R10/R11 degraded-case tests below.
function withBreakdown(breakdown) {
  const noAnswer = { count: 20, pct: 20 };
  if (breakdown !== undefined) noAnswer.breakdown = breakdown;
  return {
    ...SAMPLE_DATA,
    stats: {
      ...SAMPLE_DATA.stats,
      dispositions: {
        ...SAMPLE_DATA.stats.dispositions,
        'NO ANSWER': noAnswer,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: useSSE delivers SAMPLE_DATA via onInit so the "data &&" branch
  // (with the StatCards) renders. The callback is deferred to a microtask —
  // calling setState synchronously during the initial render (i.e. while
  // useSSE itself is being called from the component body) would trigger
  // React's "too many re-renders" guard.
  useSSE.mockImplementation((_url, { onInit } = {}) => {
    queueMicrotask(() => onInit?.(SAMPLE_DATA));
    return { connected: true };
  });

  // Default: api.pbxExtensions resolves to a neutral payload so tests that
  // don't care about the extensions indicator (R1-R11, #24) don't need to
  // mock it individually. Tests for R14-R17 override this per-test.
  api.pbxExtensions.mockResolvedValue({
    ok: true,
    data: { total: 0, active: 0, extensions: [], available: false },
  });
});

describe('Dashboard - indicadores de extensiones AMI (R14-R17)', () => {

  it('R14 - muestra un indicador "Extensiones" con el valor `total` de api.pbxExtensions()', async () => {
    api.pbxExtensions.mockResolvedValue({
      ok: true,
      data: { total: 12, active: 9, extensions: [], available: true },
    });

    render(<Dashboard />);

    expect(await screen.findByText('Extensiones')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('12')).toBeInTheDocument();
    });
  });

  it('R15 - muestra un indicador "Activas" con el valor `active` de api.pbxExtensions()', async () => {
    api.pbxExtensions.mockResolvedValue({
      ok: true,
      data: { total: 12, active: 9, extensions: [], available: true },
    });

    render(<Dashboard />);

    expect(await screen.findByText('Activas')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('9')).toBeInTheDocument();
    });
  });

  it('R16 - cuando available === false, los indicadores se muestran con degradación visual sin afectar el resto de KPIs', async () => {
    api.pbxExtensions.mockResolvedValue({
      ok: true,
      data: { total: 0, active: 0, extensions: [], available: false },
    });

    render(<Dashboard />);

    const extensionesLabel = await screen.findByText('Extensiones');

    // El contenedor de los indicadores de extensiones debe llevar una clase
    // de atenuación visual (opacity-*) cuando available === false.
    const dimmedContainer = extensionesLabel.closest('[class*="opacity-"]');
    expect(dimmedContainer).not.toBeNull();

    // El resto de KPIs (p. ej. "Total llamadas") sigue presente y sin
    // atenuar, es decir, el resto del dashboard no se ve afectado.
    expect(screen.getByText('Total llamadas')).toBeInTheDocument();
    const totalLlamadasContainer = screen.getByText('Total llamadas').closest('[class*="opacity-"]');
    expect(totalLlamadasContainer).toBeNull();
  });

  it('R17 - si api.pbxExtensions() falla, el dashboard no rompe y muestra el estado neutro (total: 0, active: 0, available: false)', async () => {
    api.pbxExtensions.mockRejectedValue(new Error('network error'));

    render(<Dashboard />);

    // El resto del dashboard sigue renderizando con normalidad.
    expect(await screen.findByText('Total llamadas')).toBeInTheDocument();

    const extensionesLabel = await screen.findByText('Extensiones');
    const activasLabel = screen.getByText('Activas');

    // Estado neutro: ambos indicadores muestran 0.
    await waitFor(() => {
      const card = extensionesLabel.closest('.card');
      expect(card.textContent).toContain('0');
    });

    const activasCard = activasLabel.closest('.card');
    expect(activasCard.textContent).toContain('0');

    // Y permanecen en el contenedor atenuado (available: false).
    const dimmedContainer = extensionesLabel.closest('[class*="opacity-"]');
    expect(dimmedContainer).not.toBeNull();
  });
});

describe('Dashboard - split "Perdidas" / "No Contestadas" (R1-R11, #24)', () => {

  it('R1/R4 - Dashboard renderiza una StatCard "Perdidas" con value = breakdown.ivr_hangup y el mismo formato que "Contestadas"', async () => {
    render(<Dashboard />);

    const label = await screen.findByText('Perdidas');
    const card = label.closest('.card');

    // value (R1): breakdown.ivr_hangup = 5
    expect(card.textContent).toContain('5');

    // mismo formato que "Contestadas": label + valor + sub-texto + %
    const contestadasCard = screen.getByText('Contestadas').closest('.card');
    expect(card.querySelector('p.text-3xl')).not.toBeNull();
    expect(contestadasCard.querySelector('p.text-3xl')).not.toBeNull();
    expect(card.textContent).toContain('colgó en IVR, del total');
    expect(card.textContent).toContain('%');
  });

  it('R2/R5 - Dashboard renderiza una StatCard "No Contestadas" con value = breakdown.no_answer + breakdown.queue_no_agent y el mismo formato que "Contestadas"', async () => {
    render(<Dashboard />);

    const label = await screen.findByText('No Contestadas');
    const card = label.closest('.card');

    // value (R2): breakdown.no_answer (8) + breakdown.queue_no_agent (7) = 15
    expect(card.textContent).toContain('15');
    expect(card.textContent).toContain('sin respuesta, del total');
    expect(card.textContent).toContain('%');
  });

  it('R3 - la suma de los valores de "Perdidas" y "No Contestadas" es igual a dispositions["NO ANSWER"].count para un payload de ejemplo', async () => {
    render(<Dashboard />);

    const perdidas = (await screen.findByText('Perdidas')).closest('.card');
    const noContestadas = screen.getByText('No Contestadas').closest('.card');

    // Perdidas = 5 (ivr_hangup), No Contestadas = 8 + 7 = 15
    // Suma = 20 === dispositions['NO ANSWER'].count (20)
    expect(perdidas.textContent).toContain('5');
    expect(noContestadas.textContent).toContain('15');
    const sum = 5 + 15;
    expect(sum).toBe(SAMPLE_DATA.stats.dispositions['NO ANSWER'].count);
  });

  it('R6 - el pct de "Perdidas" y "No Contestadas" se calcula sobre stats.total, no sobre dispositions["NO ANSWER"].count ni entre sí', async () => {
    render(<Dashboard />);

    const perdidas = (await screen.findByText('Perdidas')).closest('.card');
    const noContestadas = screen.getByText('No Contestadas').closest('.card');

    // total = 100. lost = 5 -> pct = 5%. noAnswer = 15 -> pct = 15%.
    // (15% !== 20% que sería count/total de dispositions['NO ANSWER'], y
    // 5% + 15% = 20% !== 100% entre sí).
    expect(perdidas.textContent).toContain('5%');
    expect(noContestadas.textContent).toContain('15%');
  });

  it('R8 - Total === Contestadas + Perdidas + No Contestadas + Ocupado + Fallidas para un payload de ejemplo', async () => {
    render(<Dashboard />);

    await screen.findByText('Perdidas');

    const total = SAMPLE_DATA.stats.total; // 100
    const answered = SAMPLE_DATA.stats.dispositions.ANSWERED.count; // 70
    const busy = SAMPLE_DATA.stats.dispositions.BUSY.count; // 5
    const failed = SAMPLE_DATA.stats.dispositions.FAILED.count; // 5
    const { no_answer, ivr_hangup, queue_no_agent } = SAMPLE_DATA.stats.dispositions['NO ANSWER'].breakdown;
    const lost = ivr_hangup; // 5
    const noAnswer = no_answer + queue_no_agent; // 15

    expect(total).toBe(answered + lost + noAnswer + busy + failed);
  });

  it('R10 - cuando dispositions["NO ANSWER"].breakdown es undefined, "Perdidas" y "No Contestadas" renderizan value=0 y pct=0 sin error', async () => {
    useSSE.mockImplementation((_url, { onInit } = {}) => {
      queueMicrotask(() => onInit?.(withBreakdown(undefined)));
      return { connected: true };
    });
    api.pbxExtensions.mockResolvedValue({
      ok: true,
      data: { total: 0, active: 0, extensions: [], available: false },
    });

    render(<Dashboard />);

    const perdidas = (await screen.findByText('Perdidas')).closest('.card');
    const noContestadas = screen.getByText('No Contestadas').closest('.card');

    expect(perdidas.querySelector('p.text-3xl').textContent).toBe('0');
    expect(noContestadas.querySelector('p.text-3xl').textContent).toBe('0');
    expect(perdidas.textContent).toContain('0%');
    expect(noContestadas.textContent).toContain('0%');
  });

  it('R11 - cuando breakdown está presente pero falta una de sus claves (no_answer/ivr_hangup/queue_no_agent), esa clave se trata como 0', async () => {
    useSSE.mockImplementation((_url, { onInit } = {}) => {
      // Falta `ivr_hangup` y `queue_no_agent` — solo `no_answer` presente.
      queueMicrotask(() => onInit?.(withBreakdown({ no_answer: 8 })));
      return { connected: true };
    });
    api.pbxExtensions.mockResolvedValue({
      ok: true,
      data: { total: 0, active: 0, extensions: [], available: false },
    });

    render(<Dashboard />);

    const perdidas = (await screen.findByText('Perdidas')).closest('.card');
    const noContestadas = screen.getByText('No Contestadas').closest('.card');

    // ivr_hangup ausente -> tratado como 0
    expect(perdidas.querySelector('p.text-3xl').textContent).toBe('0');
    // no_answer (8) + queue_no_agent (ausente -> 0) = 8
    expect(noContestadas.querySelector('p.text-3xl').textContent).toBe('8');
  });
});
