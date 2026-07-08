import { useState, useEffect } from 'react';
import { Timer, Settings, PhoneCall, Gauge, TrendingUp, Server } from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { api } from '../../api';
import { useSSE } from '../../hooks/useSSE';
import { useAuth } from '../../contexts/AuthContext';
import MinutesMonitorConfig from './MinutesMonitorConfig';

// Estilos por nivel de alerta global (mapa como STATUS_BADGES de PluginsManager)
const NIVEL_STYLES = {
  OK:          { badge: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30', bar: 'bg-emerald-500' },
  ADVERTENCIA: { badge: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',       bar: 'bg-amber-500' },
  CRITICO:     { badge: 'bg-red-500/15 text-red-400 border border-red-500/30',             bar: 'bg-red-500' },
};

// Badges por estado de extensión
const EXT_BADGES = {
  OK:          'bg-emerald-500/15 text-emerald-400',
  ADVERTENCIA: 'bg-amber-500/15 text-amber-400',
  CRITICO:     'bg-red-500/15 text-red-400',
  SUPERADO:    'bg-red-500/25 text-red-300',
};

const fmt = (n) => Number(n ?? 0).toLocaleString('es-CO');

function KpiTile({ icon: Icon, label, value, sub }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <div className="flex items-center gap-2 text-slate-400 text-xs uppercase tracking-wider mb-1">
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {label}
      </div>
      <p className="text-2xl font-semibold text-slate-100">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

/**
 * Vista del plugin minutes-monitor (feature #55, R30–R32).
 * Carga inicial REST + actualización en vivo por SSE
 * (`plugin:minutes-monitor:update`), sin recargar la página.
 */
export default function MinutesMonitorView() {
  const { user } = useAuth() || {};
  const [data, setData]       = useState(null);   // { hasData, estado, historial }
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.minutesMonitorStatus()
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Error al cargar el estado'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useSSE('/api/events', {
    events: {
      'plugin:minutes-monitor:update': ({ estado, historial }) =>
        setData({ hasData: true, estado, historial, ultimaMedicion: estado?.timestamp ?? null }),
    },
  });

  if (loading) {
    return (
      <div className="p-8 flex justify-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const estado    = data?.estado;
  const historial = data?.historial || [];
  const isAdmin   = user?.role === 'admin';

  const nivel = NIVEL_STYLES[estado?.nivelAlerta] || NIVEL_STYLES.OK;
  const progreso = Math.min(100, estado?.porcentajeUso ?? 0);

  const troncalesData = (estado?.troncales || []).map(t => ({
    nombre: t.alias || t.troncal,
    Minutos: t.minutos,
  }));
  const evolucionData = historial.map(h => ({
    hora: new Date(h.timestamp).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
    Minutos: h.minutosConsumidos,
  }));

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Timer className="w-6 h-6 text-blue-400" />
          <div>
            <h1 className="text-xl font-semibold text-slate-100">Monitor de minutos</h1>
            <p className="text-sm text-slate-400">Consumo del mes en curso frente al umbral configurado.</p>
          </div>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setShowConfig(s => !s)}
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
          >
            <Settings className="w-4 h-4" />
            Configuración
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-lg px-4 py-3" role="alert">
          {error}
        </div>
      )}

      {isAdmin && showConfig && <MinutesMonitorConfig />}

      {!error && !data?.hasData && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 text-center text-sm text-slate-400">
          Aún no hay mediciones este mes; la primera se ejecuta automáticamente.
        </div>
      )}

      {estado && (
        <>
          {/* Tarjeta de estado global (R30) */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${nivel.badge}`}>
                {estado.estadoAlerta}
              </span>
              <div className="text-xs text-slate-500">
                Mes {estado.mes} · última medición{' '}
                {new Date(estado.timestamp).toLocaleString('es-CO')}
                {estado.baseEsExtensiones && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300">
                    base: extensiones monitoreadas
                  </span>
                )}
              </div>
            </div>

            <div className="mb-5">
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>Uso del umbral</span>
                <span className="text-slate-200 font-medium">{estado.porcentajeUso}%</span>
              </div>
              <div className="h-2.5 rounded-full bg-slate-700 overflow-hidden">
                <div className={`h-full rounded-full ${nivel.bar}`} style={{ width: `${progreso}%` }} />
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiTile icon={Gauge} label="Consumidos" value={`${fmt(estado.minutosConsumidos)} min`} sub={`de ${fmt(estado.umbralMinutos)} min de umbral`} />
              <KpiTile icon={TrendingUp} label="Restantes" value={`${fmt(estado.minutosRestantes)} min`} />
              <KpiTile icon={PhoneCall} label="Llamadas" value={fmt(estado.llamadas)} sub={`${fmt(estado.promMinPorLlamada)} min/llamada`} />
              {estado.costoExcedente > 0 ? (
                <KpiTile
                  icon={Server}
                  label="Costo excedente"
                  value={`${fmt(estado.costoExcedente)} ${estado.moneda}`}
                  sub={`${fmt(estado.excedente)} min excedidos`}
                />
              ) : (
                <KpiTile icon={Server} label="Excedente" value={`${fmt(estado.excedente)} min`} />
              )}
            </div>
          </div>

          {/* Desglose por troncal (R31) */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-slate-200 mb-4">Consumo por troncal</h2>
            {troncalesData.length === 0 ? (
              <p className="text-sm text-slate-500">Sin consumo por troncal este mes.</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={troncalesData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="nombre" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }}
                      cursor={{ fill: '#334155' }}
                    />
                    <Bar dataKey="Minutos" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <table className="w-full text-sm mt-4">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700">
                      <th className="px-3 py-2">Troncal</th>
                      <th className="px-3 py-2">Alias</th>
                      <th className="px-3 py-2 text-right">Minutos</th>
                      <th className="px-3 py-2 text-right">Llamadas</th>
                      <th className="px-3 py-2 text-right">Min/llamada</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/60">
                    {estado.troncales.map(t => (
                      <tr key={t.troncal} className="text-slate-300">
                        <td className="px-3 py-2 font-mono text-xs">{t.troncal}</td>
                        <td className="px-3 py-2">{t.alias || '—'}</td>
                        <td className="px-3 py-2 text-right">{fmt(t.minutos)}</td>
                        <td className="px-3 py-2 text-right">{fmt(t.llamadas)}</td>
                        <td className="px-3 py-2 text-right">{fmt(t.promMinPorLlamada)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>

          {/* Desglose por extensión monitoreada (R31) */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-slate-200 mb-4">Extensiones monitoreadas</h2>
            {(estado.extensiones || []).length === 0 ? (
              <p className="text-sm text-slate-500">
                No hay extensiones monitoreadas configuradas.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700">
                    <th className="px-3 py-2">Número</th>
                    <th className="px-3 py-2">Nombre</th>
                    <th className="px-3 py-2 text-right">Minutos</th>
                    <th className="px-3 py-2 text-right">Llamadas</th>
                    <th className="px-3 py-2 text-right">Umbral</th>
                    <th className="px-3 py-2 text-right">% uso</th>
                    <th className="px-3 py-2">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/60">
                  {estado.extensiones.map(ext => (
                    <tr key={ext.numero} className="text-slate-300">
                      <td className="px-3 py-2 font-mono text-xs">{ext.numero}</td>
                      <td className="px-3 py-2">{ext.nombre || '—'}</td>
                      <td className="px-3 py-2 text-right">{fmt(ext.minutos)}</td>
                      <td className="px-3 py-2 text-right">{fmt(ext.llamadas)}</td>
                      <td className="px-3 py-2 text-right">
                        {fmt(ext.umbral)}{ext.esUmbralPropio ? '' : ' (global)'}
                      </td>
                      <td className="px-3 py-2 text-right">{ext.porcentaje}%</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${EXT_BADGES[ext.estado] || EXT_BADGES.OK}`}>
                          {ext.estado}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Evolución de las mediciones del mes (R31) */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-slate-200 mb-4">Evolución del mes</h2>
            {evolucionData.length === 0 ? (
              <p className="text-sm text-slate-500">Sin mediciones registradas.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={evolucionData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="hora" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }}
                  />
                  <ReferenceLine y={estado.umbralMinutos} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'Umbral', fill: '#ef4444', fontSize: 11 }} />
                  <Line type="monotone" dataKey="Minutos" stroke="#3b82f6" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </>
      )}
    </div>
  );
}
