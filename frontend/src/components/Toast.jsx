import { useEffect } from 'react';
import { CheckCircle2, XCircle, Info, X } from 'lucide-react';

const STYLES = {
  error:   { icon: XCircle,     classes: 'bg-red-500/10 border-red-500/30 text-red-300' },
  success: { icon: CheckCircle2, classes: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' },
  info:    { icon: Info,         classes: 'bg-blue-500/10 border-blue-500/30 text-blue-300' },
};

/**
 * Generic floating toast notification (feature pbx_health, R16/R17).
 *
 * @param {string} message
 * @param {'error'|'success'|'info'} [type]
 * @param {() => void} onClose
 * @param {number} [duration] - auto-dismiss delay in ms (default 5000)
 */
export default function Toast({ message, type = 'info', onClose, duration = 5000 }) {
  useEffect(() => {
    const timer = setTimeout(() => onClose?.(), duration);
    return () => clearTimeout(timer);
  }, [onClose, duration]);

  if (!message) return null;

  const { icon: Icon, classes } = STYLES[type] || STYLES.info;

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 flex items-start gap-3 max-w-sm w-full border rounded-lg px-4 py-3 shadow-lg backdrop-blur animate-fade-in ${classes}`}
      role="alert"
    >
      <Icon className="w-5 h-5 shrink-0 mt-0.5" />
      <p className="text-sm flex-1">{message}</p>
      <button
        onClick={() => onClose?.()}
        className="text-current opacity-60 hover:opacity-100 transition-opacity"
        aria-label="Cerrar notificación"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
