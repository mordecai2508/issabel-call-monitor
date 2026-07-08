import { useState, useEffect } from 'react';
import { FileText, FileSpreadsheet } from 'lucide-react';
import { api } from '../api';
import { useAppConfig } from '../contexts/AppConfigContext';
import { todayStr } from '../utils/date';

// ── Constants ──────────────────────────────────────────────────────────────────

const REPORT_TYPES = [
  { value: 'executive',  label: 'Resumen ejecutivo' },
  { value: 'inbound',    label: 'Llamadas entrantes' },
  { value: 'outbound',   label: 'Llamadas salientes' },
  { value: 'extensions', label: 'Actividad de extensiones' },
  { value: 'trunks',     label: 'Actividad de troncales' },
];

// ── Small UI pieces ────────────────────────────────────────────────────────────

function ErrorBanner({ message }) {
  return (
    <div className="bg-red-900/40 border border-red-700 text-red-300 rounded-lg px-4 py-3 text-sm">
      {message}
    </div>
  );
}

function Spinner() {
  return <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ReportsModule() {
  const { dbTimezone } = useAppConfig();

  const [type, setType]     = useState('executive');
  const [from, setFrom]     = useState(() => todayStr(dbTimezone));
  const [to, setTo]         = useState(() => todayStr(dbTimezone));
  const [loadingFormat, setLoadingFormat] = useState(null); // 'pdf' | 'xlsx' | null
  const [error, setError]   = useState(null);

  useEffect(() => {
    if (!dbTimezone) return;
    const today = todayStr(dbTimezone);
    setFrom(prev => (prev === todayStr(null) || prev === '') ? today : prev);
    setTo(prev   => (prev === todayStr(null) || prev === '') ? today : prev);
  }, [dbTimezone]);

  const canDownload = Boolean(type && from && to) && !loadingFormat;

  async function handleDownload(format) {
    if (!type || !from || !to) return;
    setError(null);
    setLoadingFormat(format);
    try {
      const { blob, filename } = await api.reportDownload({ type, from, to, format });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Error al generar el reporte');
    } finally {
      setLoadingFormat(null);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-100">Reportes</h1>
        <p className="text-sm text-slate-500 mt-1">Genera reportes en PDF o Excel para un rango de fechas</p>
      </div>

      <section className="bg-slate-800/50 rounded-xl p-5 space-y-4">
        {/* Report type selector */}
        <div>
          <label className="block text-xs text-slate-400 mb-2">Tipo de reporte</label>
          <div className="flex flex-wrap gap-2">
            {REPORT_TYPES.map(opt => (
              <button
                key={opt.value}
                onClick={() => setType(opt.value)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  type === opt.value
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Date range */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="block text-xs text-slate-400">Desde</label>
            <input
              type="date"
              value={from}
              onChange={e => setFrom(e.target.value)}
              className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-slate-400">Hasta</label>
            <input
              type="date"
              value={to}
              onChange={e => setTo(e.target.value)}
              className="bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Download buttons */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => handleDownload('pdf')}
            disabled={!canDownload}
            className="flex items-center gap-1.5 px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loadingFormat === 'pdf' ? <Spinner /> : <FileText className="w-4 h-4" />}
            Descargar PDF
          </button>
          <button
            onClick={() => handleDownload('xlsx')}
            disabled={!canDownload}
            className="flex items-center gap-1.5 px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loadingFormat === 'xlsx' ? <Spinner /> : <FileSpreadsheet className="w-4 h-4" />}
            Descargar Excel
          </button>
        </div>

        {error && <ErrorBanner message={error} />}
      </section>
    </div>
  );
}
