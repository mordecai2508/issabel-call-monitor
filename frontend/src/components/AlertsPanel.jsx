import { useEffect, useState } from 'react';
import { Bell, AlertTriangle, CheckCircle2, X, RadioTower, PhoneMissed, WifiOff, PhoneOff } from 'lucide-react';
import { api } from '../api';
import { useSSE } from '../hooks/useSSE';

const TYPE_LABELS = {
  trunk_down: 'Troncal fuera de servicio',
  ext_unreachable: 'Extensión sin registrar',
  lost_spike: 'Pico de llamadas perdidas',
  pbx_disconnect: 'PBX desconectado',
};

const TYPE_ICONS = {
  trunk_down: RadioTower,
  ext_unreachable: PhoneOff,
  lost_spike: PhoneMissed,
  pbx_disconnect: WifiOff,
};

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

/**
 * "Alertas Activas" panel (feature alerts_monitoring, R34-R36).
 *
 * - Carga inicial vía `api.activeAlerts()` (R34).
 * - Botón "Resolver" vía `api.resolveAlert(id)` (R35), elimina la alerta de
 *   la lista local en éxito sin recargar la página.
 * - Suscripción a evento SSE `alert` (R36): antepone alertas nuevas a la
 *   lista, evitando duplicados por id.
 */
export default function AlertsPanel() {
  const [alerts, setAlerts]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [resolvingId, setResolvingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.activeAlerts()
      .then(res => { if (!cancelled) setAlerts(res.data || []); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // R36 — alertas en tiempo real vía SSE
  useSSE('/api/events', {
    onAlert: (data) => {
      if (data.resolved) return;
      setAlerts(prev => prev.some(a => a.id === data.id) ? prev : [data, ...prev]);
    },
  });

  async function handleResolve(id) {
    setError('');
    setResolvingId(id);
    try {
      await api.resolveAlert(id);
      setAlerts(prev => prev.filter(a => a.id !== id));
    } catch (e) {
      setError(e.message);
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <Bell className="w-5 h-5 text-blue-400" />
        <h1 className="text-xl font-semibold text-slate-100">Alertas Activas</h1>
      </div>
      <p className="text-sm text-slate-400 mb-6">
        Alertas generadas automáticamente por las reglas de monitoreo configuradas.
      </p>

      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2 text-red-400 text-sm">
          <span>{error}</span>
          <button onClick={() => setError('')}><X className="w-4 h-4" /></button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-500">
          <CheckCircle2 className="w-10 h-10 mb-3 text-emerald-500/60" />
          <p className="text-sm">Sin alertas activas</p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map(alert => {
            const Icon = TYPE_ICONS[alert.type] || AlertTriangle;
            return (
              <div
                key={alert.id}
                className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 flex items-start gap-3"
              >
                <div className="mt-0.5 shrink-0 w-8 h-8 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center">
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-100">
                    {TYPE_LABELS[alert.type] || alert.type}
                  </div>
                  <p className="text-sm text-slate-400 mt-0.5">{alert.description}</p>
                  <p className="text-xs text-slate-500 mt-1">{formatDate(alert.created_at)}</p>
                </div>
                <button
                  onClick={() => handleResolve(alert.id)}
                  disabled={resolvingId === alert.id}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-700 text-slate-200 hover:bg-emerald-600 hover:text-white disabled:opacity-50 transition-colors"
                >
                  {resolvingId === alert.id ? 'Resolviendo…' : 'Resolver'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
