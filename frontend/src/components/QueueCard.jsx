import { Users } from 'lucide-react';

export default function QueueCard({ queue }) {
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
