import { useEffect, useState, useRef } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { AppConfigContext } from '../contexts/AppConfigContext';
import {
  Phone, LayoutDashboard, History,
  LogOut, Shield, Eye, PhoneCall, Pencil, Check, X,
  PhoneIncoming, PhoneOutgoing, Users, Search, BarChart2, FileText, Settings,
  Bell, BellRing, Puzzle,
} from 'lucide-react';
import { api } from '../api';
import { useSSE } from '../hooks/useSSE';
import { usePlugins } from '../hooks/usePlugins';
import { pluginRegistry } from '../plugins';
import PbxStatus from './PbxStatus';
import Toast from './Toast';

function NavItem({ to, icon: Icon, label }) {
  return (
    <NavLink
      to={to}
      end={to === '/' || to === '/inbound' || to === '/outbound' || to === '/historical'}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
          isActive
            ? 'bg-blue-600 text-white'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700'
        }`
      }
    >
      <Icon className="w-4 h-4" />
      {label}
    </NavLink>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [appName, setAppName]             = useState('Call Monitor');
  const [subcompanyName, setSubcompanyName] = useState('');
  const [dbTimezone, setDbTimezone]       = useState(null);
  const [editing, setEditing]             = useState(false);
  const [editValue, setEditValue]         = useState('');
  const [saving, setSaving]               = useState(false);

  // PBX connection status (feature pbx_health, R14/R16/R17)
  const [pbxStatus, setPbxStatus] = useState(null);
  const [toast, setToast]         = useState(null);
  const prevConnectedRef = useRef(null);

  // Plugins habilitados con vista (feature plugin_system, R29/R30)
  const { plugins, refresh: refreshPlugins } = usePlugins();
  const visiblePlugins = pluginRegistry.filter(p =>
    plugins.find(b => b.name === p.name && b.enabled && b.hasView)
  );

  useEffect(() => {
    api.publicConfig().then(d => {
      setAppName(d.appName);
      setSubcompanyName(d.subcompanyName || '');
      if (d.dbTimezone) setDbTimezone(d.dbTimezone);
    }).catch(() => {});
  }, []);

  useSSE('/api/events', {
    onPbxStatus: (data) => {
      const prevConnected = prevConnectedRef.current;
      if (prevConnected === true && data.connected === false) {
        setToast({ type: 'error', message: 'Se perdió la conexión con el PBX.' });
      } else if (prevConnected === false && data.connected === true) {
        setToast({ type: 'success', message: 'Conexión con el PBX restablecida.' });
      }
      prevConnectedRef.current = data.connected;
      setPbxStatus(data);
    },
    // Notificación global de alertas nuevas (feature alerts_monitoring, R25)
    onAlert: (data) => {
      if (data.resolved) return;
      setToast({ type: 'error', message: `Nueva alerta: ${data.description || data.type}` });
    },
    onConfigUpdated: (data) => {
      if (data.appName !== undefined)        setAppName(data.appName);
      if (data.subcompanyName !== undefined) setSubcompanyName(data.subcompanyName);
    },
    // Cambio de estado de plugins en vivo (feature plugin_system, R30)
    onPluginsChanged: () => refreshPlugins(),
  });

  async function saveAppName() {
    if (!editValue.trim()) { setEditing(false); return; }
    setSaving(true);
    try {
      const res = await api.updateAppName(editValue);
      setAppName(res.name);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <AppConfigContext.Provider value={{ dbTimezone }}>
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col p-4">

        {/* Brand */}
        <div className="flex items-center gap-2.5 mb-8 px-1 group">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
            <Phone className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 overflow-hidden">
            {editing ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter')  saveAppName();
                    if (e.key === 'Escape') setEditing(false);
                  }}
                  className="w-full bg-slate-700 border border-slate-500 rounded px-1.5 py-0.5 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                />
                <button onClick={saveAppName} disabled={saving} className="text-emerald-400 hover:text-emerald-300">
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setEditing(false)} className="text-slate-500 hover:text-slate-300">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <div className="text-sm font-semibold text-slate-100 leading-none truncate">{appName}</div>
                {user?.role === 'admin' && (
                  <button
                    onClick={() => { setEditValue(appName); setEditing(true); }}
                    className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-300 transition-opacity"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
            {subcompanyName && (
              <div className="text-xs text-slate-500 leading-none mt-0.5">{subcompanyName}</div>
            )}
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1">
          <p className="text-xs text-slate-600 uppercase tracking-wider px-3 mb-2">Monitoreo</p>
          <NavItem to="/"           icon={LayoutDashboard} label="Dashboard" />
          <NavItem to="/inbound"    icon={PhoneIncoming}   label="Entrantes" />
          <NavItem to="/inbound/search" icon={Search}     label="Búsqueda entrantes" />
          <NavItem to="/outbound"        icon={PhoneOutgoing} label="Salientes" />
          <NavItem to="/outbound/search" icon={Search}     label="Búsqueda salientes" />
          <NavItem to="/historical"           icon={History}    label="Histórico" />
          <NavItem to="/historical/analytics" icon={BarChart2} label="Analytics" />
          <NavItem to="/reports" icon={FileText} label="Reportes" />
          <NavItem to="/alerts" icon={Bell} label="Alertas" />
          {visiblePlugins.length > 0 && (
            <>
              <p className="text-xs text-slate-600 uppercase tracking-wider px-3 mb-2 mt-4">Plugins</p>
              {visiblePlugins.map(p => (
                <NavItem
                  key={p.name}
                  to={`/plugins/${p.name}`}
                  icon={p.icon || Puzzle}
                  label={plugins.find(b => b.name === p.name)?.title || p.title}
                />
              ))}
            </>
          )}
          {user?.role === 'admin' && (
            <>
              <p className="text-xs text-slate-600 uppercase tracking-wider px-3 mb-2 mt-4">Admin</p>
              <NavItem to="/channels"    icon={PhoneCall} label="Canales" />
              <NavItem to="/admin/users" icon={Users}     label="Usuarios" />
              <NavItem to="/admin/config" icon={Settings} label="Configuración" />
              <NavItem to="/admin/alerts" icon={BellRing} label="Reglas de alerta" />
              <NavItem to="/admin/plugins" icon={Puzzle}  label="Plugins" />
            </>
          )}
        </nav>

        {/* User */}
        <div className="border-t border-slate-800 pt-4 mt-4">
          <div className="mb-3 px-2">
            <PbxStatus pbxStatus={pbxStatus} />
          </div>
          <div className="flex items-center gap-2 px-2 mb-3">
            <div className="w-8 h-8 bg-slate-700 rounded-full flex items-center justify-center shrink-0">
              {user?.role === 'admin'
                ? <Shield className="w-4 h-4 text-blue-400" />
                : <Eye className="w-4 h-4 text-slate-400" />
              }
            </div>
            <div className="overflow-hidden">
              <div className="text-sm font-medium text-slate-200 truncate">{user?.username}</div>
              <div className="text-xs text-slate-500 capitalize">{user?.role}</div>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 w-full px-3 py-2 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg text-sm transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>

      {toast && (
        <Toast
          type={toast.type}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      )}
    </div>
    </AppConfigContext.Provider>
  );
}
