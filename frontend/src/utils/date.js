/**
 * Calcula la fecha de hoy (YYYY-MM-DD) en el timezone del servidor (ej. "-05:00").
 * Si no se pasa timezone, usa la hora local del navegador.
 */
export function todayStr(tz) {
  const p = n => String(n).padStart(2, '0');
  const match = typeof tz === 'string' ? tz.match(/^([+-])(\d{2}):(\d{2})$/) : null;
  if (match) {
    const offsetMin = (match[1] === '+' ? 1 : -1) * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
    const d = new Date(Date.now() + offsetMin * 60_000);
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
