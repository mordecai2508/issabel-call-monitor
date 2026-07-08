import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import {
  Plus, Pencil, KeyRound, UserCheck, UserX,
  ClipboardList, Users, RefreshCw, X, Eye, EyeOff,
} from 'lucide-react';

// ── Banner helpers ────────────────────────────────────────────────────────────

function SuccessBanner({ message, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="mb-4 flex items-center justify-between rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-4 py-2 text-emerald-400 text-sm">
      <span>{message}</span>
      <button onClick={onDismiss}><X className="w-4 h-4" /></button>
    </div>
  );
}

function ErrorBanner({ message, onDismiss }) {
  return (
    <div className="mb-4 flex items-center justify-between rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2 text-red-400 text-sm">
      <span>{message}</span>
      <button onClick={onDismiss}><X className="w-4 h-4" /></button>
    </div>
  );
}

// ── Modal wrapper ─────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="text-base font-semibold text-slate-100">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ── Field helpers ─────────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <div className="mb-4">
      <label className="block text-xs font-medium text-slate-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

function Input({ ...props }) {
  return (
    <input
      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
      {...props}
    />
  );
}

function Select({ children, ...props }) {
  return (
    <select
      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
      {...props}
    >
      {children}
    </select>
  );
}

// ── Create User Form ──────────────────────────────────────────────────────────

