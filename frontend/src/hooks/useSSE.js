import { useState, useEffect, useRef } from 'react';

export function useSSE(url, { onInit, onUpdate, onPbxStatus, onAlert, onConfigUpdated, onPluginsChanged, events = {} } = {}) {
  const [connected, setConnected]   = useState(false);
  const [lastEvent, setLastEvent]   = useState(null);
  const esRef = useRef(null);
  // Handlers de eventos arbitrarios (plugins) leídos desde un ref para no
  // reconectar el EventSource en cada re-render (feature #55, R32).
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    let retryTimer = null;

    function connect() {
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      es.addEventListener('init', (e) => {
        const data = JSON.parse(e.data);
        setLastEvent(data);
        setConnected(true);
        onInit?.(data);
      });

      es.addEventListener('update', (e) => {
        const data = JSON.parse(e.data);
        setLastEvent(data);
        onUpdate?.(data);
      });

      es.addEventListener('pbx_status', (e) => {
        const data = JSON.parse(e.data);
        onPbxStatus?.(data);
      });

      es.addEventListener('alert', (e) => {
        const data = JSON.parse(e.data);
        onAlert?.(data);
      });

      es.addEventListener('config_updated', (e) => {
        const data = JSON.parse(e.data);
        onConfigUpdated?.(data);
      });

      es.addEventListener('plugins_changed', (e) => {
        const data = JSON.parse(e.data);
        onPluginsChanged?.(data);
      });

      // Eventos arbitrarios (p. ej. `plugin:<nombre>:<evento>` de plugins).
      Object.keys(eventsRef.current).forEach((name) => {
        es.addEventListener(name, (e) => {
          const data = JSON.parse(e.data);
          eventsRef.current[name]?.(data);
        });
      });

      es.onerror = () => {
        es.close();
        setConnected(false);
        // Reconectar después de 10 s
        retryTimer = setTimeout(connect, 10_000);
      };
    }

    connect();

    return () => {
      esRef.current?.close();
      clearTimeout(retryTimer);
    };
  }, [url]);

  return { connected, lastEvent };
}
