import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { extractAgentName, formatBillsec, dispositionLabel } from '../utils/callFormatters';
import { useAppConfig } from '../contexts/AppConfigContext';
import { todayStr } from '../utils/date';

// #37: la opción 'BUSY' se elimina porque BUSY se reclasifica a NO ANSWER en el backend
const DISPOSITION_OPTIONS = [
  { value: '',          label: 'Todas' },
  { value: 'ANSWERED',  label: 'Contestada' },
  { value: 'NO ANSWER', label: 'No contestada' },
  { value: 'FAILED',    label: 'Fallida' },
];

const COLUMNS = [
  { key: 'calldate',    label: 'Fecha/Hora'    },
  { key: 'src',         label: 'Origen'        },
  { key: 'dstchannel',  label: 'Troncal'       },
  { key: 'dst',         label: 'Destino'       },
  { key: 'channel',     label: 'Canal Destino' },
  { key: 'billsec',     label: 'Duración (mm:ss)', align: 'center' },
  { key: 'disposition', label: 'Estado'        },
];

function dispositionBadge(disposition) {
  switch ((disposition || '').toUpperCase()) {
    case 'ANSWERED':  return 'text-emerald-400';
    case 'NO ANSWER': return 'text-amber-400';
    case 'BUSY':
    case 'FAILED':    return 'text-red-400';
    default:          return 'text-slate-400';
  }
}

function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <span className="ml-1 text-slate-600">⇕</span>;
  return <span className="ml-1 text-blue-400">{sortDir === 'asc' ? '↑' : '↓'}</span>;
}

