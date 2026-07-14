import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { api } from '../api';
import HistoricalView from './HistoricalView';

// Mock src/api.js — HistoricalView must never `fetch()` directly (conventions).
vi.mock('../api', () => ({
  api: {
    range: vi.fn(),
  },
}));

// Mock chart components — they wrap Recharts' ResponsiveContainer, which needs
// real layout dimensions to render meaningfully in jsdom.
vi.mock('./DispositionChart', () => ({
  DispositionChart: () => <div data-testid="disposition-chart" />,
}));
vi.mock('./HourlyChart', () => ({
  HourlyChart: () => <div data-testid="hourly-chart" />,
}));
vi.mock('./ChannelTable', () => ({
  ChannelTable: () => <div data-testid="channel-table" />,
}));

// AppConfig provides a stable timezone so the date defaults resolve.
vi.mock('../contexts/AppConfigContext', () => ({
  useAppConfig: () => ({ dbTimezone: '-05:00' }),
}));

const SAMPLE_DATA = {
  stats: { total: 100, dispositions: { ANSWERED: { count: 70, pct: 70 }, 'NO ANSWER': { count: 30, pct: 30, breakdown: {} }, BUSY: { count: 0 }, FAILED: { count: 0 } } },
  inbound:  { stats: { total: 60 }, channels: [] },
  outbound: { stats: { total: 40 }, channels: [] },
  hourly: [],
  channels: [],
  channelAliases: {},
  queues: [
    { queue: '8000', label: 'Ventas',   total: 40, ANSWERED: 30, 'NO ANSWER': 10, FAILED: 0 },
    { queue: '8001', label: 'Cola 8001', total: 20, ANSWERED: 15, 'NO ANSWER': 5,  FAILED: 0 },
    { queue: '__lost__', label: 'Perdidas', total: 8, ANSWERED: 0, 'NO ANSWER': 8, FAILED: 0 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// QueueCard renders its label in this specific span; "Perdidas" also appears
// elsewhere as a lost-destinations StatCard, so we target the queue-card label
// span to unambiguously count rendered queue cards.
const QUEUE_LABEL_SELECTOR = 'span.text-sm.font-semibold.text-slate-200';

describe('HistoricalView - sección de colas (R1/R2/R3)', () => {
  it('R1/R2 - renderiza una QueueCard por cola de data.queues excluyendo __lost__', async () => {
    api.range.mockResolvedValue(SAMPLE_DATA);

    const { container } = render(<HistoricalView />);
    fireEvent.click(screen.getByText('Buscar'));

    await screen.findByTestId('channel-table');

    const labels = await waitFor(() => {
      const found = [...container.querySelectorAll(QUEUE_LABEL_SELECTOR)].map(el => el.textContent);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });

    // Solo las dos colas configuradas; __lost__ ("Perdidas") queda excluido.
    expect(labels).toEqual(['Ventas', 'Cola 8001']);
    expect(labels).not.toContain('Perdidas');
  });

  it('R3 - sin colas configuradas (solo __lost__) no renderiza tarjetas de cola', async () => {
    api.range.mockResolvedValue({
      ...SAMPLE_DATA,
      queues: [{ queue: '__lost__', label: 'Perdidas', total: 3, ANSWERED: 0, 'NO ANSWER': 3, FAILED: 0 }],
    });

    const { container } = render(<HistoricalView />);
    fireEvent.click(screen.getByText('Buscar'));

    // La tabla de canales aparece cuando hay resultados; las colas no.
    await screen.findByTestId('channel-table');
    const labels = [...container.querySelectorAll(QUEUE_LABEL_SELECTOR)].map(el => el.textContent);
    expect(labels).toHaveLength(0);
  });
});