function CreateUserForm({ onCreated }) {
  const [form, setForm]     = useState({ username: '', password: '', role: 'operador' });
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const [showPwd, setShowPwd] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.createUser(form);
      setForm({ username: '', password: '', role: 'operador' });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 mb-6">
      <h2 className="text-sm font-semibold text-slate-200 mb-4 flex items-center gap-2">
        <Plus className="w-4 h-4 text-blue-400" /> Crear usuario
      </h2>
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Username">
          <Input
            value={form.username}
            onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
            placeholder="usuario"
            required
          />
        </Field>
        <Field label="Contraseña">
          <div className="relative">
            <Input
              type={showPwd ? 'text' : 'password'}
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="mín. 8 caracteres"
              required
            />
            <button
              type="button"
              onClick={() => setShowPwd(v => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
            >
              {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </Field>
        <Field label="Rol">
          <Select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="operador">Operador</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        <div className="sm:col-span-3">
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {loading ? 'Creando…' : 'Crear usuario'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Edit User Modal ───────────────────────────────────────────────────────────

function EditUserModal({ user, onClose, onUpdated }) {
  const [form, setForm]     = useState({ username: user.username, role: user.role, active: user.active === 1 });
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.updateUser(user.id, {
        username: form.username,
        role:     form.role,
        active:   form.active ? 1 : 0,
      });
      onUpdated();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal title={`Editar usuario — ${user.username}`} onClose={onClose}>
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      <form onSubmit={handleSubmit}>
        <Field label="Username">
          <Input
            value={form.username}
            onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
            required
          />
        </Field>
        <Field label="Rol">
          <Select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="operador">Operador</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        <Field label="Estado">
          <label className="flex items-center gap-2 cursor-pointer">
            <div
              onClick={() => setForm(f => ({ ...f, active: !f.active }))}
              className={`w-10 h-5 rounded-full transition-colors ${form.active ? 'bg-emerald-500' : 'bg-slate-600'} relative`}
            >
              <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.active ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </div>
            <span className="text-sm text-slate-300">{form.active ? 'Activo' : 'Inactivo'}</span>
          </label>
        </Field>
        <div className="flex gap-3 mt-4">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors"
          >
            {loading ? 'Guardando…' : 'Guardar cambios'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium py-2 rounded-lg transition-colors"
          >
            Cancelar
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Reset Password Modal ──────────────────────────────────────────────────────

function ResetPasswordModal({ user, onClose }) {
  const [tmpPassword, setTmpPassword] = useState(null);
  const [error, setError]             = useState('');
  const [loading, setLoading]         = useState(false);

  async function handleConfirm() {
    setError('');
    setLoading(true);
    try {
      const res = await api.resetPassword(user.id);
      setTmpPassword(res.data.temporaryPassword);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal title={`Reset contraseña — ${user.username}`} onClose={onClose}>
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      {tmpPassword ? (
        <div>
          <div className="mb-3 text-sm text-slate-300">
            Contraseña temporal generada. <strong className="text-amber-400">Guárdala ahora, no se mostrará de nuevo.</strong>
          </div>
          <div className="bg-slate-900 border border-slate-600 rounded-lg px-4 py-3 font-mono text-emerald-400 text-sm break-all select-all">
            {tmpPassword}
          </div>
          <button
            onClick={onClose}
            className="mt-4 w-full bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium py-2 rounded-lg transition-colors"
          >
            Cerrar
          </button>
        </div>
      ) : (
        <div>
          <p className="text-sm text-slate-300 mb-5">
            Se generará una contraseña temporal para <strong className="text-slate-100">{user.username}</strong>. El usuario deberá cambiarla al ingresar.
          </p>
          <div className="flex gap-3">
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="flex-1 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors"
            >
              {loading ? 'Generando…' : 'Confirmar reset'}
            </button>
            <button
              onClick={onClose}
              className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium py-2 rounded-lg transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Users Table ───────────────────────────────────────────────────────────────

function UsersTable({ users, onEdit, onReset, onToggleActive }) {
  function formatLogin(ts) {
    if (!ts) return '—';
    return new Date(ts + 'Z').toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-800 text-slate-400 text-xs uppercase tracking-wider">
            <th className="text-left px-4 py-3">Username</th>
            <th className="text-left px-4 py-3">Rol</th>
            <th className="text-left px-4 py-3">Estado</th>
            <th className="text-left px-4 py-3">Último login</th>
            <th className="text-right px-4 py-3">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700/50">
          {users.map(u => (
            <tr key={u.id} className="bg-slate-800/40 hover:bg-slate-800/70 transition-colors">
              <td className="px-4 py-3 font-medium text-slate-200">{u.username}</td>
              <td className="px-4 py-3">
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  u.role === 'admin'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'bg-slate-600/50 text-slate-400'
                }`}>
                  {u.role}
                </span>
              </td>
              <td className="px-4 py-3">
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  u.active
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-red-500/20 text-red-400'
                }`}>
                  {u.active ? 'Activo' : 'Inactivo'}
                </span>
              </td>
              <td className="px-4 py-3 text-slate-400">{formatLogin(u.last_login)}</td>
              <td className="px-4 py-3 text-right">
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => onEdit(u)}
                    title="Editar"
                    className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onReset(u)}
                    title="Reset contraseña"
                    className="p-1.5 text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 rounded transition-colors"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onToggleActive(u)}
                    title={u.active ? 'Desactivar' : 'Activar'}
                    className={`p-1.5 rounded transition-colors ${
                      u.active
                        ? 'text-slate-400 hover:text-red-400 hover:bg-red-500/10'
                        : 'text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10'
                    }`}
                  >
                    {u.active ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Audit Log Table ───────────────────────────────────────────────────────────

function AuditLogTable() {
  const [log, setLog]         = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const loadLog = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.auditLog();
      setLog(res.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadLog(); }, [loadLog]);

  const actionColor = {
    login:        'text-emerald-400',
    logout:       'text-blue-400',
    login_failed: 'text-red-400',
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-slate-500">Últimas {log.length} entradas</p>
        <button
          onClick={loadLog}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Actualizar
        </button>
      </div>
      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      <div className="overflow-x-auto rounded-xl border border-slate-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800 text-slate-400 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3">Timestamp</th>
              <th className="text-left px-4 py-3">Username</th>
              <th className="text-left px-4 py-3">Acción</th>
              <th className="text-left px-4 py-3">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {log.map(entry => (
              <tr key={entry.id} className="bg-slate-800/40 hover:bg-slate-800/70 transition-colors">
                <td className="px-4 py-2 text-slate-400 tabular-nums text-xs">{entry.timestamp}</td>
                <td className="px-4 py-2 text-slate-200">{entry.username || '—'}</td>
                <td className={`px-4 py-2 font-medium ${actionColor[entry.action] || 'text-slate-300'}`}>
                  {entry.action}
                </td>
                <td className="px-4 py-2 text-slate-400 text-xs font-mono">{entry.ip || '—'}</td>
              </tr>
            ))}
            {!loading && log.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-500 text-xs">Sin entradas</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

const TABS = [
  { id: 'users', label: 'Usuarios', icon: Users },
  { id: 'audit', label: 'Auditoría', icon: ClipboardList },
];

export default function UserManagement() {
  const [tab, setTab]           = useState('users');
  const [users, setUsers]       = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');
  const [editUser, setEditUser]  = useState(null);
  const [resetUser, setResetUser] = useState(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.adminUsers();
      setUsers(res.data || res.users || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  async function handleToggleActive(user) {
    setError('');
    try {
      await api.updateUser(user.id, { active: user.active ? 0 : 1 });
      setSuccess(`Usuario ${user.username} ${user.active ? 'desactivado' : 'activado'}.`);
      loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold text-slate-100 mb-6">Gestión de usuarios</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-slate-800 p-1 rounded-lg w-fit">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === id
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Banners */}
      {success && <SuccessBanner message={success} onDismiss={() => setSuccess('')} />}
      {error   && <ErrorBanner   message={error}   onDismiss={() => setError('')} />}

      {tab === 'users' && (
        <>
          <CreateUserForm
            onCreated={() => {
              loadUsers();
              setSuccess('Usuario creado correctamente.');
            }}
          />
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <UsersTable
              users={users}
              onEdit={setEditUser}
              onReset={setResetUser}
              onToggleActive={handleToggleActive}
            />
          )}
        </>
      )}

      {tab === 'audit' && <AuditLogTable />}

      {/* Modals */}
      {editUser && (
        <EditUserModal
          user={editUser}
          onClose={() => setEditUser(null)}
          onUpdated={() => {
            loadUsers();
            setSuccess('Usuario actualizado correctamente.');
          }}
        />
      )}
      {resetUser && (
        <ResetPasswordModal
          user={resetUser}
          onClose={() => setResetUser(null)}
        />
      )}
    </div>
  );
}
