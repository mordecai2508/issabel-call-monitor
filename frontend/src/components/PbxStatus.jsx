import { useEffect, useState } from 'react';
import { Wifi, WifiOff, HelpCircle, RefreshCw } from 'lucide-react';
import { api } from '../api';

function formatLastCheck(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('es-CO');
  } catch {
    return '—';
  }
}

/**
 * PBX connection status indicator (feature pbx_health, R14/R15/R18/R19).
 *
 * - On mount, loads the current status via `api.pbxHealth()` (R15).
 * - Updates when a new `pbxStatus` payload is received via SSE (R11/R12,
 *   propagated as a prop from Layout.jsx's `onPbxStatus`).
 * - Offers a manual "sync now" action via `api.pbxSync()` (R18).
 * - Falls back to a neutral/unknown state if the initial request or the
 *   manual sync fails at the network/HTTP level (R19).
 *
 * @param {object|null} pbxStatus - latest `pbx_status` SSE payload, or null
 */
export default function PbxStatus({ pbxStatus }) {
  // status: null = "checking/unknown" (R19), otherwise { connected, lastCheck, lastError, latencyMs }
  const [status, setStatus]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // Initial load (R15)
  useEffect(() => {
    let cancelled = false;
    api.pbxHealth()
      .then(res => { if (!cancelled) setStatus(res.data); })
      .catch(() => { if (!cancelled) setStatus(null); }) // R19 - neutral state on network/HTTP failure
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Real-time updates from SSE 'pbx_status' (R16/R17, via Layout)
  useEffect(() => {
    if (pbxStatus) setStatus(pbxStatus);
  }, [pbxStatus]);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await api.pbxSync();
      setStatus(res.data);
    } catch {
      setStatus(null); // R19 - neutral state on network/HTTP failure
    } finally {
      setSyncing(false);
    }
  }

  let badge;
  if (loading || status === null) {
    badge = {
      Icon: HelpCircle,
      classes: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
      label: loading ? 'Verificando…' : 'Estado desconocido',
    };
  } else if (status.connected) {
    badge = {
      Icon: Wifi,
      classes: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      label: 'PBX conectado',
    };
  } else {
    badge = {
      Icon: WifiOff,
      classes: 'bg-red-500/10 text-red-400 border-red-500/20',
      label: 'PBX desconectado',
    };
  }

  const { Icon, classes, label } = badge;

  return (
    <div
      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs font-medium ${classes}`}
      title={status?.lastError || undefined}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <div className="flex flex-col leading-tight">
        <span>{label}</span>
        {status && (
          <span className="text-[10px] text-slate-500 font-normal">
            {formatLastCheck(status.lastCheck)}
            {typeof status.latencyMs === 'number' ? ` · ${status.latencyMs} ms` : ''}
          </span>
        )}
        {status && !status.connected && status.lastError && (
          <span className="text-[10px] text-red-400/80 font-normal truncate max-w-[12rem]">
            {status.lastError}
          </span>
        )}
      </div>
      <button
        onClick={handleSync}
        disabled={syncing}
        title="Sincronizar ahora"
        className="ml-1 text-current opacity-60 hover:opacity-100 transition-opacity disabled:cursor-not-allowed"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
      </button>
    </div>
  );
}
