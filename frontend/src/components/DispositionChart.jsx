import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const COLORS = {
  'Contestadas':             '#22c55e',
  'Perdidas':                '#ef4444',
  'Perdidas en horario':     '#ef4444',
  'Perdidas fuera de horario': '#64748b',
  'No Contest.':             '#f59e0b',
};

const RADIAN = Math.PI / 180;
function renderCustomLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent }) {
  if (percent < 0.05) return null;
  const r = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + r * Math.cos(-midAngle * RADIAN);
  const y = cy + r * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={600}>
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
}

export function DispositionChart({ dispositions, businessHours }) {
  const breakdown = dispositions?.['NO ANSWER']?.breakdown ?? {};
  const lost          = breakdown.ivr_hangup         ?? 0;
  const lostBusiness  = breakdown.ivr_hangup_business ?? 0;
  const lostOffhours  = breakdown.ivr_hangup_offhours ?? 0;
  const noAnswer = (breakdown.no_answer ?? 0) + (breakdown.queue_no_agent ?? 0);

  const lostEntries = businessHours
    ? [
        { name: 'Perdidas en horario',       value: lostBusiness },
        { name: 'Perdidas fuera de horario', value: lostOffhours },
      ]
    : [{ name: 'Perdidas', value: lost }];

  const data = [
    { name: 'Contestadas', value: dispositions?.ANSWERED?.count ?? 0 },
    ...lostEntries,
    { name: 'No Contest.', value: noAnswer },
  ].filter(d => d.value > 0);

  const total = data.reduce((s, d) => s + d.value, 0);

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-500 text-sm">
        Sin datos para mostrar
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={55}
          outerRadius={90}
          paddingAngle={2}
          dataKey="value"
          labelLine={false}
          label={renderCustomLabel}
        >
          {data.map((entry) => (
            <Cell key={entry.name} fill={COLORS[entry.name]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }}
          formatter={(v, name) => [v.toLocaleString('es-CO'), name]}
        />
        <Legend
          formatter={(value) => <span style={{ color: '#94a3b8', fontSize: 12 }}>{value}</span>}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