export default function OutboundTable() {
  const { dbTimezone } = useAppConfig();
  const today = todayStr(dbTimezone);

  const [filters, setFilters] = useState({
    from: today,
    to:   today,
    trunk: '',
    extension: '',
    dest: '',
    disposition: '',
  });
  const [appliedFilters, setAppliedFilters] = useState(null);

  const [page, setPage]       = useState(1);
  const [sortCol, setSortCol] = useState('calldate');
  const [sortDir, setSortDir] = useState('desc');
  const [rows, setRows]       = useState([]);
  const [meta, setMeta]       = useState({ total: 0, page: 1, limit: 100, totalPages: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [trunks, setTrunks]   = useState([]);

  // Load available trunks on mount (admin endpoint; ignore 403 gracefully)
  useEffect(() => {
    api.adminChannels()
      .then(d => setTrunks(d.channels || []))
      .catch(() => setTrunks([]));
  }, []);

  const fetchData = useCallback(async (activeFilters, currentPage) => {
    if (!activeFilters) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        from:  activeFilters.from,
        to:    activeFilters.to,
        page:  String(currentPage),
        limit: '100',
      });
      if (activeFilters.trunk)       params.set('trunk',       activeFilters.trunk);
      if (activeFilters.extension)   params.set('extension',   activeFilters.extension);
      if (activeFilters.dest)        params.set('dest',        activeFilters.dest);
      if (activeFilters.disposition) params.set('disposition', activeFilters.disposition);

      const data = await api.outboundCalls(params.toString());
      setRows(data.data || []);
      setMeta(data.meta || { total: 0, page: 1, limit: 100, totalPages: 0 });
    } catch (err) {
      setError(err.message || 'Error al cargar los datos');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(appliedFilters, page);
  }, [appliedFilters, page, fetchData]);

  function handleSearch() {
    setPage(1);
    setAppliedFilters({ ...filters });
  }

  function handleClear() {
    const cleared = { from: today, to: today, trunk: '', extension: '', dest: '', disposition: '' };
    setFilters(cleared);
    setPage(1);
    setAppliedFilters(null);
    setRows([]);
    setMeta({ total: 0, page: 1, limit: 100, totalPages: 0 });
    setError(null);
  }

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  function buildExportUrl(format) {
    if (!appliedFilters) return '#';
    const params = new URLSearchParams({
      from:   appliedFilters.from,
      to:     appliedFilters.to,
      format,
    });
    if (appliedFilters.trunk)       params.set('trunk',       appliedFilters.trunk);
    if (appliedFilters.extension)   params.set('extension',   appliedFilters.extension);
    if (appliedFilters.dest)        params.set('dest',        appliedFilters.dest);
    if (appliedFilters.disposition) params.set('disposition', appliedFilters.disposition);
    return `/api/calls/outbound/export?${params.toString()}`;
  }

  function triggerDownload(format) {
    const url = buildExportUrl(format);
    if (url === '#') return;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Sort rows client-side on the current page
  const sortedRows = [...rows].sort((a, b) => {
    const av = a[sortCol];
    const bv = b[sortCol];
    let cmp = 0;
    if (av < bv) cmp = -1;
    else if (av > bv) cmp = 1;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-slate-100 mb-6">Búsqueda de llamadas salientes</h1>

      {/* ── Filter panel ── */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* From */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Desde</label>
            <input
              type="date"
              value={filters.from}
              onChange={e => setFilters(f => ({ ...f, from: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>
          {/* To */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Hasta</label>
            <input
              type="date"
              value={filters.to}
              onChange={e => setFilters(f => ({ ...f, to: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>
          {/* Trunk */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Troncal</label>
            <select
              value={filters.trunk}
              onChange={e => setFilters(f => ({ ...f, trunk: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
            >
              <option value="">Todas</option>
              {trunks.map(t => (
                <option key={t.channel} value={t.channel}>
                  {t.alias || t.channel}
                </option>
              ))}
            </select>
          </div>
          {/* Extension */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Extensión origen</label>
            <input
              type="text"
              placeholder="Búsqueda parcial"
              value={filters.extension}
              onChange={e => setFilters(f => ({ ...f, extension: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          {/* Dest */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Número destino</label>
            <input
              type="text"
              placeholder="Búsqueda parcial"
              value={filters.dest}
              onChange={e => setFilters(f => ({ ...f, dest: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          {/* Disposition */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Estado</label>
            <select
              value={filters.disposition}
              onChange={e => setFilters(f => ({ ...f, disposition: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
            >
              {DISPOSITION_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={handleSearch}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loading ? 'Buscando…' : 'Buscar'}
          </button>
          <button
            onClick={handleClear}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium rounded-lg transition-colors"
          >
            Limpiar
          </button>
        </div>
      </div>

      {/* ── Export buttons ── */}
      {meta.total > 0 && (
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={() => triggerDownload('xlsx')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white text-sm rounded-lg transition-colors"
          >
            Exportar Excel
          </button>
          <button
            onClick={() => triggerDownload('pdf')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-sm rounded-lg transition-colors"
          >
            Exportar PDF
          </button>
          <span className="text-xs text-slate-500">hasta 10,000 filas</span>
        </div>
      )}

      {/* ── Error banner ── */}
      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 text-sm text-red-300 mb-4">
          {error}
        </div>
      )}

      {/* ── Spinner ── */}
      {loading && (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* ── Table ── */}
      {!loading && appliedFilters && (
        <>
          {sortedRows.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-sm">
              No se encontraron registros para los filtros seleccionados.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-700">
              <table className="w-full text-sm text-slate-300">
                <thead>
                  <tr className="bg-slate-800 border-b border-slate-700">
                    {COLUMNS.map(col => (
                      <th
                        key={col.key}
                        onClick={() => handleSort(col.key)}
                        className={`px-4 py-3 ${col.align === 'center' ? 'text-center' : 'text-left'} text-xs font-medium text-slate-400 uppercase tracking-wider cursor-pointer select-none hover:text-slate-200 whitespace-nowrap`}
                      >
                        {col.label}
                        <SortIcon col={col.key} sortCol={sortCol} sortDir={sortDir} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const aliasMap = Object.fromEntries(trunks.filter(t => t.alias).map(t => [t.channel, t.alias]));
                    return sortedRows.map((row, idx) => (
                    <tr
                      key={idx}
                      className="border-b border-slate-800 hover:bg-slate-800/60 transition-colors"
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap text-slate-300">{row.calldate}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{row.src}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-slate-400">{aliasMap[row.dstchannel] || row.dstchannel}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{row.dst}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{extractAgentName(row.channel)}</td>
                      <td className="px-4 py-2.5 text-center">{formatBillsec(row.billsec)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span className={`font-medium ${dispositionBadge(row.disposition)}`}>
                          {dispositionLabel(row.disposition)}
                        </span>
                      </td>
                    </tr>
                  ))
                  })()}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Pagination ── */}
          {meta.totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <button
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-sm text-slate-300 rounded-lg transition-colors"
              >
                Anterior
              </button>
              <span className="text-xs text-slate-400">
                Página {meta.page} de {meta.totalPages} ({meta.total} registros)
              </span>
              <button
                disabled={page >= meta.totalPages}
                onClick={() => setPage(p => p + 1)}
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-sm text-slate-300 rounded-lg transition-colors"
              >
                Siguiente
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
