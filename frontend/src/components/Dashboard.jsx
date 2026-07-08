import { useState, useCallback, useEffect } from 'react';
import {
  Phone, PhoneMissed, PhoneCall,
  PhoneIncoming, PhoneOutgoing,
  Wifi, WifiOff, RefreshCw, Users,
} from 'lucide-react';
import { StatCard } from './StatCard';
import { DispositionChart } from './DispositionChart';
import { HourlyChart } from './HourlyChart';
import { ChannelTable } from './ChannelTable';
import { useSSE } from '../hooks/useSSE';
import { api } from '../api';

const EXTENSIONS_POLL_MS = 30000;
const EMPTY_EXTENSIONS_STATUS = { total: 0, active: 0, extensions: [], available: false };

function fmtTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDate(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleDateString('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
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
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
            isLost ? 'bg-red-500/10' : 'bg-blue-500/10'
          }`}>
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


export default function Dashboard() {
  const [data, setData] = useState(null);
  const handleData = useCallback((d) => setData(d), []);
  const { connected } = useSSE('/api/events', { onInit: handleData, onUpdate: handleData });

  // Extensions status (AMI) — REST polling, independent of SSE (R14-R17).
  const [extensionsData, setExtensionsData] = useState(EMPTY_EXTENSIONS_STATUS);

  useEffect(() => {
    let cancelled = false;

    function loadExtensions() {
      api.pbxExtensions()
        .then(res => {
          if (!cancelled) setExtensionsData(res.data ?? EMPTY_EXTENSIONS_STATUS);
        })
        .catch(() => {
          if (!cancelled) setExtensionsData(EMPTY_EXTENSIONS_STATUS);
        });
    }

    loadExtensions();
    const interval = setInterval(loadExtensions, EXTENSIONS_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const disp           = data?.stats?.dispositions;
  const total          = data?.stats?.total ?? 0;
  const channels       = data?.inbound?.channels ?? [];
  const hourly         = data?.hourly   ?? [];
  const queues         = data?.queues   ?? [];
  const channelAliases = data?.channelAliases ?? {};

  const answered = disp?.ANSWERED?.count ?? 0;

  const answeredPct = disp?.ANSWERED?.pct ?? 0;

  // R10/R11: breakdown puede ser undefined (payload legacy) o tener claves
  // faltantes — default por clave individual, no all-or-nothing.
  const noAnswerBreakdown = disp?.['NO ANSWER']?.breakdown ?? {};

  // R1: "Perdidas" = colgó en IVR/menú (dst en config.lostDestinations).
  const lost = noAnswerBreakdown.ivr_hangup ?? 0;

  // R2: "No Contestadas" = sin respuesta + cola sin agente real.
  const noAnswer =
    (noAnswerBreakdown.no_answer ?? 0) + (noAnswerBreakdown.queue_no_agent ?? 0);

  // R6: pct de cada tarjeta sobre el total general, no entre sí ni sobre
  // dispositions['NO ANSWER'].count.
  const lostPct =
    total > 0 ? Math.round((lost / total) * 1000) / 10 : 0;
  const noAnswerPct =
    total > 0 ? Math.round((noAnswer / total) * 1000) / 10 : 0;

  // #25/#38: desglose de "Perdidas" por horario de atención (solo si está configurado).
  const businessHours = data?.businessHours ?? null;
  const lostBusiness    = noAnswerBreakdown.ivr_hangup_business ?? 0;
  const lostOffhours    = noAnswerBreakdown.ivr_hangup_offhours ?? 0;
  const lostBusinessPct = total > 0 ? Math.round((lostBusiness / total) * 1000) / 10 : 0;
  const lostOffhoursPct = total > 0 ? Math.round((lostOffhours / total) * 1000) / 10 : 0;

  const inboundTotal  = data?.inbound?.stats?.total  ?? 0;
  const outboundTotal = data?.outbound?.stats?.total ?? 0;
  const inboundPct  = total > 0 ? Math.round((inboundTotal  / total) * 1000) / 10 : 0;
  const outboundPct = total > 0 ? Math.round((outboundTotal / total) * 1000) / 10 : 0;

  return (
    <div className="p-6 space-y-6 min-h-screen">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-3xl font-bold text-slate-100 capitalize leading-tight">
            {fmtDate(data?.generatedAt)}
          </p>
          {data && (
            <p className="text-lg text-slate-400 mt-1">
              Última actualización: <span className="text-slate-200 tabular-nums">{fmtTime(data.generatedAt)}</span>
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
          {/* Stat cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            
            
            <StatCard label="Contestadas" value={answered} icon={PhoneCall} color="green"
              sub="del total" pct={answeredPct}
              hint="Llamadas en las que un agente atendió y hubo conversación real. Es el indicador principal de que los agentes están respondiendo." />
            <StatCard label="No Contestadas" value={noAnswer} icon={PhoneMissed} color="amber"
              sub="del total" pct={noAnswerPct}
              hint="Llamadas que llegaron a la cola de espera pero ningún agente las tomó a tiempo y el cliente colgó la llamada. El cliente esperó y no fue atendido." />
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

          {/* Resumen de duración/canales/extensiones */}
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
            <div className="h-10 w-px bg-slate-700" />
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Canales activos hoy</p>
              <p className="text-2xl font-bold text-slate-100 mt-1">{channels.length}</p>
            </div>
            <div className="h-10 w-px bg-slate-700" />
            <div className={extensionsData.available ? '' : 'opacity-50'} title={extensionsData.available ? undefined : 'Estado de extensiones no disponible (AMI)'}>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Extensiones</p>
              <p className="text-2xl font-bold text-slate-100 mt-1">
                <span className="text-emerald-400">{extensionsData.active}</span>
                <span className="text-slate-500"> / </span>
                <span>{extensionsData.total}</span>
              </p>
              <p className="text-xs text-slate-500 mt-0.5">activas / total</p>
            </div>
          </div>

          {/* Desglose Entrantes / Salientes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatCard label="Llamadas entrantes" value={inboundTotal} icon={PhoneIncoming} color="blue"
              sub="del total" pct={inboundPct}
              hint="Total de llamadas que llegaron desde el exterior hacia el call center hoy, incluyendo las contestadas, las perdidas y las no contestadas." />
            <StatCard label="Llamadas salientes" value={outboundTotal} icon={PhoneOutgoing} color="blue"
              sub="del total" pct={outboundPct}
              hint="Total de llamadas que los agentes realizaron hacia el exterior hoy." />
          </div>

          {/* Colas de entrada (sin repetir Perdidas que ya aparece arriba) */}
          {queues.filter(q => q.queue !== '__lost__').length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {queues.filter(q => q.queue !== '__lost__').map(q => <QueueCard key={q.queue} queue={q} />)}
            </div>
          )}

          {/* Gráficas */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="card lg:col-span-2">
              <h2 className="text-sm font-semibold text-slate-200 mb-4">Distribución de llamadas</h2>
              <DispositionChart dispositions={disp} businessHours={businessHours} />
            </div>
            <div className="card lg:col-span-3">
              <h2 className="text-sm font-semibold text-slate-200 mb-4">Llamadas por hora (hoy)</h2>
              <HourlyChart hourly={hourly} businessHours={businessHours} />
            </div>
          </div>

          {/* Tabla canales */}
          {channels.length > 0 && (
            <div className="card">
              <h2 className="text-sm font-semibold text-slate-200 mb-4">
                Estadísticas por canal
                <span className="ml-2 text-xs font-normal text-slate-500">({channels.length} canales)</span>
              </h2>
              <ChannelTable channels={channels} channelAliases={channelAliases} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
