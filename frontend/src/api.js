const BASE = '';  // Proxied by Vite in dev, same origin in prod

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  login:         (username, password) => req('POST', '/api/auth/login',  { username, password }),
  logout:        ()                   => req('POST', '/api/auth/logout'),
  me:            ()                   => req('GET',  '/api/auth/me'),
  today:         ()                   => req('GET',  '/api/calls/today'),
  range:         (from, to)           => req('GET',  `/api/calls/range?from=${from}&to=${to}`),
  adminUsers:    ()                   => req('GET',  '/api/admin/users'),
  adminChannels: ()                   => req('GET',  '/api/admin/channels'),
  updateChannelAlias: (channel, alias) =>
    req('PUT', '/api/admin/channels', { channel, alias }),
  publicConfig:  ()                   => req('GET',  '/api/config/public'),
  updateAppName: (name)               => req('PUT',  '/api/admin/app', { name }),
  // User management
  createUser:       (data)            => req('POST',  '/api/admin/users', data),
  updateUser:       (id, data)        => req('PATCH', `/api/admin/users/${id}`, data),
  resetPassword:    (id)              => req('POST',  `/api/admin/users/${id}/reset-password`),
  auditLog:         ()                => req('GET',   '/api/admin/audit-log'),
  // Inbound search
  inboundCalls:     (queryString)     => req('GET',   `/api/calls/inbound?${queryString}`),
  // Outbound search
  outboundCalls:    (queryString)     => req('GET',   `/api/calls/outbound?${queryString}`),
  // Historical analytics
  statsHistorical: ({ period, from, to }) =>
    req('GET', `/api/stats/historical?${new URLSearchParams({ period, from, to })}`),
  statsCompare: ({ period1_from, period1_to, period2_from, period2_to }) =>
    req('GET', `/api/stats/compare?${new URLSearchParams({ period1_from, period1_to, period2_from, period2_to })}`),
  statsRankings: ({ from, to, type, limit }) =>
    req('GET', `/api/stats/rankings?${new URLSearchParams({ from, to, type, limit })}`),
  // Reports
  reportDownload: async ({ type, from, to, format }) => {
    const params = new URLSearchParams({ from, to });
    const res = await fetch(`${BASE}/api/reports/${type}/${format}?${params}`, { credentials: 'include' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="(.+)"/);
    return { blob, filename: match ? match[1] : `reporte.${format}` };
  },
  // System configuration (admin)
  adminConfig:       ()      => req('GET',   '/api/admin/config'),
  updateAdminConfig: (data)  => req('PATCH', '/api/admin/config', data),
  uploadLogo:        (file)  => {
    const formData = new FormData();
    formData.append('logo', file);
    return fetch(`${BASE}/api/admin/config/logo`, { method: 'POST', credentials: 'include', body: formData })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      });
  },
  adminExtensions:   ()                  => req('GET',   '/api/admin/extensions'),
  updateExtension:   (ext, data)         => req('PATCH', `/api/admin/extensions/${encodeURIComponent(ext)}`, data),
  adminTrunks:       ()                  => req('GET',   '/api/admin/trunks'),
  updateTrunkVisibility: (trunk, hidden) => req('PATCH', '/api/admin/trunks', { trunk, hidden }),
  // PBX health monitoring
  pbxHealth: ()                          => req('GET',  '/api/pbx/health'),
  pbxSync:   ()                          => req('POST', '/api/pbx/sync'),
  // Extensions status (AMI)
  pbxExtensions: ()                      => req('GET',  '/api/pbx/extensions'),
  // Alerts monitoring
  activeAlerts:    ()         => req('GET',    '/api/alerts/active'),
  resolveAlert:    (id)       => req('PATCH',  `/api/alerts/${id}/resolve`),
  adminAlertRules: ()         => req('GET',    '/api/admin/alerts/rules'),
  // Plugins
  plugins:      ()              => req('GET',   '/api/plugins'),
  updatePlugin: (name, enabled) => req('PATCH', `/api/admin/plugins/${encodeURIComponent(name)}`, { enabled }),
  // Plugin minutes-monitor
  minutesMonitorStatus:       ()     => req('GET', '/api/plugins/minutes-monitor/status'),
  minutesMonitorConfig:       ()     => req('GET', '/api/plugins/minutes-monitor/config'),
  updateMinutesMonitorConfig: (data) => req('PUT', '/api/plugins/minutes-monitor/config', data),
  createAlertRule: (data)     => req('POST',   '/api/admin/alerts/rules', data),
  updateAlertRule: (id, data) => req('PATCH',  `/api/admin/alerts/rules/${id}`, data),
  deleteAlertRule: (id)       => req('DELETE', `/api/admin/alerts/rules/${id}`),
};
