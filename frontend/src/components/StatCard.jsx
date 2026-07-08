import { useState, useRef, useEffect } from 'react';

function HintTooltip({ hint }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  // Cerrar al hacer clic fuera (para mantenerlo abierto en móvil tras tap)
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    // pb-[6px] extiende el bounding-box del wrapper hasta el inicio del tooltip,
    // evitando que onMouseLeave se dispare al pasar el cursor del botón al tooltip.
    <div
      ref={wrapperRef}
      className="relative inline-flex pb-[6px]"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        className="w-4 h-4 rounded-full bg-slate-700 text-slate-400 text-[10px] font-bold leading-none flex items-center justify-center hover:bg-slate-600 hover:text-slate-200 transition-colors shrink-0 cursor-help"
        aria-label="Más información"
      >
        ?
      </button>

      {open && (
        <div className="absolute left-0 top-5 z-50 w-56 rounded-lg bg-slate-700 border border-slate-600 shadow-xl p-3 text-xs text-slate-300 leading-relaxed">
          {/* Flecha apuntando hacia el botón */}
          <div className="absolute -top-1.5 left-1.5 w-3 h-3 bg-slate-700 border-l border-t border-slate-600 rotate-45" />
          {hint}
        </div>
      )}
    </div>
  );
}

export function StatCard({ label, value, sub, color, icon: Icon, pct, hint, subItems }) {
  const colors = {
    green:  { bg: 'bg-emerald-500/10', icon: 'text-emerald-400', bar: 'bg-emerald-500', text: 'text-emerald-400' },
    amber:  { bg: 'bg-amber-500/10',   icon: 'text-amber-400',   bar: 'bg-amber-500',   text: 'text-amber-400' },
    red:    { bg: 'bg-red-500/10',     icon: 'text-red-400',     bar: 'bg-red-500',     text: 'text-red-400' },
    slate:  { bg: 'bg-slate-500/10',   icon: 'text-slate-400',   bar: 'bg-slate-500',   text: 'text-slate-400' },
    blue:   { bg: 'bg-blue-500/10',    icon: 'text-blue-400',    bar: 'bg-blue-500',    text: 'text-blue-400' },
  };
  const c = colors[color] || colors.blue;

  return (
    <div className="card animate-fade-in">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
            {hint && <HintTooltip hint={hint} />}
          </div>
          <p className="text-3xl font-bold text-slate-100">{value?.toLocaleString('es-CO') ?? '—'}</p>
        </div>
        <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center`}>
          <Icon className={`w-5 h-5 ${c.icon}`} />
        </div>
      </div>

      {pct !== undefined && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
            <span>{sub}</span>
            <span className={c.text}>{pct}%</span>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-1.5">
            <div
              className={`${c.bar} h-1.5 rounded-full transition-all duration-700`}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
        </div>
      )}

      {subItems && subItems.length > 0 && (
        <div className="mt-2 pt-2 border-t border-slate-700/60 space-y-1">
          {subItems.map((item, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className="text-slate-500">{item.label}</span>
              <span className={item.colorClass || 'text-slate-400'}>
                {item.value?.toLocaleString('es-CO') ?? '0'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
