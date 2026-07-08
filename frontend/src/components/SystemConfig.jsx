import { useEffect, useState, useCallback } from 'react';
import {
  Settings, Sliders, Palette, Upload, Image as ImageIcon,
  Pencil, Check, X, Eye, EyeOff,
} from 'lucide-react';
import { api } from '../api';

const TIMEZONE_RE = /^[+-]\d{2}:\d{2}$/;
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_LOGO_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg'];

// ── Banner helpers ────────────────────────────────────────────────────────────

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

function ErrorBanner({ message, onDismiss }) {
  return (
    <div className="mb-4 flex items-center justify-between rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2 text-red-400 text-sm">
      <span>{message}</span>
      <button onClick={onDismiss}><X className="w-4 h-4" /></button>
    </div>
  );
}

// ── Field helpers ─────────────────────────────────────────────────────────────

function Field({ label, children, hint }) {
  return (
    <div className="mb-4">
      <label className="block text-xs font-medium text-slate-400 mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function Input({ ...props }) {
  return (
    <input
      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
      {...props}
    />
  );
}

function Select({ children, ...props }) {
  return (
    <select
      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
      {...props}
    >
      {children}
    </select>
  );
}

// ── Business Hours ────────────────────────────────────────────────────────────

const WEEK_DAYS = [
  { label: 'Lu', value: 1 },
  { label: 'Ma', value: 2 },
  { label: 'Mi', value: 3 },
  { label: 'Ju', value: 4 },
  { label: 'Vi', value: 5 },
  { label: 'Sa', value: 6 },
  { label: 'Do', value: 0 },
];

const DEFAULT_BUSINESS_HOURS = { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };

function BusinessHoursSection({ value, onChange }) {
  const enabled = value !== null && value !== undefined;
  const days  = value?.days  ?? DEFAULT_BUSINESS_HOURS.days;
  const start = value?.start ?? DEFAULT_BUSINESS_HOURS.start;
  const end   = value?.end   ?? DEFAULT_BUSINESS_HOURS.end;

  function toggleEnabled(e) {
    onChange(e.target.checked ? { ...DEFAULT_BUSINESS_HOURS } : null);
  }

  function toggleDay(dayValue) {
    const newDays = days.includes(dayValue)
      ? days.filter(d => d !== dayValue)
      : [...days, dayValue];
    onChange({ days: newDays, start, end });
  }

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <input
          type="checkbox"
          id="bh-enabled"
          checked={enabled}
          onChange={toggleEnabled}
          className="w-4 h-4 rounded accent-blue-500"
        />
        <label htmlFor="bh-enabled" className="text-sm font-medium text-slate-200 cursor-pointer">
          Horario de atención
        </label>
      </div>
      {enabled && (
        <div className="ml-6 space-y-4">
          <div>
            <p className="text-xs text-slate-400 mb-2">Días laborales</p>
            <div className="flex gap-2 flex-wrap">
              {WEEK_DAYS.map(d => (
                <button
                  type="button"
                  key={d.value}
                  onClick={() => toggleDay(d.value)}
                  className={`w-8 h-8 rounded-full text-xs font-semibold transition-colors ${
                    days.includes(d.value)
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-end gap-4">
            <div>
              <p className="text-xs text-slate-400 mb-1">Desde</p>
              <input
                type="time"
                value={start}
                onChange={e => onChange({ days, start: e.target.value, end })}
                className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-1">Hasta</p>
              <input
                type="time"
                value={end}
                onChange={e => onChange({ days, start, end: e.target.value })}
                className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <p className="text-xs text-slate-500">
            Las llamadas "Perdidas" del dashboard se dividirán entre "En horario" y "Fuera de horario".
          </p>
        </div>
      )}
    </div>
  );
}

// ── Tab: General ──────────────────────────────────────────────────────────────

function GeneralTab({ config, onSaved, onError }) {
  const [companyName, setCompanyName]         = useState(config.companyName || '');
  const [subcompanyName, setSubcompanyName]   = useState(config.subcompanyName || '');
  const [timezone, setTimezone]               = useState(config.timezone || '');
  const [language, setLanguage]               = useState(config.language || 'es');
  const [businessHours, setBusinessHours]     = useState(config.businessHours ?? null);
  const [saving, setSaving]                   = useState(false);
  const [localError, setLocalError]           = useState('');

  function validate() {
    if (!companyName.trim()) return 'El nombre de la empresa no puede estar vacío';
    if (!TIMEZONE_RE.test(timezone)) return 'La zona horaria debe tener el formato ±HH:MM (ej. -05:00)';
    return '';
  }

  async function handleSave(e) {
    e.preventDefault();
    setLocalError('');
    onError('');
    const validationError = validate();
    if (validationError) {
      setLocalError(validationError);
      return;
    }
    setSaving(true);
    try {
      const res = await api.updateAdminConfig({
        companyName: companyName.trim(),
        subcompanyName,
        timezone,
        language,
        businessHours,
      });
      onSaved(res.data);
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="max-w-md">
      {localError && <ErrorBanner message={localError} onDismiss={() => setLocalError('')} />}
      <Field label="Nombre de la empresa">
        <Input
          value={companyName}
          onChange={e => setCompanyName(e.target.value)}
          placeholder="Mi Empresa"
        />
      </Field>
      <Field label="Nombre de subempresa" hint="Opcional. Se muestra debajo del nombre principal en el sidebar.">
        <Input
          value={subcompanyName}
          onChange={e => setSubcompanyName(e.target.value)}
          placeholder="Ej. Departamento de Ventas"
          maxLength={100}
        />
      </Field>
      <Field label="Zona horaria" hint="Formato ±HH:MM, ej. -05:00">
        <Input
          value={timezone}
          onChange={e => setTimezone(e.target.value)}
          placeholder="-05:00"
        />
      </Field>
      <Field label="Idioma">
        <Select value={language} onChange={e => setLanguage(e.target.value)}>
          <option value="es">Español</option>
          <option value="en">English</option>
        </Select>
      </Field>
      <BusinessHoursSection value={businessHours} onChange={setBusinessHours} />
      <button
        type="submit"
        disabled={saving}
        className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
      >
        {saving ? 'Guardando…' : 'Guardar'}
      </button>
    </form>
  );
}

// ── Tab: Personalización — Logo ──────────────────────────────────────────────

function LogoUploader({ logoUrl, onUploaded, onError }) {
  const [file, setFile]           = useState(null);
  const [validationError, setValidationError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [logoBroken, setLogoBroken] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  function handleFileChange(e) {
    const selected = e.target.files?.[0] || null;
    setValidationError('');
    setFile(null);

    if (!selected) return;

    if (!ALLOWED_LOGO_TYPES.includes(selected.type)) {
      setValidationError('El logo debe ser una imagen PNG o JPEG');
      return;
    }
    if (selected.size > MAX_LOGO_SIZE) {
      setValidationError('El logo no debe superar los 2 MB');
      return;
    }
    setFile(selected);
  }

  async function handleUpload() {
    if (!file) return;
    onError('');
    setUploading(true);
    try {
      const res = await api.uploadLogo(file);
      setFile(null);
      setLogoBroken(false);
      setPreviewKey(k => k + 1);
      onUploaded(res.data);
    } catch (err) {
      onError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mb-8">
      <h3 className="text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2">
        <ImageIcon className="w-4 h-4 text-blue-400" /> Logo
      </h3>
      <div className="flex items-center gap-4 mb-3">
        <div className="w-24 h-24 rounded-lg border border-slate-600 bg-slate-700 flex items-center justify-center overflow-hidden shrink-0">
          {logoUrl && !logoBroken ? (
            <img
              key={previewKey}
              src={`${logoUrl}?v=${previewKey}`}
              alt="Logo actual"
              className="max-w-full max-h-full object-contain"
              onError={() => setLogoBroken(true)}
            />
          ) : (
            <span className="text-xs text-slate-500">Sin logo</span>
          )}
        </div>
        <div className="flex-1">
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={handleFileChange}
            className="block w-full text-xs text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-slate-700 file:text-slate-200 hover:file:bg-slate-600"
          />
          <p className="mt-1 text-xs text-slate-500">PNG o JPG, máximo 2 MB.</p>
          {validationError && (
            <p className="mt-1 text-xs text-red-400">{validationError}</p>
          )}
        </div>
      </div>
      <button
        onClick={handleUpload}
        disabled={!file || uploading}
        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
      >
        <Upload className="w-4 h-4" />
        {uploading ? 'Subiendo…' : 'Subir logo'}
      </button>
    </div>
  );
}

// ── Tab: Personalización — Extensiones ───────────────────────────────────────

function ExtensionsTable({ extensions, onChange }) {
  const [editingExt, setEditingExt] = useState(null);
  const [editValue, setEditValue]   = useState('');
  const [savingExt, setSavingExt]   = useState(null);

  function startEdit(ext) {
    setEditingExt(ext.extension);
    setEditValue(ext.displayName || '');
  }

  function cancelEdit() {
    setEditingExt(null);
    setEditValue('');
  }

  async function saveDisplayName(ext) {
    setSavingExt(ext.extension);
    try {
      await onChange(ext.extension, { displayName: editValue });
      setEditingExt(null);
    } finally {
      setSavingExt(null);
    }
  }

  async function toggleHidden(ext) {
    setSavingExt(ext.extension);
    try {
      await onChange(ext.extension, { hidden: !ext.hidden });
    } finally {
      setSavingExt(null);
    }
  }

  if (extensions.length === 0) {
    return <p className="text-sm text-slate-500">No hay extensiones con actividad reciente.</p>;
  }

  return (
    <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-700">
            <th className="text-left text-xs text-slate-500 uppercase tracking-wider px-4 py-3 font-medium">Extensión</th>
            <th className="text-left text-xs text-slate-500 uppercase tracking-wider px-4 py-3 font-medium">Nombre a mostrar</th>
            <th className="text-left text-xs text-slate-500 uppercase tracking-wider px-4 py-3 font-medium">Visibilidad</th>
            <th className="w-20" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700/60">
          {extensions.map(ext => (
            <tr key={ext.extension} className="hover:bg-slate-700/30 transition-colors">
              <td className="px-4 py-3">
                <span className="font-mono text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded">
                  {ext.extension}
                </span>
              </td>
              <td className="px-4 py-3">
                {editingExt === ext.extension ? (
                  <input
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveDisplayName(ext);
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    placeholder={ext.extension}
                    className="w-full bg-slate-700 border border-slate-500 rounded px-2 py-1 text-slate-100 text-sm focus:outline-none focus:border-blue-500"
                  />
                ) : (
                  <span className={ext.displayName ? 'text-slate-100' : 'text-slate-500 italic'}>
                    {ext.displayName || 'Sin nombre'}
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                <button
                  onClick={() => toggleHidden(ext)}
                  disabled={savingExt === ext.extension}
                  className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full transition-colors disabled:opacity-50 ${
                    ext.hidden
                      ? 'bg-slate-600/50 text-slate-400'
                      : 'bg-emerald-500/20 text-emerald-400'
                  }`}
                >
                  {ext.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  {ext.hidden ? 'Oculta' : 'Visible'}
                </button>
              </td>
              <td className="px-4 py-3">
                {editingExt === ext.extension ? (
                  <div className="flex items-center gap-1 justify-end">
                    <button
                      onClick={() => saveDisplayName(ext)}
                      disabled={savingExt === ext.extension}
                      className="p-1.5 rounded text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50 transition-colors"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="p-1.5 rounded text-slate-400 hover:bg-slate-700 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex justify-end">
                    <button
                      onClick={() => startEdit(ext)}
                      className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tab: Personalización — Troncales ─────────────────────────────────────────

function TrunksTable({ trunks, onToggle }) {
  const [savingTrunk, setSavingTrunk] = useState(null);

  async function toggleHidden(trunk) {
    setSavingTrunk(trunk.trunk);
    try {
      await onToggle(trunk.trunk, !trunk.hidden);
    } finally {
      setSavingTrunk(null);
    }
  }

  if (trunks.length === 0) {
    return <p className="text-sm text-slate-500">No hay troncales con actividad reciente.</p>;
  }

  return (
    <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-700">
            <th className="text-left text-xs text-slate-500 uppercase tracking-wider px-4 py-3 font-medium">Troncal</th>
            <th className="text-left text-xs text-slate-500 uppercase tracking-wider px-4 py-3 font-medium">Visibilidad</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700/60">
          {trunks.map(trunk => (
            <tr key={trunk.trunk} className="hover:bg-slate-700/30 transition-colors">
              <td className="px-4 py-3">
                <span className="font-mono text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded">
                  {trunk.trunk}
                </span>
              </td>
              <td className="px-4 py-3">
                <button
                  onClick={() => toggleHidden(trunk)}
                  disabled={savingTrunk === trunk.trunk}
                  className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full transition-colors disabled:opacity-50 ${
                    trunk.hidden
                      ? 'bg-slate-600/50 text-slate-400'
                      : 'bg-emerald-500/20 text-emerald-400'
                  }`}
                >
                  {trunk.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  {trunk.hidden ? 'Oculta' : 'Visible'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PersonalizationTab({ config, onLogoUploaded, onError }) {
  const [extensions, setExtensions] = useState([]);
  const [trunks, setTrunks]         = useState([]);
  const [loading, setLoading]       = useState(true);

  const loadLists = useCallback(async () => {
    setLoading(true);
    try {
      const [extRes, trunkRes] = await Promise.all([api.adminExtensions(), api.adminTrunks()]);
      setExtensions(extRes.data || []);
      setTrunks(trunkRes.data || []);
    } catch (err) {
      onError(err.message);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => { loadLists(); }, [loadLists]);

  async function handleExtensionChange(ext, fields) {
    onError('');
    try {
      const res = await api.updateExtension(ext, fields);
      setExtensions(prev => prev.map(e => e.extension === ext
        ? { ...e, displayName: res.data.displayName, hidden: res.data.hidden }
        : e
      ));
    } catch (err) {
      onError(err.message);
    }
  }

  async function handleTrunkToggle(trunk, hidden) {
    onError('');
    try {
      const res = await api.updateTrunkVisibility(trunk, hidden);
      setTrunks(prev => prev.map(t => t.trunk === trunk ? { ...t, hidden: res.data.hidden } : t));
    } catch (err) {
      onError(err.message);
    }
  }

  return (
    <div>
      <LogoUploader logoUrl={config.logoUrl} onUploaded={onLogoUploaded} onError={onError} />

      <div className="mb-8">
        <h3 className="text-sm font-semibold text-slate-200 mb-3">Extensiones</h3>
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <ExtensionsTable extensions={extensions} onChange={handleExtensionChange} />
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-200 mb-3">Troncales</h3>
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <TrunksTable trunks={trunks} onToggle={handleTrunkToggle} />
        )}
      </div>
    </div>
  );
}

// ── Tab: Apariencia ───────────────────────────────────────────────────────────

function AppearanceTab({ config, onSaved, onError }) {
  const [primary, setPrimary] = useState(config.themeColors?.primary || '#3b82f6');
  const [accent, setAccent]   = useState(config.themeColors?.accent || '#1e3a5f');
  const [saving, setSaving]   = useState(false);
  const [localError, setLocalError] = useState('');

  function validate() {
    if (!HEX_COLOR_RE.test(primary)) return 'El color primario debe ser un hex válido (#RGB o #RRGGBB)';
    if (!HEX_COLOR_RE.test(accent)) return 'El color de acento debe ser un hex válido (#RGB o #RRGGBB)';
    return '';
  }

  async function handleSave(e) {
    e.preventDefault();
    setLocalError('');
    onError('');
    const validationError = validate();
    if (validationError) {
      setLocalError(validationError);
      return;
    }
    setSaving(true);
    try {
      const res = await api.updateAdminConfig({ themeColors: { primary, accent } });
      onSaved(res.data);
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="max-w-md">
      {localError && <ErrorBanner message={localError} onDismiss={() => setLocalError('')} />}
      <Field label="Color primario">
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={primary}
            onChange={e => setPrimary(e.target.value)}
            className="w-10 h-10 rounded border border-slate-600 bg-slate-700 cursor-pointer"
          />
          <Input value={primary} onChange={e => setPrimary(e.target.value)} placeholder="#3b82f6" />
        </div>
      </Field>
      <Field label="Color de acento">
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={accent}
            onChange={e => setAccent(e.target.value)}
            className="w-10 h-10 rounded border border-slate-600 bg-slate-700 cursor-pointer"
          />
          <Input value={accent} onChange={e => setAccent(e.target.value)} placeholder="#1e3a5f" />
        </div>
      </Field>
      <div className="flex items-center gap-3 mb-4">
        <span className="text-xs text-slate-500">Vista previa:</span>
        <span className="w-8 h-8 rounded-lg border border-slate-600" style={{ backgroundColor: primary }} />
        <span className="w-8 h-8 rounded-lg border border-slate-600" style={{ backgroundColor: accent }} />
      </div>
      <button
        type="submit"
        disabled={saving}
        className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
      >
        {saving ? 'Guardando…' : 'Guardar'}
      </button>
    </form>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

const TABS = [
  { id: 'general', label: 'General', icon: Sliders },
  { id: 'personalizacion', label: 'Personalización', icon: ImageIcon },
  { id: 'apariencia', label: 'Apariencia', icon: Palette },
];

export default function SystemConfig() {
  const [tab, setTab]         = useState('general');
  const [config, setConfig]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    api.adminConfig()
      .then(res => setConfig(res.data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function handleSaved(data) {
    setConfig(data);
    setSuccess('Configuración guardada correctamente.');
  }

  function handleLogoUploaded(data) {
    setConfig(prev => ({ ...prev, logoUrl: data.logoUrl }));
    setSuccess('Logo actualizado correctamente.');
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold text-slate-100 mb-1 flex items-center gap-2">
        <Settings className="w-5 h-5 text-blue-400" /> Configuración
      </h1>
      <p className="text-sm text-slate-400 mb-6">
        Personaliza la información de la empresa, el logo, las extensiones y los colores del tema.
      </p>

      <div className="flex gap-1 mb-6 bg-slate-800 p-1 rounded-lg w-fit">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === id
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {success && <SuccessBanner message={success} onDismiss={() => setSuccess('')} />}
      {error   && <ErrorBanner   message={error}   onDismiss={() => setError('')} />}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : config ? (
        <>
          {tab === 'general' && (
            <GeneralTab config={config} onSaved={handleSaved} onError={setError} />
          )}
          {tab === 'personalizacion' && (
            <PersonalizationTab config={config} onLogoUploaded={handleLogoUploaded} onError={setError} />
          )}
          {tab === 'apariencia' && (
            <AppearanceTab config={config} onSaved={handleSaved} onError={setError} />
          )}
        </>
      ) : null}
    </div>
  );
}
