import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import { api } from '../../api';
import { useSSE } from '../../hooks/useSSE';
import { useAuth } from '../../contexts/AuthContext';
import MinutesMonitorView from './MinutesMonitorView';

// Mock src/api.js — la vista nunca hace fetch() directo (conventions).
vi.mock('../../api', () => ({
  api: {
    minutesMonitorStatus: vi.fn(),
    minutesMonitorConfig: vi.fn(),
    updateMinutesMonitorConfig: vi.fn(),
  },
}));

// Mock useSSE para capturar el handler del evento del plugin sin abrir
// un EventSource real (patrón Dashboard.test.jsx).
vi.mock('../../hooks/useSSE', () => ({
  useSSE: vi.fn(),
}));

// Mock useAuth — se varía el rol por test (R24/R28).
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

// Mock del formulario de config: aquí solo se prueba su visibilidad por rol.
vi.mock('./MinutesMonitorConfig', () => ({
  default: () => <div data-testid="minutes-config-form" />,
}));

// Mock de Recharts — ResponsiveContainer necesita dimensiones reales de
// layout que jsdom no provee (patrón Dashboard.test.jsx).
vi.mock('recharts', () => {
  const Stub = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Stub,
    BarChart: Stub,
    Bar: () => null,
    LineChart: Stub,
    Line: () => null,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    ReferenceLine: () => null,
  };
});

const ESTADO = {
  timestamp: '2026-07-02T15:00:00.000Z',
  mes: '2026-07',
  nivelAlerta: 'CRITICO',
  estadoAlerta: '🟠 ALERTA CRÍTICA',
  minutosConsumidos: 66500,
  llamadas: 1000,
  baseComparacion: 66500,
  baseEsExtensiones: false,
  umbralMinutos: 70000,
  porcentajeUso: 95,
  minutosRestantes: 3500,
  excedente: 120,
  costoExcedente: 6000,
  moneda: 'COP',
  promMinPorLlamada: 66.5,
  alertaTempranaP: 85,
  alertaCriticaP: 95,
  troncales: [
    { troncal: 'SIP/trunk1', alias: 'Claro', minutos: 40000, llamadas: 600, promMinPorLlamada: 66.67 },
    { troncal: 'SIP/trunk2', alias: null, minutos: 26500, llamadas: 400, promMinPorLlamada: 66.25 },
  ],
  extensiones: [
    {
      numero: '1001', nombre: 'Ventas', minutos: 300, llamadas: 20,
      umbral: 200, esUmbralPropio: true, porcentaje: 150, excedente: 100,
      estado: 'SUPERADO', promMinPorLlamada: 15,
    },
  ],
};

const HISTORIAL = [
  { timestamp: '2026-07-02T14:00:00.000Z', minutosConsumidos: 66000, baseComparacion: 66000, porcentajeUso: 94.3, nivelAlerta: 'CRITICO' },
  { timestamp: '2026-07-02T15:00:00.000Z', minutosConsumidos: 66500, baseComparacion: 66500, porcentajeUso: 95, nivelAlerta: 'CRITICO' },
];

let sseEvents;

beforeEach(() => {
  vi.clearAllMocks();
  sseEvents = null;
  useAuth.mockReturnValue({ user: { id: 1, username: 'admin', role: 'admin' } });
  useSSE.mockImplementation((_url, { events } = {}) => {
    sseEvents = events;
    return { connected: true, lastEvent: null };
  });
  api.minutesMonitorStatus.mockResolvedValue({
    ok: true,
    data: { hasData: true, estado: ESTADO, historial: HISTORIAL, ultimaMedicion: ESTADO.timestamp },
  });
});

describe('MinutesMonitorView', () => {
  it('R23 - sin mediciones muestra el estado vacío con el aviso de primera medición automática', async () => {
    api.minutesMonitorStatus.mockResolvedValue({
      ok: true,
      data: { hasData: false, estado: null, historial: [], ultimaMedicion: null },
    });

    render(<MinutesMonitorView />);

    expect(
      await screen.findByText(/Aún no hay mediciones este mes; la primera se ejecuta automáticamente/)
    ).toBeInTheDocument();
    expect(screen.queryByText('🟠 ALERTA CRÍTICA')).not.toBeInTheDocument();
  });

  it('R30 - la tarjeta global muestra el nivel de alerta, porcentaje, consumidos/restantes y el costo excedente > 0', async () => {
    render(<MinutesMonitorView />);

    expect(await screen.findByText('🟠 ALERTA CRÍTICA')).toBeInTheDocument();
    expect(screen.getByText('95%')).toBeInTheDocument();
    expect(screen.getByText(/66\.500 min/)).toBeInTheDocument();     // consumidos
    expect(screen.getByText(/3\.500 min/)).toBeInTheDocument();      // restantes
    expect(screen.getByText('Costo excedente')).toBeInTheDocument(); // costoExcedente > 0
    expect(screen.getByText(/6\.000 COP/)).toBeInTheDocument();
  });

  it('R31 - muestra troncales con alias y extensiones con badge de estado', async () => {
    render(<MinutesMonitorView />);

    // Troncales: alias en la tabla cuando existe, — cuando no
    expect(await screen.findByText('SIP/trunk1')).toBeInTheDocument();
    expect(screen.getAllByText('Claro').length).toBeGreaterThan(0);
    expect(screen.getByText('SIP/trunk2')).toBeInTheDocument();

    // Extensión monitoreada con su estado (badge)
    expect(screen.getByText('1001')).toBeInTheDocument();
    expect(screen.getByText('Ventas')).toBeInTheDocument();
    expect(screen.getByText('SUPERADO')).toBeInTheDocument();

    // Sección de evolución presente
    expect(screen.getByText('Evolución del mes')).toBeInTheDocument();
  });

  it('R32 - se actualiza en vivo al recibir el evento plugin:minutes-monitor:update sin recargar', async () => {
    render(<MinutesMonitorView />);
    await screen.findByText('🟠 ALERTA CRÍTICA');

    // El hook fue suscrito al evento namespaced del plugin
    expect(sseEvents).toBeTruthy();
    const handler = sseEvents['plugin:minutes-monitor:update'];
    expect(typeof handler).toBe('function');

    act(() => {
      handler({
        estado: { ...ESTADO, nivelAlerta: 'CRITICO', estadoAlerta: '🔴 UMBRAL SUPERADO', porcentajeUso: 101 },
        historial: HISTORIAL,
      });
    });

    expect(screen.getByText('🔴 UMBRAL SUPERADO')).toBeInTheDocument();
    expect(screen.queryByText('🟠 ALERTA CRÍTICA')).not.toBeInTheDocument();
  });

  it('R24/R28 - la sección de configuración solo es visible para administradores', async () => {
    const { unmount } = render(<MinutesMonitorView />);
    const btn = await screen.findByRole('button', { name: /Configuración/ });
    act(() => { btn.click(); });
    expect(screen.getByTestId('minutes-config-form')).toBeInTheDocument();
    unmount();

    useAuth.mockReturnValue({ user: { id: 2, username: 'operador', role: 'operador' } });
    render(<MinutesMonitorView />);
    await screen.findByText('🟠 ALERTA CRÍTICA');
    expect(screen.queryByRole('button', { name: /Configuración/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('minutes-config-form')).not.toBeInTheDocument();
  });
});
