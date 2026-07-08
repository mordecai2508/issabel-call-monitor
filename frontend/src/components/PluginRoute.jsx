import { Puzzle } from 'lucide-react';
import { usePlugins } from '../hooks/usePlugins';

/**
 * Gate de vista de plugin (feature plugin_system, R28/R31).
 * Renderiza la vista solo si el plugin existe y está habilitado; en caso
 * contrario muestra un aviso inline "Plugin no disponible" (sin alert()).
 * El backend responde 404 igualmente (defensa en profundidad, R10).
 */
export default function PluginRoute({ name, children }) {
  const { plugins, loading } = usePlugins();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const plugin = plugins.find(p => p.name === name);
  if (!plugin || !plugin.enabled) {
    return (
      <div className="p-8">
        <div className="max-w-lg mx-auto mt-16 bg-slate-800 border border-slate-700 rounded-xl p-8 text-center">
          <Puzzle className="w-10 h-10 text-slate-600 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-200 mb-2">Plugin no disponible</h2>
          <p className="text-sm text-slate-400">
            El plugin <span className="font-mono text-slate-300">{name}</span> está deshabilitado,
            en error o no existe. Contacta a un administrador si crees que debería estar activo.
          </p>
        </div>
      </div>
    );
  }

  return children;
}
