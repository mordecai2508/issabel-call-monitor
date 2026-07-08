import { useState } from 'react';
import { useAppConfig } from '../contexts/AppConfigContext';
import { todayStr } from '../utils/date';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { api } from '../api';

// ── Date helpers ──────────────────────────────────────────────────────────────

function getDateRangeForPeriod(period, tz) {
  const p = n => String(n).padStart(2, '0');

  // Calcula la fecha actual en el timezone del servidor
  const match = typeof tz === 'string' ? tz.match(/^([+-])(\d{2}):(\d{2})$/) : null;
  const offsetMin = match
    ? (match[1] === '+' ? 1 : -1) * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10))
    : 0;
  const nowInTz = new Date(Date.now() + offsetMin * 60_000);
  const y = nowInTz.getUTCFullYear();
  const m = nowInTz.getUTCMonth();
  const d = nowInTz.getUTCDate();
  const dow = nowInTz.getUTCDay(); // 0=Sun

  const fmt = (yr, mo, dy) => `${yr}-${p(mo + 1)}-${p(dy)}`;
  const today = fmt(y, m, d);

  if (period === 'day') return { from: today, to: today };

  if (period === 'week') {
    const diff   = dow === 0 ? -6 : 1 - dow; // shift to Monday
    const monday = new Date(Date.UTC(y, m, d + diff));
    const sunday = new Date(Date.UTC(y, m, d + diff + 6));
    return {
      from: fmt(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()),
      to:   fmt(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate()),
    };
  }
  if (period === 'month') {
    const first = new Date(Date.UTC(y, m, 1));
    const last  = new Date(Date.UTC(y, m + 1, 0));
    return {
      from: fmt(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()),
      to:   fmt(last.getUTCFullYear(),  last.getUTCMonth(),  last.getUTCDate()),
    };
  }
  if (period === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };

  return { from: '', to: '' };
}

// ── Small UI pieces ────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function ErrorBanner({ message }) {
  return (
    <div className="bg-red-900/40 border border-red-700 text-red-300 rounded-lg px-4 py-3 text-sm">
      {message}
    </div>
  );
}

// ── PeriodSelector ─────────────────────────────────────────────────────────────

const PERIOD_OPTIONS = [
  { value: 'day',    label: 'Día' },
  { value: 'week',   label: 'Semana' },
  { value: 'month',  label: 'Mes' },
  { value: 'year',   label: 'Año' },
  { value: 'custom', label: 'Personalizado' },
];

function PeriodSelector({ period, from, to, onPeriodChange, onFromChange, onToChange, onQuery, loading }) {
  return (
    <div className="bg-slate-800 rounded-xl p-4 flex flex-wrap items-end gap-3">
      <div className="flex gap-1 flex-wrap">
        {PERIOD_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => onPeriodChange(opt.value)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              period === opt.value
                ? 'bg-blue-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {period === 'custom' ? (
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400">Desde</label>
          <input
            type="date"
            value={from}
            onChange={e => onFromChange(e.target.value)}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
          />
          <label className="text-xs text-slate-400">Hasta</label>
          <input
            type="date"
            value={to}
            onChange={e => onToChange(e.target.value)}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
          />
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <span>{from}</span>
          <span>→</span>
          <span>{to}</span>
        </div>
      )}

      <button
        onClick={onQuery}
        disabled={loading || !from || !to}
        className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
      >
        Consultar
      </button>
    </div>
  );
}

// ── Sección Tendencia ─────────────────────────────────────────────────────────

