import { useState, useEffect } from 'react';
import { Search, Download } from 'lucide-react';
import { api } from '../api';
import { DispositionChart } from './DispositionChart';
import { HourlyChart } from './HourlyChart';
import { ChannelTable } from './ChannelTable';
import QueueCard from './QueueCard';
import { StatCard } from './StatCard';
import { Phone, PhoneCall, PhoneMissed, PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { useAppConfig } from '../contexts/AppConfigContext';
import { todayStr } from '../utils/date';

function fmtDate(str) {
  if (!str) return '—';
  // "YYYY-MM-DD" → tratar como fecha local para evitar desfase de un día por zona horaria
  const d = /^\d{4}-\d{2}-\d{2}$/.test(str) ? new Date(str + 'T00:00:00') : new Date(str);
  return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function HistoricalView() {
  const { dbTimezone } = useAppConfig();
  const [from, setFrom]     = useState(() => todayStr(dbTimezone));
  const [to, setTo]         = useState(() => todayStr(dbTimezone));
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => {
    if (!dbTimezone) return;
    const today = todayStr(dbTimezone);
    setFrom(prev => (prev === todayStr(null) || prev === '') ? today : prev);
    setTo(prev   => (prev === todayStr(null) || prev === '') ? today : prev);
  }, [dbTimezone]);

  async function search() {
    if (!from || !to) return;
    setError('');
    setLoading(true);
    try {
      const result = await api.range(from, to);
      setData(result);
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  const disp           = data?.stats?.dispositions;
  const total          = data?.stats?.total ?? 0;
  const hourly         = data?.hourly   ?? [];
  const channelAliases = data?.channelAliases ?? {};
  const queues         = data?.queues   ?? [];

  // Solo mostrar canales definidos en el módulo de Canales (inbound u outbound configurados).
  // passesFilter(direction=null) devuelve todos los canales del CDR incluyendo no configurados;
  // usamos inbound.channels + outbound.channels (ya filtrados) como fuente de verdad.
  const configuredChannelNames = new Set([
    ...(data?.inbound?.channels ?? []).map(c => c.channel),
    ...(data?.outbound?.channels ?? []).map(c => c.channel),
  ]);
  const channels = (data?.channels ?? []).filter(ch => configuredChannelNames.has(ch.channel));

  const answered = disp?.ANSWERED?.count ?? 0;

  const noAnswerBreakdown = disp?.['NO ANSWER']?.breakdown ?? {};
  const lost    = noAnswerBreakdown.ivr_hangup ?? 0;
  const noAnswer = (noAnswerBreakdown.no_answer ?? 0) + (noAnswerBreakdown.queue_no_agent ?? 0);

  const answeredPct = disp?.ANSWERED?.pct ?? 0;
  const lostPct     = total > 0 ? Math.round((lost    / total) * 1000) / 10 : 0;
  const noAnswerPct = total > 0 ? Math.round((noAnswer / total) * 1000) / 10 : 0;

  const businessHours = data?.businessHours ?? null;
  const lostBusiness    = noAnswerBreakdown.ivr_hangup_business ?? 0;
  const lostOffhours    = noAnswerBreakdown.ivr_hangup_offhours ?? 0;
  const lostBusinessPct = total > 0 ? Math.round((lostBusiness / total) * 1000) / 10 : 0;
  const lostOffhoursPct = total > 0 ? Math.round((lostOffhours / total) * 1000) / 10 : 0;

  const inboundTotal  = data?.inbound?.stats?.total  ?? 0;
  const outboundTotal = data?.outbound?.stats?.total ?? 0;
  const inboundPct  = total > 0 ? Math.round((inboundTotal  / total) * 1000) / 10 : 0;
  const outboundPct = total > 0 ? Math.round((outboundTotal / total) * 1000) / 10 : 0;

  function exportCSV() {
    if (!channels.length) return;
    const header = 'Canal,Total,Contestadas,No contestadas,Ocupado,Fallidas,Tiempo (s)\n';
    const rows = channels.map(ch =>
      `${channelAliases[ch.channel] || ch.channel},${ch.total},${ch.ANSWERED},${ch['NO ANSWER']},${ch.BUSY},${ch.FAILED},${ch.total_billsec}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `llamadas_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Histórico de llamadas</h1>
        <p className="text-slate-500 text-sm mt-0.5">Consulta estadísticas por rango de fechas</p>
      </div>

      {/* Filtros */}
      <div className="card">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Fecha desde</label>
            <input
              type="date"
              className="input w-40"
              value={from}
              max={todayStr(dbTimezone)}
              onChange={e => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Fecha hasta</label>
            <input
              type="date"
              className="input w-40"
              value={to}
              max={todayStr(dbTimezone)}
              onChange={e => setTo(e.target.value)}
            />
          </div>
          <button
            onClick={search}
            disabled={loading}
            className="btn-primary flex items-center gap-2"
          >
            {loading
              ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <Search className="w-4 h-4" />
            }
            Buscar
          </button>

          {data && (
            <button onClick={exportCSV} className="btn-ghost flex items-center gap-2 ml-auto">
              <Download className="w-4 h-4" />
              Exportar CSV
            </button>
          )}
        </div>

        {error && (
          <div className="mt-3 text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* Resultados */}
      {data && (
        <div className="space-y-6 animate-fade-in">
          {/* Período */}
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <span>Mostrando resultados del</span>
            <span className="text-slate-200 font-medium">{fmtDate(from)}</span>
            <span>al</span>
            <span className="text-slate-200 font-medium">{fmtDate(to)}</span>
            <span>—</span>
            <span className="text-blue-400 font-semibold">{total.toLocaleString('es-CO')} llamadas en total</span>
          </div>

          {/* Stats */}
          <div className={`grid grid-cols-2 gap-4 ${businessHours ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
            <StatCard label="Total"          value={total}    icon={Phone}       color="blue" />
            <StatCard label="Contestadas"    value={answered} icon={PhoneCall}   color="green"
              sub="del total" pct={answeredPct} />
            <StatCard label="No Contestadas" value={noAnswer} icon={PhoneMissed} color="amber"
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

          {/* Desglose Entrantes / Salientes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatCard label="Llamadas entrantes" value={inboundTotal} icon={PhoneIncoming} color="blue"
              sub="del total" pct={inboundPct}
              hint="Total de llamadas que llegaron desde el exterior en el período seleccionado." />
            <StatCard label="Llamadas salientes" value={outboundTotal} icon={PhoneOutgoing} color="blue"
              sub="del total" pct={outboundPct}
              hint="Total de llamadas realizadas hacia el exterior en el período seleccionado." />
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
              <h2 className="text-sm font-semibold text-slate-200 mb-4">Distribución</h2>
              <DispositionChart dispositions={disp} businessHours={businessHours} />
            </div>
            <div className="card lg:col-span-3">
              <h2 className="text-sm font-semibold text-slate-200 mb-4">Distribución por hora</h2>
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
        </div>
      )}

      {!data && !loading && (
        <div className="card flex items-center justify-center py-16 text-slate-500 text-sm">
          Selecciona un rango de fechas y presiona Buscar
        </div>
      )}
    </div>
  );
}
