import { useEffect, useState } from 'react';
import { BellRing, Plus, Pencil, Trash2, Check, X, ToggleLeft, ToggleRight, Info } from 'lucide-react';
import { api } from '../api';

const TYPE_OPTIONS = [
  { value: 'lost_spike', label: 'Pico de llamadas perdidas' },
  { value: 'pbx_disconnect', label: 'PBX desconectado' },
  { value: 'trunk_down', label: 'Troncal fuera de servicio' },
  { value: 'ext_unreachable', label: 'Extensión sin registrar' },
];

const TYPE_LABELS = TYPE_OPTIONS.reduce((acc, { value, label }) => {
  acc[value] = label;
  return acc;
}, {});

const TYPES_WITH_THRESHOLD = ['lost_spike', 'trunk_down'];

const TYPE_NOTES = {
  trunk_down: 'Se basa en la ausencia de actividad CDR para los canales configurados en config.channels, no en el estado real de registro SIP/IAX (no se tiene acceso a AMI).',
  ext_unreachable: 'Esta regla se guarda pero no se evalúa en esta versión: el estado de registro de extensiones SIP/PJSIP no está disponible para este sistema.',
};

// ── Banner helpers ────────────────────────────────────────────────────────────

function ErrorBanner({ message, onDismiss }) {
  return (
    <div className="mb-4 flex items-center justify-between rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2 text-red-400 text-sm">
      <span>{message}</span>
      <button onClick={onDismiss}><X className="w-4 h-4" /></button>
    </div>
  );
}

function SuccessBanner({ message, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="mb-4 flex items-center justify-between rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-4 py-2 text-emerald-400 text-sm">
      <span>{message}</span>
      <button onClick={onDismiss}><X className="w-4 h-4" /></button>
    </div>
  );
}

// ── Form (crear / editar) ───────────────────────────────────────────────────

function RuleForm({ initial, onSubmit, onCancel, lockType }) {
  const [type, setType] = useState(initial?.type || 'lost_spike');
  const [threshold, setThreshold] = useState(initial?.threshold ?? '');
  const [notifyEmail, setNotifyEmail] = useState(initial?.notify_email || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const needsThreshold = TYPES_WITH_THRESHOLD.includes(type);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (needsThreshold && (threshold === '' || Number.isNaN(Number(threshold)) || Number(threshold) < 0)) {
      setError('El umbral es requerido y debe ser un número mayor o igual a 0 para este tipo de regla.');
      return;
    }
    if (notifyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail)) {
      setError('El correo de notificación no tiene un formato válido.');
      return;
    }

    const payload = {};
    if (!lockType) payload.type = type;
    if (needsThreshold) payload.threshold = Number(threshold);
    payload.notify_email = notifyEmail.trim() || null;

    setSaving(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-3 mb-4">
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">Tipo de regla</label>
        <select
          value={type}
          onChange={e => setType(e.target.value)}
          disabled={lockType}
          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-60"
        >
          {TYPE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {needsThreshold && (
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">
            Umbral {type === 'trunk_down' ? '(minutos sin actividad)' : '(llamadas perdidas en 60 min)'}
          </label>
          <input
            type="number"
            min="0"
            step="1"
            value={threshold}
            onChange={e => setThreshold(e.target.value)}
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
          />
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">Correo de notificación (opcional)</label>
        <input
          type="email"
          value={notifyEmail}
          onChange={e => setNotifyEmail(e.target.value)}
          placeholder="alertas@empresa.com"
          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
        />
      </div>

      {TYPE_NOTES[type] && (
        <div className="flex items-start gap-2 text-xs text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{TYPE_NOTES[type]}</span>
        </div>
      )}

      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          <Check className="w-4 h-4" />
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
        >
          <X className="w-4 h-4" />
          Cancelar
        </button>
      </div>
    </form>
  );
}

// ── Pantalla principal ───────────────────────────────────────────────────────

/**
 * Admin-only screen to list/create/edit/delete alert rules
 * (feature alerts_monitoring, R37).
 */
export default function AlertRulesManager() {
  const [rules, setRules]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  function load() {
    setLoading(true);
    return api.adminAlertRules()
      .then(res => setRules(res.data || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(payload) {
    const res = await api.createAlertRule(payload);
    setRules(prev => [...prev, res.data]);
    setCreating(false);
    setSuccess('Regla de alerta creada correctamente.');
  }

  async function handleUpdate(id, payload) {
    const res = await api.updateAlertRule(id, payload);
    setRules(prev => prev.map(r => r.id === id ? res.data : r));
    setEditingId(null);
    setSuccess('Regla de alerta actualizada correctamente.');
  }

  async function handleToggleEnabled(rule) {
    setError('');
    setBusyId(rule.id);
    try {
      const res = await api.updateAlertRule(rule.id, { enabled: !rule.enabled });
      setRules(prev => prev.map(r => r.id === rule.id ? res.data : r));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id) {
    setError('');
    setBusyId(id);
    try {
      await api.deleteAlertRule(id);
      setRules(prev => prev.filter(r => r.id !== id));
      setSuccess('Regla de alerta eliminada.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <BellRing className="w-5 h-5 text-blue-400" />
        <h1 className="text-xl font-semibold text-slate-100">Reglas de alerta</h1>
      </div>
      <p className="text-sm text-slate-400 mb-6">
        Configura las condiciones que generan alertas automáticas y, opcionalmente, notificaciones por correo.
      </p>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      {success && <SuccessBanner message={success} onDismiss={() => setSuccess('')} />}

      {!creating && (
        <button
          onClick={() => { setCreating(true); setEditingId(null); }}
          className="mb-4 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nueva regla
        </button>
      )}

      {creating && (
        <RuleForm
          onSubmit={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : rules.length === 0 ? (
        <p className="text-sm text-slate-500">No hay reglas de alerta configuradas.</p>
      ) : (
        <div className="space-y-3">
          {rules.map(rule => (
            <div key={rule.id}>
              {editingId === rule.id ? (
                <RuleForm
                  initial={rule}
                  lockType
                  onSubmit={payload => handleUpdate(rule.id, payload)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-slate-100">
                        {TYPE_LABELS[rule.type] || rule.type}
                      </span>
                      {TYPES_WITH_THRESHOLD.includes(rule.type) && (
                        <span className="text-xs font-mono bg-slate-700 text-slate-300 px-2 py-0.5 rounded">
                          umbral: {rule.threshold ?? '—'}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      {rule.notify_email ? `Notifica a: ${rule.notify_email}` : 'Sin notificación por correo'}
                    </p>
                    {TYPE_NOTES[rule.type] && (
                      <div className="flex items-start gap-1.5 text-xs text-amber-400/80 mt-2">
                        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{TYPE_NOTES[rule.type]}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleToggleEnabled(rule)}
                      disabled={busyId === rule.id}
                      title={rule.enabled ? 'Deshabilitar' : 'Habilitar'}
                      className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full transition-colors disabled:opacity-50 ${
                        rule.enabled
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-slate-600/50 text-slate-400'
                      }`}
                    >
                      {rule.enabled ? <ToggleRight className="w-3.5 h-3.5" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                      {rule.enabled ? 'Habilitada' : 'Deshabilitada'}
                    </button>
                    <button
                      onClick={() => { setEditingId(rule.id); setCreating(false); }}
                      className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors"
                      title="Editar"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(rule.id)}
                      disabled={busyId === rule.id}
                      className="p-1.5 rounded text-slate-400 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
                      title="Eliminar"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
