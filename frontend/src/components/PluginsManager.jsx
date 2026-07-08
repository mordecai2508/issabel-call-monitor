import { useState } from 'react';
import { Puzzle, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { usePlugins } from '../hooks/usePlugins';
import Toast from './Toast';

const STATUS_BADGES = {
  active:   { label: 'Activo',        cls: 'bg-emerald-500/15 text-emerald-400' },
  disabled: { label: 'Deshabilitado', cls: 'bg-slate-600/30 text-slate-400' },
  error:    { label: 'Error',         cls: 'bg-red-500/15 text-red-400' },
};

function StatusBadge({ status }) {
  const badge = STATUS_BADGES[status] || STATUS_BADGES.disabled;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.cls}`}>
      {status === 'error' && <AlertTriangle className="w-3 h-3" />}
      {badge.label}
    </span>
  );
}

function Toggle({ enabled, disabled, title, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      title={title}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
        disabled ? 'opacity-40 cursor-not-allowed bg-slate-600' : enabled ? 'bg-blue-600' : 'bg-slate-600'
      }`}
    >
      <span
        className="inline-block h-4 w-4 mt-0.5 rounded-full bg-white transition-transform"
        style={{ transform: enabled ? 'translateX(18px)' : 'translateX(2px)' }}
      />
    </button>
  );
}

/**
 * Panel admin de plugins (feature plugin_system, R32).
 * Toggle con actualización optimista + rollback y toast de error en fallo.
 * Plugins en estado 'error' se muestran con badge y toggle bloqueado (R25).
 */
export default function PluginsManager() {
  const { plugins, loading, refresh } = usePlugins();
  const [optimistic, setOptimistic] = useState({}); // name -> enabled override
  const [toast, setToast] = useState(null);

  async function handleToggle(plugin) {
    const next = !(optimistic[plugin.name] ?? plugin.enabled);
    setOptimistic(prev => ({ ...prev, [plugin.name]: next }));
    try {
      await api.updatePlugin(plugin.name, next);
      refresh();
    } catch (err) {
      // Rollback
      setOptimistic(prev => {
        const { [plugin.name]: _discard, ...rest } = prev;
        return rest;
      });
      setToast({ type: 'error', message: err.message || 'Error al actualizar el plugin' });
    }
  }

  return (
    <div className="p-8">
      <div className="flex items-center gap-3 mb-6">
        <Puzzle className="w-6 h-6 text-blue-400" />
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Plugins</h1>
          <p className="text-sm text-slate-400">Habilita o deshabilita los plugins instalados sin reiniciar el servidor.</p>
        </div>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 flex justify-center">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : plugins.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No hay plugins instalados.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-slate-700">
                <th className="px-4 py-3">Nombre</th>
                <th className="px-4 py-3">Título</th>
                <th className="px-4 py-3">Versión</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Habilitado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {plugins.map(p => {
                const enabled = optimistic[p.name] ?? p.enabled;
                const isError = p.status === 'error';
                return (
                  <tr key={p.name} className="text-slate-300">
                    <td className="px-4 py-3 font-mono text-xs">{p.name}</td>
                    <td className="px-4 py-3">{p.title}</td>
                    <td className="px-4 py-3 text-slate-400">{p.version || '—'}</td>
                    <td className="px-4 py-3"><StatusBadge status={p.status} /></td>
                    <td className="px-4 py-3 text-right">
                      <Toggle
                        enabled={enabled}
                        disabled={isError}
                        title={isError ? 'El plugin falló al cargar: requiere corrección y reinicio del servidor' : undefined}
                        onChange={() => handleToggle(p)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </div>
  );
}
