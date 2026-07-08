// Registro ESTÁTICO de vistas de plugins (feature plugin_system, R27).
// Añadir un plugin nuevo requiere rebuild del frontend.
// `name` debe coincidir con el manifest.name del plugin backend.
import MinutesMonitorView from './minutes-monitor/MinutesMonitorView';
import { Timer } from 'lucide-react';
export const pluginRegistry = [
  { name: 'minutes-monitor', title: 'Monitor de minutos', icon: Timer, component: MinutesMonitorView },
];
