import { ArrowUpDown } from 'lucide-react';
import { useState } from 'react';

function pct(val, total) {
  if (!total) return '—';
  return `${Math.round((val / total) * 100)}%`;
}

function fmtDuration(sec) {
  if (!sec) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function ChannelTable({ channels, channelAliases = {} }) {
  const [sortKey, setSortKey] = useState('total');
  const [sortDir, setSortDir] = useState('desc');

  if (!channels || channels.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-slate-500 text-sm">
        Sin datos de canales
      </div>
    );
  }

  // Pre-compute derived breakdown fields for sorting and display
  const enriched = channels.map(ch => ({
    ...ch,
    ivr_hangup: ch.breakdown?.ivr_hangup ?? 0,
    unanswered: (ch.breakdown?.no_answer ?? 0) + (ch.breakdown?.queue_no_agent ?? 0),
  }));

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const sorted = [...enriched].sort((a, b) => {
    const diff = (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
    return sortDir === 'asc' ? diff : -diff;
  });

  function SortHeader({ col, label }) {
    return (
      <th
        className="text-right text-xs text-slate-500 font-medium uppercase tracking-wider pb-2 cursor-pointer hover:text-slate-300 select-none"
        onClick={() => toggleSort(col)}
      >
        <span className="flex items-center justify-end gap-1">
          {label}
          <ArrowUpDown className="w-3 h-3" />
        </span>
      </th>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-700">
            <th className="text-left text-xs text-slate-500 font-medium uppercase tracking-wider pb-2">Canal</th>
            <SortHeader col="total"        label="Total" />
            <SortHeader col="ANSWERED"     label="Contest." />
            <SortHeader col="ivr_hangup"   label="Perdidas" />
            <SortHeader col="unanswered"   label="No Contest." />
            <SortHeader col="total_billsec" label="Tiempo" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {sorted.map((ch) => (
            <tr key={ch.channel} className="hover:bg-slate-700/30 transition-colors">
              <td className="py-2.5 pr-4">
                <span className="font-mono text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded">
                  {channelAliases[ch.channel] || ch.channel}
                </span>
              </td>
              <td className="py-2.5 text-right font-semibold text-slate-100">{ch.total}</td>
              <td className="py-2.5 text-right">
                <span className="text-emerald-400">{ch.ANSWERED}</span>
                <span className="text-slate-600 text-xs ml-1">({pct(ch.ANSWERED, ch.total)})</span>
              </td>
              <td className="py-2.5 text-right">
                <span className="text-red-400">{ch.ivr_hangup}</span>
                <span className="text-slate-600 text-xs ml-1">({pct(ch.ivr_hangup, ch.total)})</span>
              </td>
              <td className="py-2.5 text-right">
                <span className="text-amber-400">{ch.unanswered}</span>
                <span className="text-slate-600 text-xs ml-1">({pct(ch.unanswered, ch.total)})</span>
              </td>
              <td className="py-2.5 text-right text-slate-400">{fmtDuration(ch.total_billsec)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
