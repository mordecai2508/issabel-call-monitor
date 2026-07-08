import { useState, useCallback } from 'react';
import { Phone, PhoneCall, PhoneMissed, Wifi, WifiOff, RefreshCw, Users, PhoneIncoming } from 'lucide-react';
import { StatCard } from './StatCard';
import { DispositionChart } from './DispositionChart';
import { HourlyChart } from './HourlyChart';
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

function QueueCard({ queue }) {
  const isLost   = queue.queue === '__lost__';
  const answered = queue.ANSWERED ?? 0;
  const total    = queue.total    ?? 0;
  const pct      = total > 0 ? Math.round((answered / total) * 100) : 0;

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isLost ? 'bg-red-500/10' : 'bg-blue-500/10'}`}>
            <Users className={`w-4 h-4 ${isLost ? 'text-red-400' : 'text-blue-400'}`} />
          </div>
          <span className="text-sm font-semibold text-slate-200">{queue.label}</span>
        </div>
        <span className="text-2xl font-bold text-slate-100">{total}</span>
      </div>
      {!isLost && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-slate-500">
            <span>Contestadas</span>
            <span className="text-emerald-400 font-medium">{answered} ({pct}%)</span>
          </div>
          <div className="w-full h-1.5 bg-slate-700 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex justify-between text-xs text-slate-600">
            <span>No contest.: <span className="text-amber-400">{queue['NO ANSWER'] ?? 0}</span></span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function InboundView() {
  const [data, setData] = useState(null);
  const handleData = useCallback((d) => setData(d), []);
  const { connected } = useSSE('/api/events', { onInit: handleData, onUpdate: handleData });

  const inbound        = data?.inbound;
  const disp           = inbound?.stats?.dispositions;
  const total          = inbound?.stats?.total ?? 0;
  const channels       = inbound?.channels ?? [];
  const hourly         = inbound?.hourly   ?? [];
  const queues         = data?.queues      ?? [];
  const channelAliases = data?.channelAliases ?? {};

  const answered = disp?.ANSWERED?.count ?? 0;
  const answeredPct = disp?.ANSWERED?.pct ?? 0;

  const noAnswerBreakdown = disp?.['NO ANSWER']?.breakdown ?? {};
  const lost     = noAnswerBreakdown.ivr_hangup ?? 0;
  const noAnswer = (noAnswerBreakdown.no_answer ?? 0) + (noAnswerBreakdown.queue_no_agent ?? 0);
  const lostPct     = total > 0 ? Math.round((lost     / total) * 1000) / 10 : 0;
  const noAnswerPct = total > 0 ? Math.round((noAnswer / total) * 1000) / 10 : 0;

  const businessHours = data?.businessHours ?? null;
  const lostBusiness    = noAnswerBreakdown.ivr_hangup_business ?? 0;
  const lostOffhours    = noAnswerBreakdown.ivr_hangup_offhours ?? 0;
  const lostBusinessPct = total > 0 ? Math.round((lostBusiness / total) * 1000) / 10 : 0;
  const lostOffhoursPct = total > 0 ? Math.round((lostOffhours / total) * 1000) / 10 : 0;

  return (
    <div className="p-6 space-y-6 min-h-screen">

      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-blue-500/10 rounded-lg flex items-center justify-center">
              <PhoneIncoming className="w-4 h-4 text-blue-400" />
            </div>
            <h1 className="text-xl font-semibold text-slate-100">Llamadas entrantes</h1>
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

      {data && (
        <>
          <div className={`grid grid-cols-2 gap-4 ${businessHours ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
            <StatCard label="Total entrantes" value={total}    icon={Phone}       color="blue" />
            <StatCard label="Contestadas"     value={answered} icon={PhoneCall}   color="green"
              sub="del total" pct={answeredPct} />
            <StatCard label="No Contestadas"  value={noAnswer} icon={PhoneMissed} color="amber"
              sub="del total" pct={noAnswerPct} />
            {businessHours ? (
              <>
                <StatCard
                  label="Perdidas en horario"
                  value={lostBusiness}
                  icon={PhoneMissed}
                  color="red"
                  sub="del total"
                  pct={lostBusinessPct}
                  hint="Clientes que llamaron durante el horario de atención, escucharon el menú y colgaron antes de hablar con alguien."
                />
                <StatCard
                  label="Perdidas fuera de horario"
                  value={lostOffhours}
                  icon={PhoneMissed}
                  color="slate"
                  sub="del total"
                  pct={lostOffhoursPct}
                  hint="Clientes que llamaron fuera del horario de atención, escucharon el menú y colgaron antes de hablar con alguien."
                />
              </>
            ) : (
              <StatCard
                label="Perdidas"
                value={lost}
                icon={PhoneMissed}
                color="red"
                sub="del total"
                pct={lostPct}
                hint="Clientes que llamaron, escucharon el menú de opciones y colgaron antes de hablar con alguien."
              />
            )}
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

          {queues.filter(q => q.queue !== '__lost__').length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {queues.filter(q => q.queue !== '__lost__').map(q => <QueueCard key={q.queue} queue={q} />)}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="card lg:col-span-2">
              <h2 className="text-sm font-semibold text-slate-200 mb-4">Distribución</h2>
              <DispositionChart dispositions={disp} businessHours={businessHours} />
            </div>
            <div className="card lg:col-span-3">
              <h2 className="text-sm font-semibold text-slate-200 mb-4">Llamadas por hora (hoy)</h2>
              <HourlyChart hourly={hourly} businessHours={businessHours} />
            </div>
          </div>

          {channels.length > 0 && (
            <div className="card">
              <h2 className="text-sm font-semibold text-slate-200 mb-4">
                Canales entrantes
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
