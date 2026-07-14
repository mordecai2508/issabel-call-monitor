import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Login from './components/Login';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import InboundView from './components/InboundView';
import OutboundView from './components/OutboundView';
import HistoricalView from './components/HistoricalView';
import ChannelAliasManager from './components/ChannelAliasManager';
import QueueAliasManager from './components/QueueAliasManager';
import UserManagement from './components/UserManagement';
import InboundTable from './components/InboundTable';
import OutboundTable from './components/OutboundTable';
import HistoricalAnalytics from './components/HistoricalAnalytics';
import ReportsModule from './components/ReportsModule';
import SystemConfig from './components/SystemConfig';
import AlertsPanel from './components/AlertsPanel';
import AlertRulesManager from './components/AlertRulesManager';
import PluginRoute from './components/PluginRoute';
import PluginsManager from './components/PluginsManager';
import { pluginRegistry } from './plugins';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AdminRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  const { user } = useAuth();
  if (user === undefined) return null; // aún cargando

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="inbound"   element={<InboundView />} />
        <Route path="inbound/search" element={<PrivateRoute><InboundTable /></PrivateRoute>} />
        <Route path="outbound"  element={<OutboundView />} />
        <Route path="outbound/search" element={<PrivateRoute><OutboundTable /></PrivateRoute>} />
        <Route path="historical" element={<HistoricalView />} />
        <Route path="historical/analytics" element={<PrivateRoute><HistoricalAnalytics /></PrivateRoute>} />
        <Route path="reports" element={<PrivateRoute><ReportsModule /></PrivateRoute>} />
        <Route path="alerts" element={<PrivateRoute><AlertsPanel /></PrivateRoute>} />
        <Route path="channels"    element={<AdminRoute><ChannelAliasManager /></AdminRoute>} />
        <Route path="queues"      element={<AdminRoute><QueueAliasManager /></AdminRoute>} />
        <Route path="admin/users" element={<AdminRoute><UserManagement /></AdminRoute>} />
        <Route path="admin/config" element={<AdminRoute><SystemConfig /></AdminRoute>} />
        <Route path="admin/alerts" element={<AdminRoute><AlertRulesManager /></AdminRoute>} />
        {pluginRegistry.map(p => (
          <Route
            key={p.name}
            path={`plugins/${p.name}`}
            element={<PluginRoute name={p.name}><p.component /></PluginRoute>}
          />
        ))}
        <Route path="admin/plugins" element={<AdminRoute><PluginsManager /></AdminRoute>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