function TrendSection() {
  const { dbTimezone } = useAppConfig();
  const [period, setPeriod] = useState('month');
  const [from,   setFrom]   = useState(() => getDateRangeForPeriod('month', dbTimezone).from);
  const [to,     setTo]     = useState(() => getDateRangeForPeriod('month', dbTimezone).to);
  const [data,   setData]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,  setError]  = useState(null);

  function handlePeriodChange(p) {
    setPeriod(p);
    if (p !== 'custom') {
      const range = getDateRangeForPeriod(p, dbTimezone);
      setFrom(range.from);
      setTo(range.to);
    }
  }

  async function handleQuery() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.statsHistorical({ period, from, to });
      setData(result.data);
    } catch (err) {
      setError(err.message || 'Error al obtener datos');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="bg-slate-800/50 rounded-xl p-5 space-y-4">
      <h2 className="text-base font-semibold text-slate-100">Tendencia de llamadas</h2>

      <PeriodSelector
        period={period}
        from={from}
        to={to}
        onPeriodChange={handlePeriodChange}
        onFromChange={setFrom}
        onToChange={setTo}
        onQuery={handleQuery}
        loading={loading}
      />

      {loading && <Spinner />}
      {error   && <ErrorBanner message={error} />}

      {!loading && !error && data && (
        data.points.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
            Sin datos para el rango seleccionado
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.points} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="period_label"
                tick={{ fill: '#64748b', fontSize: 11 }}
                tickLine={false}
              />
              <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }}
                cursor={{ fill: '#334155' }}
              />
              <Legend formatter={v => <span style={{ color: '#94a3b8', fontSize: 12 }}>{v}</span>} />
              <Bar dataKey="total"    name="Total"       fill="#3b82f6" radius={[3,3,0,0]} />
              <Bar dataKey="answered" name="Contestadas" fill="#22c55e" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        )
      )}
    </section>
  );
}

// ── Sección Comparativa ───────────────────────────────────────────────────────

// #37: 'busy' eliminado de KPI_LABELS porque BUSY se reclasifica a NO ANSWER en el backend
const KPI_LABELS = [
  { key: 'total',        label: 'Total de llamadas' },
  { key: 'answered',     label: 'Llamadas Contestadas' },
  { key: 'no_answer',    label: 'Llamadas No contestadas' },
  { key: 'failed',       label: 'Fallidas' },
  { key: 'avg_duration', label: 'Duración media (min)' },
];

function formatValue(key, val) {
  if (key === 'avg_duration') return `${val} min`;
  return val;
}

function VariationCell({ value }) {
  if (value === null || value === undefined) {
    return <span className="text-slate-500">—</span>;
  }
  const cls = value >= 0 ? 'text-green-400' : 'text-red-400';
  const sign = value >= 0 ? '+' : '';
  return <span className={cls}>{sign}{value}%</span>;
}

