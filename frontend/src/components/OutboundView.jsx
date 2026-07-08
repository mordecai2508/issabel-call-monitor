import { useState, useCallback } from 'react';
import { Phone, PhoneCall, Wifi, WifiOff, RefreshCw, PhoneOutgoing } from 'lucide-react';
import { StatCard } from './StatCard';
import { ChannelTable } from './ChannelTable';
import { useSSE } from '../hooks/useSSE';

function fmtTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDuration(sec) {
  if (!sec) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function OutboundView() {
  const [data, setData] = useState(null);
  const handleData = useCallback((d) => setData(d), []);
  const { connected } = useSSE('/api/events', { onInit: handleData, onUpdate: handleData });

  const outbound       = data?.outbound;
  const disp           = outbound?.stats?.dispositions;
  const total          = outbound?.stats?.total ?? 0;
  const channels       = outbound?.channels ?? [];
  const channelAliases = data?.channelAliases ?? {};

  return (
    <div className="p-6 space-y-6 min-h-screen">

      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-500/10 rounded-lg flex items-center justify-center">
              <PhoneOutgoing className="w-4 h-4 text-emerald-400" />
            </div>
            <h1 className="text-xl font-semibold text-slate-100">Llamadas salientes</h1>
          </div>
          {data && (
            <p className="text-sm text-slate-500 mt-1 ml-10">
              Actualizado: <span className="text-slate-400">{fmtTime(data.generatedAt)}</span>
            </p>
          )}
        </div>
        <div className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full border shrink-0 ${
          connected
            ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
            : 'text-slate-400 bg-slate-700/50 border-slate-600'
        }`}>
          {connected ? <><Wifi className="w-4 h-4" /> En vivo</> : <><WifiOff className="w-4 h-4" /> Reconectando...</>}
        </div>
      </div>

      {!data && (
        <div className="card flex items-center justify-center gap-3 py-12 text-slate-500">
          <RefreshCw className="w-5 h-5 animate-spin" />
          <span>Conectando con el servidor...</span>
        </div>
      )}

      {data && total === 0 && channels.length === 0 && (
        <div className="card flex items-center justify-center py-16 text-slate-500 text-sm">
          No hay llamadas salientes registradas hoy
        </div>
      )}

      {data && (total > 0 || channels.length > 0) && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatCard label="Total salientes" value={total}                 icon={Phone}     color="blue" />
            <StatCard label="Contestadas"     value={disp?.ANSWERED?.count} icon={PhoneCall} color="green"
              sub="del total" pct={disp?.ANSWERED?.pct} />
          </div>

          <div className="card flex flex-wrap items-center gap-8">
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Duración prom. contestadas</p>
              <p className="text-2xl font-bold text-slate-100 mt-1">{fmtDuration(disp?.ANSWERED?.avg_billsec ?? 0)}</p>
            </div>
            <div className="h-10 w-px bg-slate-700" />
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Tiempo total en llamadas</p>
              <p className="text-2xl font-bold text-slate-100 mt-1">{fmtDuration(disp?.ANSWERED?.total_billsec ?? 0)}</p>
            </div>
          </div>

          {channels.length > 0 && (
            <div className="card">
              <h2 className="text-sm font-semibold text-slate-200 mb-4">
                Canales salientes
                <span className="ml-2 text-xs font-normal text-slate-500">({channels.length})</span>
              </h2>
              <ChannelTable channels={channels} channelAliases={channelAliases} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
