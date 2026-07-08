import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Estado de plugins del backend (feature plugin_system, R29).
 * Errores → lista vacía (la navegación de plugins simplemente no aparece).
 */
export function usePlugins() {
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    api.plugins()
      .then(d => setPlugins(d.data || []))
      .catch(() => setPlugins([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { plugins, loading, refresh };
}