function CompareSection() {
  const [p1from, setP1from] = useState('');
  const [p1to,   setP1to]   = useState('');
  const [p2from, setP2from] = useState('');
  const [p2to,   setP2to]   = useState('');
  const [data,   setData]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,  setError]  = useState(null);

  async function handleCompare() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.statsCompare({
        period1_from: p1from, period1_to: p1to,
        period2_from: p2from, period2_to: p2to,
      });
      setData(result.data);
    } catch (err) {
      setError(err.message || 'Error al obtener datos');
    } finally {
      setLoading(false);
    }
  }

  const inputCls = 'bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-blue-500';

  return (
    <section className="bg-slate-800/50 rounded-xl p-5 space-y-4">
      <h2 className="text-base font-semibold text-slate-100">Comparativa de períodos</h2>

      <div className="flex flex-wrap items-end gap-6">
        <div className="space-y-1">
          <p className="text-xs text-slate-400 font-medium">Período 1</p>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400">Desde</label>
            <input type="date" value={p1from} onChange={e => setP1from(e.target.value)} className={inputCls} />
            <label className="text-xs text-slate-400">Hasta</label>
            <input type="date" value={p1to}   onChange={e => setP1to(e.target.value)}   className={inputCls} />
          </div>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-400 font-medium">Período 2</p>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400">Desde</label>
            <input type="date" value={p2from} onChange={e => setP2from(e.target.value)} className={inputCls} />
            <label className="text-xs text-slate-400">Hasta</label>
            <input type="date" value={p2to}   onChange={e => setP2to(e.target.value)}   className={inputCls} />
          </div>
        </div>
        <button
          onClick={handleCompare}
          disabled={loading || !p1from || !p1to || !p2from || !p2to}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Comparar
        </button>
      </div>

      {loading && <Spinner />}
      {error   && <ErrorBanner message={error} />}

      {!loading && !error && data && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700">
                <th className="text-left py-2 px-3 text-slate-400 font-medium">KPI</th>
                <th className="text-right py-2 px-3 text-slate-400 font-medium">
                  P1 ({data.period1.from} → {data.period1.to})
                </th>
                <th className="text-right py-2 px-3 text-slate-400 font-medium">
                  P2 ({data.period2.from} → {data.period2.to})
                </th>
                <th className="text-right py-2 px-3 text-slate-400 font-medium">Variación</th>
              </tr>
            </thead>
            <tbody>
              {KPI_LABELS.map(({ key, label }) => (
                <tr key={key} className="border-b border-slate-800 hover:bg-slate-700/30">
                  <td className="py-2 px-3 text-slate-300">{label}</td>
                  <td className="py-2 px-3 text-right text-slate-200">{formatValue(key, data.period1[key])}</td>
                  <td className="py-2 px-3 text-right text-slate-200">{formatValue(key, data.period2[key])}</td>
                  <td className="py-2 px-3 text-right">
                    <VariationCell value={data.variation[key]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Sección Rankings ──────────────────────────────────────────────────────────

function RankingCard({ type }) {
  const { dbTimezone } = useAppConfig();
  const [period,  setPeriod]  = useState('month');
  const [from,    setFrom]    = useState(() => getDateRangeForPeriod('month', dbTimezone).from);
  const [to,      setTo]      = useState(() => getDateRangeForPeriod('month', dbTimezone).to);
  const [limit,   setLimit]   = useState(10);
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  function handlePeriodChange(p) {
    setPeriod(p);
    if (p !== 'custom') {
      const range = getDateRangeForPeriod(p, dbTimezone);
      setFrom(range.from);
      setTo(range.to);
    }
  }

  async function handleQuery() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.statsRankings({ from, to, type, limit });
      setData(result.data);
    } catch (err) {
      setError(err.message || 'Error al obtener datos');
    } finally {
      setLoading(false);
    }
  }

  const title = type === 'trunk' ? 'Ranking de troncales' : 'Ranking de agentes';
  const isTrunk = type === 'trunk';

  return (
    <section className="bg-slate-800/50 rounded-xl p-5 space-y-4">
      <h2 className="text-base font-semibold text-slate-100">{title}</h2>

      <PeriodSelector
        period={period}
        from={from}
        to={to}
        onPeriodChange={handlePeriodChange}
        onFromChange={setFrom}
        onToChange={setTo}
        onQuery={handleQuery}
        loading={loading}
      />

      <div className="flex items-center gap-2">
        <label className="text-xs text-slate-400">Top</label>
        <input
          type="number"
          min="1"
          max="50"
          value={limit}
          onChange={e => setLimit(Number(e.target.value))}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 w-16 focus:outline-none focus:border-blue-500"
        />
      </div>

      {loading && <Spinner />}
      {error   && <ErrorBanner message={error} />}

      {!loading && !error && data && (
        data.rankings.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-slate-500 text-sm">
            Sin datos para el rango seleccionado
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left  py-2 px-3 text-slate-400 font-medium">#</th>
                  <th className="text-left  py-2 px-3 text-slate-400 font-medium">Nombre</th>
                  {isTrunk && <th className="text-right py-2 px-3 text-slate-400 font-medium">Total</th>}
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">
                    {isTrunk ? 'Contestadas' : 'Llamadas contestadas'}
                  </th>
                  {isTrunk && <th className="text-right py-2 px-3 text-slate-400 font-medium">No cont.</th>}
                  <th className="text-right py-2 px-3 text-slate-400 font-medium">Dur. media (min)</th>
                </tr>
              </thead>
              <tbody>
                {data.rankings.map((row, idx) => (
                  <tr key={idx} className="border-b border-slate-800 hover:bg-slate-700/30">
                    <td className="py-2 px-3 text-slate-500">{idx + 1}</td>
                    <td className="py-2 px-3 text-slate-200 font-mono text-xs">{row.name}</td>
                    {isTrunk && <td className="py-2 px-3 text-right text-slate-200">{row.total}</td>}
                    <td className="py-2 px-3 text-right text-slate-200">{row.answered}</td>
                    {isTrunk && <td className="py-2 px-3 text-right text-amber-400">{row.no_answer}</td>}
                    <td className="py-2 px-3 text-right text-slate-300">
                      {isTrunk
                        ? `${(row.avg_duration / 60).toFixed(1)} min`
                        : `${row.avg_duration} min`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </section>
  );
}

function RankingsSection() {
  return (
    <>
      <RankingCard type="trunk" />
      <RankingCard type="extension" />
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function HistoricalAnalytics() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-100">Analytics histórico</h1>
        <p className="text-sm text-slate-500 mt-1">Análisis de tendencias, comparativas y rankings de llamadas</p>
      </div>

      <TrendSection />
      <CompareSection />
      <RankingsSection />
    </div>
  );
}
