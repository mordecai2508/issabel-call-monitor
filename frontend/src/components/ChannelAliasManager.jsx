import { useEffect, useState } from 'react';
import { Pencil, Check, X } from 'lucide-react';
import { api } from '../api';

export default function ChannelAliasManager() {
  const [channels, setChannels] = useState([]);
  const [editingChannel, setEditingChannel] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.adminChannels()
      .then(d => setChannels(d.channels))
      .catch(e => setError(e.message));
  }, []);

  function startEdit(ch) {
    setEditingChannel(ch.channel);
    setEditValue(ch.alias);
    setError('');
  }

  function cancelEdit() {
    setEditingChannel(null);
    setEditValue('');
  }

  async function saveAlias(channel) {
    setSaving(true);
    setError('');
    try {
      const res = await api.updateChannelAlias(channel, editValue);
      setChannels(prev =>
        prev.map(ch => ch.channel === channel ? { ...ch, alias: res.alias } : ch)
      );
      setEditingChannel(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-semibold text-slate-100 mb-1">Canales</h1>
      <p className="text-sm text-slate-400 mb-6">
        Asigna un nombre personalizado a cada canal para mostrarlo en el dashboard.
      </p>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {channels.length === 0 && !error ? (
        <p className="text-slate-500 text-sm">No hay canales configurados en config.json.</p>
      ) : (
        <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700">
                <th className="text-left text-xs text-slate-500 uppercase tracking-wider px-4 py-3 font-medium">
                  Canal (técnico)
                </th>
                <th className="text-left text-xs text-slate-500 uppercase tracking-wider px-4 py-3 font-medium">
                  Dirección
                </th>
                <th className="text-left text-xs text-slate-500 uppercase tracking-wider px-4 py-3 font-medium">
                  Nombre a mostrar
                </th>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {channels.map(ch => (
                <tr key={`${ch.channel}-${ch.direction}`} className="hover:bg-slate-700/30 transition-colors">
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded">
                      {ch.channel}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      ch.direction === 'inbound'
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'bg-amber-500/20 text-amber-400'
                    }`}>
                      {ch.direction === 'inbound' ? 'Entrante' : 'Saliente'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {editingChannel === ch.channel ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveAlias(ch.channel);
                          if (e.key === 'Escape') cancelEdit();
                        }}
                        placeholder={ch.channel}
                        className="w-full bg-slate-700 border border-slate-500 rounded px-2 py-1 text-slate-100 text-sm focus:outline-none focus:border-blue-500"
                      />
                    ) : (
                      <span className={ch.alias ? 'text-slate-100' : 'text-slate-500 italic'}>
                        {ch.alias || 'Sin alias'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {editingChannel === ch.channel ? (
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => saveAlias(ch.channel)}
                          disabled={saving}
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
                          onClick={() => startEdit(ch)}
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
      )}
    </div>
  );
}
