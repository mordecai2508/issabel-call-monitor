import { useState, useEffect } from 'react';
import { Plus, Trash2, Save } from 'lucide-react';
import { api } from '../../api';
import Toast from '../../components/Toast';

const inputCls = 'w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

/**
 * Formulario de configuración del plugin minutes-monitor (feature #55,
 * R24–R29). Solo se monta desde la vista cuando el usuario es admin.
 * Reemplazo completo: se envía la config entera validada por el backend.
 */
export default function MinutesMonitorConfig() {
  const [cfg, setCfg]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState(null);
  const [toast, setToast]     = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.minutesMonitorConfig()
      .then((res) => { if (!cancelled) setCfg(res.data); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Error al cargar la configuración'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function setField(field, value) {
    setCfg(prev => ({ ...prev, [field]: value }));
  }

  function setExt(i, field, value) {
    setCfg(prev => {
      const extensiones = prev.extensiones.map((e, idx) => idx === i ? { ...e, [field]: value } : e);
      return { ...prev, extensiones };
    });
  }

  function addExt() {
    setCfg(prev => ({ ...prev, extensiones: [...prev.extensiones, { numero: '', nombre: '', umbral: null }] }));
  }

  function removeExt(i) {
    setCfg(prev => ({ ...prev, extensiones: prev.extensiones.filter((_, idx) => idx !== i) }));
  }

  async function handleSave(e) {
    e.preventDefault();

    // Validación espejo mínima en cliente (el backend valida siempre)
    if (Number(cfg.alertaTempranaP) >= Number(cfg.alertaCriticaP)) {
      setToast({ type: 'error', message: 'La alerta temprana debe ser menor que la alerta crítica' });
      return;
    }

    const payload = {
      umbralMinutos:         Number(cfg.umbralMinutos),
      alertaTempranaP:       Number(cfg.alertaTempranaP),
      alertaCriticaP:        Number(cfg.alertaCriticaP),
      costoMinutoExtra:      Number(cfg.costoMinutoExtra),
      moneda:                cfg.moneda,
      extensiones:           cfg.extensiones.map(ext => ({
        numero: String(ext.numero).trim(),
        nombre: ext.nombre || '',
        umbral: ext.umbral === null || ext.umbral === '' ? null : Number(ext.umbral),
      })),
      umbralSoloExtensiones: Boolean(cfg.umbralSoloExtensiones),
      intervaloMinutos:      Number(cfg.intervaloMinutos),
    };

    setSaving(true);
    try {
      const res = await api.updateMinutesMonitorConfig(payload);
      setCfg(res.data);
      setToast({ type: 'success', message: 'Configuración guardada. El estado se recalcula automáticamente.' });
    } catch (err) {
      setToast({ type: 'error', message: err.message || 'Error al guardar la configuración' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 flex justify-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !cfg) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-lg px-4 py-3" role="alert">
        {error || 'No se pudo cargar la configuración'}
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="bg-slate-800 border border-slate-700 rounded-xl p-6 space-y-5">
      <h2 className="text-sm font-semibold text-slate-200">Configuración del monitor de minutos</h2>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <label className={labelCls} htmlFor="mm-umbral">Umbral global (minutos)</label>
          <input id="mm-umbral" type="number" min="1" required className={inputCls}
            value={cfg.umbralMinutos}
            onChange={e => setField('umbralMinutos', e.target.value)} />
        </div>
        <div>
          <label className={labelCls} htmlFor="mm-temprana">Alerta temprana (%)</label>
          <input id="mm-temprana" type="number" min="0" max="100" required className={inputCls}
            value={cfg.alertaTempranaP}
            onChange={e => setField('alertaTempranaP', e.target.value)} />
        </div>
        <div>
          <label className={labelCls} htmlFor="mm-critica">Alerta crítica (%)</label>
          <input id="mm-critica" type="number" min="0" max="100" required className={inputCls}
            value={cfg.alertaCriticaP}
            onChange={e => setField('alertaCriticaP', e.target.value)} />
        </div>
        <div>
          <label className={labelCls} htmlFor="mm-costo">Costo por minuto extra</label>
          <input id="mm-costo" type="number" min="0" step="any" required className={inputCls}
            value={cfg.costoMinutoExtra}
            onChange={e => setField('costoMinutoExtra', e.target.value)} />
        </div>
        <div>
          <label className={labelCls} htmlFor="mm-moneda">Moneda</label>
          <input id="mm-moneda" type="text" maxLength={8} required className={inputCls}
            value={cfg.moneda}
            onChange={e => setField('moneda', e.target.value)} />
        </div>
        <div>
          <label className={labelCls} htmlFor="mm-intervalo">Intervalo de medición (minutos)</label>
          <input id="mm-intervalo" type="number" min="1" step="1" required className={inputCls}
            value={cfg.intervaloMinutos}
            onChange={e => setField('intervaloMinutos', e.target.value)} />
          <p className="text-[11px] text-slate-500 mt-1">
            El nuevo intervalo aplica al reiniciar el servidor o al deshabilitar y habilitar el plugin.
          </p>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          className="accent-blue-500"
          checked={Boolean(cfg.umbralSoloExtensiones)}
          onChange={e => setField('umbralSoloExtensiones', e.target.checked)}
        />
        Comparar el umbral solo contra las extensiones monitoreadas
      </label>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-slate-400 uppercase tracking-wider">Extensiones monitoreadas</span>
          <button
            type="button"
            onClick={addExt}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Añadir extensión
          </button>
        </div>
        {cfg.extensiones.length === 0 ? (
          <p className="text-sm text-slate-500">Sin extensiones monitoreadas.</p>
        ) : (
          <div className="space-y-2">
            {cfg.extensiones.map((ext, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text" placeholder="Número" required pattern="[0-9]{1,20}"
                  aria-label={`Número extensión ${i + 1}`}
                  className={`${inputCls} max-w-[10rem]`}
                  value={ext.numero}
                  onChange={e => setExt(i, 'numero', e.target.value)}
                />
                <input
                  type="text" placeholder="Nombre" maxLength={60}
                  aria-label={`Nombre extensión ${i + 1}`}
                  className={inputCls}
                  value={ext.nombre || ''}
                  onChange={e => setExt(i, 'nombre', e.target.value)}
                />
                <input
                  type="number" placeholder="Umbral propio (opcional)" min="1"
                  aria-label={`Umbral extensión ${i + 1}`}
                  className={`${inputCls} max-w-[14rem]`}
                  value={ext.umbral ?? ''}
                  onChange={e => setExt(i, 'umbral', e.target.value === '' ? null : e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => removeExt(i)}
                  aria-label={`Eliminar extensión ${i + 1}`}
                  className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Guardando…' : 'Guardar configuración'}
        </button>
      </div>

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </form>
  );
}
