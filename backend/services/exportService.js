'use strict';

const fs = require('fs');

const ExcelJS  = require('exceljs');
const PDFDocument = require('pdfkit');
const { MAX_EXPORT_ROWS } = require('./cdrService');
const {
  INBOUND_XLSX_HEADERS,
  INBOUND_PDF_HEADERS,
  INBOUND_ROW_KEYS,
  OUTBOUND_XLSX_HEADERS,
  OUTBOUND_PDF_HEADERS,
  OUTBOUND_ROW_KEYS,
} = require('./reportConstants');

// ── Report titles per type ───────────────────────────────────────────────────
const REPORT_TITLES = {
  executive:  'Resumen Ejecutivo',
  inbound:    'Llamadas Entrantes',
  outbound:   'Llamadas Salientes',
  extensions: 'Actividad de Extensiones',
  trunks:     'Actividad de Troncales',
};

const RANKING_HEADERS_TRUNK      = ['Nombre', 'Total', 'Contestadas', 'No contestadas', 'Dur. media (min)'];
const RANKING_HEADERS_EXTENSIONS = ['Nombre', 'Llamadas contestadas', 'Dur. media (min)'];
const RANKING_HEADERS  = RANKING_HEADERS_TRUNK; // backward-compat alias
const RANKING_ROW_KEYS_TRUNK      = ['name', 'total', 'answered', 'no_answer', 'avg_duration'];
const RANKING_ROW_KEYS_EXTENSIONS = ['name', 'answered', 'avg_duration'];
const RANKING_ROW_KEYS = RANKING_ROW_KEYS_TRUNK; // backward-compat alias

const DISPOSITION_LABELS  = { ANSWERED: 'Contestadas', 'NO ANSWER': 'No contestadas' };
const DISPOSITIONS_ORDER  = ['ANSWERED', 'NO ANSWER'];
const MULTI_COLORS_DEFAULT = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444'];

/**
 * Stream an XLSX file to the HTTP response.
 */
async function toXlsx(rows, res, filenameBase, truncated = false, headers = null, sheetName = 'Entrantes') {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
  if (truncated) res.setHeader('X-Truncated', 'true');

  const workbook  = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
  const worksheet = workbook.addWorksheet(sheetName);

  const effectiveHeaders = headers !== null ? headers : [
    'Fecha/Hora', 'Origen', 'Destino', 'Troncal', 'Duración (s)', 'Seg. facturados', 'Estado',
  ];
  worksheet.addRow(effectiveHeaders).commit();

  for (const r of rows) {
    worksheet.addRow([
      r.calldate, r.src, r.dst, r.channel || r.dstchannel, r.duration, r.billsec, r.disposition,
    ]).commit();
  }

  await worksheet.commit();
  await workbook.commit();
}

/**
 * Helper: draw a table on a PDFDocument with page-break handling.
 */
function drawTable(doc, headers, rows, rowKeys = null) {
  const effectiveKeys = rowKeys || ['calldate', 'src', 'dst', 'channel', 'duration', 'billsec', 'disposition'];
  const colWidths  = [130, 80, 60, 110, 65, 70, 75];
  const rowHeight  = 16;
  const margin     = 40;
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);
  let x = margin;
  let y = doc.y + 8;

  doc.rect(x, y, tableWidth, rowHeight).fill('#1e3a5f');
  doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
  let cx = x;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], cx + 3, y + 4, { width: colWidths[i] - 6, lineBreak: false });
    cx += colWidths[i];
  }
  y += rowHeight;

  doc.font('Helvetica').fontSize(6.5).fillColor('#111111');
  let alternate = false;
  for (const r of rows) {
    if (y + rowHeight > doc.page.height - margin) {
      doc.addPage();
      y = margin;
      doc.rect(x, y, tableWidth, rowHeight).fill('#1e3a5f');
      doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
      cx = x;
      for (let i = 0; i < headers.length; i++) {
        doc.text(headers[i], cx + 3, y + 4, { width: colWidths[i] - 6, lineBreak: false });
        cx += colWidths[i];
      }
      y += rowHeight;
      doc.font('Helvetica').fontSize(6.5).fillColor('#111111');
      alternate = false;
    }

    if (alternate) doc.rect(x, y, tableWidth, rowHeight).fill('#f5f5f5');

    const values = effectiveKeys.map(k => String(r[k] != null ? r[k] : ''));
    doc.fillColor('#111111');
    cx = x;
    for (let i = 0; i < values.length; i++) {
      doc.text(values[i], cx + 3, y + 4, { width: colWidths[i] - 6, lineBreak: false });
      cx += colWidths[i];
    }
    doc.moveTo(x, y + rowHeight).lineTo(x + tableWidth, y + rowHeight).stroke('#dddddd');
    y += rowHeight;
    alternate = !alternate;
  }
}

/**
 * Stream a PDF file to the HTTP response (search/export endpoint).
 */
function toPdf(rows, res, filenameBase, filters, truncated = false, title = null, pdfHeaders = null, rowKeys = null) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  doc.pipe(res);

  const effectiveTitle = title !== null ? title : 'Llamadas Entrantes — Búsqueda';

  doc.fontSize(16).font('Helvetica-Bold').fillColor('#1e3a5f').text(effectiveTitle, { align: 'center' });
  doc.moveDown(0.4);
  doc.fontSize(10).font('Helvetica').fillColor('#333333')
    .text(`Rango de fechas: ${filters.from} — ${filters.to}`, { align: 'center' });
  doc.moveDown(0.3);

  const activeFilters = [];
  if (filters.trunk)       activeFilters.push(`Troncal: ${filters.trunk}`);
  if (filters.origin)      activeFilters.push(`Origen: ${filters.origin}`);
  if (filters.extension)   activeFilters.push(`Extensión: ${filters.extension}`);
  if (filters.dest)        activeFilters.push(`Destino: ${filters.dest}`);
  if (filters.disposition) activeFilters.push(`Estado: ${filters.disposition}`);
  if (activeFilters.length > 0) {
    doc.fontSize(9).fillColor('#555555')
      .text(`Filtros activos: ${activeFilters.join(' | ')}`, { align: 'center' });
    doc.moveDown(0.3);
  }

  doc.fontSize(8).fillColor('#888888').text(`Generado: ${new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })}`, { align: 'center' });
  doc.moveDown(0.3);

  if (truncated) {
    doc.fontSize(9).fillColor('#cc0000')
      .text(`AVISO: El resultado fue truncado a ${MAX_EXPORT_ROWS} registros.`, { align: 'center' });
    doc.moveDown(0.3);
  }

  if (rows.length === 0) {
    doc.fontSize(11).fillColor('#555555')
      .text('No se encontraron registros para los filtros seleccionados.', { align: 'center' });
  } else {
    const effectiveHeaders = pdfHeaders !== null ? pdfHeaders : ['Fecha/Hora', 'Origen', 'Destino', 'Troncal', 'Duración (s)', 'Seg. fact.', 'Estado'];
    drawTable(doc, effectiveHeaders, rows, rowKeys);
  }

  doc.end();
}

/**
 * Draw a simple vertical bar chart on a PDFDocument.
 * @returns {number} y coordinate immediately below the chart
 */
function drawBarChart(doc, { title, labels, values, x, y, width, height, color = '#3b82f6' }) {
  const titleHeight = 18;
  const labelHeight = 14;
  const chartTop    = y + titleHeight;
  const chartHeight = height - titleHeight - labelHeight;
  const chartBottom = chartTop + chartHeight;

  doc.fontSize(10).font('Helvetica-Bold').fillColor('#1e3a5f')
    .text(title, x, y, { width, align: 'left' });

  doc.moveTo(x, chartBottom).lineTo(x + width, chartBottom).stroke('#cccccc');

  if (!labels || labels.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor('#888888')
      .text('Sin datos para el rango seleccionado', x, chartTop + chartHeight / 2 - 6, { width, align: 'center' });
    return y + height;
  }

  const maxValue  = Math.max(1, ...values);
  const slotWidth = width / labels.length;
  const barWidth  = Math.min(40, slotWidth * 0.6);

  for (let i = 0; i < labels.length; i++) {
    const value     = Number(values[i]) || 0;
    const barHeight = chartHeight > 0 ? (value / maxValue) * (chartHeight - 14) : 0;
    const slotX     = x + i * slotWidth;
    const barX      = slotX + (slotWidth - barWidth) / 2;
    const barY      = chartBottom - barHeight;

    doc.fontSize(7).font('Helvetica').fillColor('#333333')
      .text(String(value), slotX, barY - 10, { width: slotWidth, align: 'center', lineBreak: false });
    doc.rect(barX, barY, barWidth, barHeight).fill(color);
    doc.fontSize(7).font('Helvetica').fillColor('#555555')
      .text(String(labels[i]), slotX, chartBottom + 3, { width: slotWidth, align: 'center', lineBreak: false });
  }

  return y + height;
}

/**
 * Draw a grouped multi-series bar chart on a PDFDocument.
 * @param {PDFDocument} doc
 * @param {object} opts
 * @param {string}   opts.title
 * @param {string[]} opts.labels
 * @param {{ label: string, values: number[], color?: string }[]} opts.series
 * @param {number}   opts.x
 * @param {number}   opts.y
 * @param {number}   opts.width
 * @param {number}   opts.height
 * @returns {number} y coordinate immediately below the chart
 */
function drawMultiBarChart(doc, { title, labels, series, x, y, width, height }) {
  const titleH  = 18;
  const legendH = 14;
  const labelH  = 14;
  const chartTop    = y + titleH + legendH;
  const chartH      = height - titleH - legendH - labelH;
  const chartBottom = chartTop + chartH;

  doc.fontSize(10).font('Helvetica-Bold').fillColor('#1e3a5f')
    .text(title, x, y, { width, align: 'left' });

  // Legend
  let lx = x;
  series.forEach((s, si) => {
    const col = s.color || MULTI_COLORS_DEFAULT[si % MULTI_COLORS_DEFAULT.length];
    doc.rect(lx, y + titleH + 3, 8, 8).fill(col);
    doc.fontSize(7).font('Helvetica').fillColor('#555555')
      .text(s.label, lx + 11, y + titleH + 4, { lineBreak: false });
    lx += Math.min(120, width / Math.max(series.length, 1));
  });

  doc.moveTo(x, chartBottom).lineTo(x + width, chartBottom).stroke('#cccccc');

  if (!labels || labels.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor('#888888')
      .text('Sin datos para el rango seleccionado', x, chartTop + chartH / 2 - 6, { width, align: 'center' });
    return y + height;
  }

  const maxVal    = Math.max(1, ...series.flatMap(s => s.values.map(Number)));
  const n         = series.length;
  const slotWidth = width / labels.length;
  const barWidth  = Math.min(20, (slotWidth * 0.7) / Math.max(n, 1));
  const gap       = 2;

  for (let i = 0; i < labels.length; i++) {
    const slotX  = x + i * slotWidth;
    const groupW = barWidth * n + gap * Math.max(n - 1, 0);
    let bx = slotX + (slotWidth - groupW) / 2;

    for (let si = 0; si < n; si++) {
      const col = series[si].color || MULTI_COLORS_DEFAULT[si % MULTI_COLORS_DEFAULT.length];
      const val = Number(series[si].values[i]) || 0;
      const bh  = chartH > 0 ? (val / maxVal) * Math.max(0, chartH - 14) : 0;
      const barY = chartBottom - bh;

      doc.rect(bx, barY, barWidth, bh).fill(col);
      if (bh > 0) {
        doc.fontSize(5.5).font('Helvetica').fillColor('#333333')
          .text(String(val), bx, barY - 8, { width: barWidth, align: 'center', lineBreak: false });
      }
      bx += barWidth + gap;
    }

    doc.fontSize(7).font('Helvetica').fillColor('#555555')
      .text(String(labels[i]), slotX, chartBottom + 3, { width: slotWidth, align: 'center', lineBreak: false });
  }

  return y + height;
}

/**
 * Compute hourly call distribution from a list of CDR rows.
 * @param {object[]} rows - rows with calldate as ISO string or Date
 * @returns {{ hour: number, total: number }[]} 24-element array (hour 0-23)
 */
function computeHourly(rows) {
  const counts = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0 }));
  for (const r of rows) {
    try {
      const h = new Date(r.calldate).getUTCHours();
      if (h >= 0 && h < 24) counts[h].total++;
    } catch (_) { /* skip malformed */ }
  }
  return counts;
}

/**
 * Draw the shared report header (logo, company, title, date range, timestamp).
 */
function drawReportHeader(doc, { type, from, to, branding }) {
  const margin = 40;
  let textX = margin;

  if (branding.logoPath && fs.existsSync(branding.logoPath)) {
    try {
      doc.image(branding.logoPath, margin, doc.y, { width: 60 });
      textX = margin + 70;
    } catch (err) {
      console.error('[exportService] drawReportHeader image:', err.message);
    }
  }

  const startY = doc.y;
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text(branding.companyName, textX, startY, { align: 'left' });
  if (branding.subcompanyName) {
    doc.fontSize(9).font('Helvetica').fillColor('#1e3a5f').text(branding.subcompanyName, textX, doc.y + 1, { align: 'left' });
  }
  doc.fontSize(16).font('Helvetica-Bold').fillColor('#1e3a5f').text(REPORT_TITLES[type] || 'Reporte', textX, doc.y + 2, { align: 'left' });
  doc.fontSize(10).font('Helvetica').fillColor('#333333').text(`Rango de fechas: ${from} — ${to}`, textX, doc.y + 4, { align: 'left' });
  doc.fontSize(8).font('Helvetica').fillColor('#888888').text(`Generado: ${new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })}`, textX, doc.y + 2, { align: 'left' });

  doc.y = Math.max(doc.y, startY + 60) + 10;
  doc.x = margin;
  doc.moveTo(margin, doc.y).lineTo(doc.page.width - margin, doc.y).stroke('#dddddd');
  doc.moveDown(0.6);
}

function drawNoDataMessage(doc) {
  doc.moveDown(0.5);
  doc.fontSize(11).font('Helvetica').fillColor('#555555')
    .text('Sin datos para el rango seleccionado', { align: 'center' });
  doc.moveDown(0.5);
}

/**
 * Render the body of the `executive` report.
 *
 * @param {PDFDocument} doc
 * @param {object} data
 * @param {Function} [_drawBarChart]      - injectable for testing
 * @param {Function} [_drawMultiBarChart] - injectable for testing
 */
function renderExecutiveBody(doc, data, _drawBarChart = drawBarChart, _drawMultiBarChart = drawMultiBarChart) {
  const margin = 40;
  const contentWidth = doc.page.width - margin * 2;
  const { overallTotals, trend, inboundTotals, outboundTotals, topExtensions, topTrunks } = data;

  // KPI summary
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text('Resumen general');
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor('#111111');
  doc.text(`Total de llamadas: ${overallTotals.total}`);
  doc.text(`Contestadas: ${overallTotals.answered}`);
  doc.text(`No contestadas: ${overallTotals.no_answer}`);
  doc.text(`Duración media (min): ${overallTotals.avg_duration}`);
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#1e3a5f').text('Entrantes');
  doc.fontSize(9).font('Helvetica').fillColor('#111111')
    .text(`Total: ${inboundTotals.total} | Contestadas: ${inboundTotals.ANSWERED} | No contestadas: ${inboundTotals['NO ANSWER']}`);
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#1e3a5f').text('Salientes');
  doc.fontSize(9).font('Helvetica').fillColor('#111111')
    .text(`Total: ${outboundTotals.total} | Contestadas: ${outboundTotals.ANSWERED} | No contestadas: ${outboundTotals['NO ANSWER']}`);
  doc.moveDown(0.6);

  // Distribution chart — Contestadas / No Contestadas / Ocupado / Fallidas (#28)
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text('Distribución de disposición');
  doc.moveDown(0.2);
  {
    const chartHeight = 140;
    if (doc.y + chartHeight > doc.page.height - margin) doc.addPage();
    const newY = _drawBarChart(doc, {
      title:  'Llamadas por disposición',
      labels: ['Contestadas', 'No Contestadas'],
      values: [overallTotals.answered, overallTotals.no_answer],
      x: margin, y: doc.y, width: contentWidth, height: chartHeight,
      color: '#3b82f6',
    });
    doc.y = newY;
    doc.moveDown(0.6);
  }

  // Trend — total calls per day
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text('Tendencia diaria');
  doc.moveDown(0.2);
  if (trend.length === 0) {
    drawNoDataMessage(doc);
  } else {
    const chartHeight = 130;
    if (doc.y + chartHeight > doc.page.height - margin) doc.addPage();
    const newY = _drawBarChart(doc, {
      title:  'Llamadas por día',
      labels: trend.map(p => p.period_label),
      values: trend.map(p => p.total),
      x: margin, y: doc.y, width: contentWidth, height: chartHeight,
    });
    doc.y = newY;
    doc.moveDown(0.4);

    // Contestadas vs No Contestadas per day (#28)
    const multiHeight = 140;
    if (doc.y + multiHeight > doc.page.height - margin) doc.addPage();
    const newY2 = _drawMultiBarChart(doc, {
      title:  'Contestadas vs No Contestadas por día',
      labels: trend.map(p => p.period_label),
      series: [
        { label: 'Contestadas',    values: trend.map(p => p.answered),  color: '#10b981' },
        { label: 'No Contestadas', values: trend.map(p => p.no_answer), color: '#f59e0b' },
      ],
      x: margin, y: doc.y, width: contentWidth, height: multiHeight,
    });
    doc.y = newY2;
    doc.moveDown(0.6);
  }

  // Top-5 extensions
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text('Top 5 extensiones');
  doc.moveDown(0.2);
  if (topExtensions.length === 0) {
    drawNoDataMessage(doc);
  } else {
    drawTable(doc, RANKING_HEADERS_EXTENSIONS, topExtensions, RANKING_ROW_KEYS_EXTENSIONS);
    doc.y += topExtensions.length * 16 + 16 + 8;
  }
  doc.moveDown(0.6);

  // Top-5 trunks
  if (doc.y + 60 > doc.page.height - margin) doc.addPage();
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text('Top 5 troncales');
  doc.moveDown(0.2);
  if (topTrunks.length === 0) {
    drawNoDataMessage(doc);
  } else {
    drawTable(doc, RANKING_HEADERS_TRUNK, topTrunks, RANKING_ROW_KEYS_TRUNK);
    doc.y += topTrunks.length * 16 + 16 + 8;
  }
}

/**
 * Render the body of the `inbound`/`outbound` reports.
 *
 * @param {PDFDocument} doc
 * @param {object} data
 * @param {Function} [_drawBarChart] - injectable for testing
 */
function renderCallsBody(doc, data, _drawBarChart = drawBarChart) {
  const margin = 40;
  const contentWidth = doc.page.width - margin * 2;
  const { rows, summary, truncated } = data;

  const isOutbound = data.type === 'outbound';
  const pdfHeaders = isOutbound ? OUTBOUND_PDF_HEADERS : INBOUND_PDF_HEADERS;
  const rowKeys    = isOutbound ? OUTBOUND_ROW_KEYS    : INBOUND_ROW_KEYS;

  // Summary by disposition
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text('Resumen por disposición');
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor('#111111');
  doc.text(`Total: ${summary.total}`);
  for (const d of DISPOSITIONS_ORDER) doc.text(`${DISPOSITION_LABELS[d]}: ${summary[d]}`);
  if (truncated) {
    doc.fontSize(9).fillColor('#cc0000').text(`AVISO: El resultado fue truncado a ${MAX_EXPORT_ROWS} registros.`);
  }
  doc.moveDown(0.6);

  // Disposition distribution chart
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text('Distribución por disposición');
  doc.moveDown(0.2);
  if (summary.total === 0) {
    drawNoDataMessage(doc);
  } else {
    const chartHeight = 140;
    if (doc.y + chartHeight > doc.page.height - margin) doc.addPage();
    const newY = _drawBarChart(doc, {
      title:  'Llamadas por disposición',
      labels: DISPOSITIONS_ORDER.map(d => DISPOSITION_LABELS[d]),
      values: DISPOSITIONS_ORDER.map(d => summary[d]),
      x: margin, y: doc.y, width: contentWidth, height: chartHeight,
    });
    doc.y = newY;
    doc.moveDown(0.6);
  }

  // Hourly distribution chart (#28)
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text('Distribución horaria');
  doc.moveDown(0.2);
  {
    const hourly = computeHourly(rows);
    const hasData = hourly.some(h => h.total > 0);
    if (!hasData) {
      drawNoDataMessage(doc);
    } else {
      const chartHeight = 130;
      if (doc.y + chartHeight > doc.page.height - margin) doc.addPage();
      const newY = _drawBarChart(doc, {
        title:  'Llamadas por hora del día',
        labels: hourly.map(h => String(h.hour).padStart(2, '0')),
        values: hourly.map(h => h.total),
        x: margin, y: doc.y, width: contentWidth, height: chartHeight,
        color: '#8b5cf6',
      });
      doc.y = newY;
      doc.moveDown(0.6);
    }
  }

  // Detail table
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text('Detalle de llamadas');
  doc.moveDown(0.2);
  if (rows.length === 0) {
    drawNoDataMessage(doc);
  } else {
    if (doc.y + 40 > doc.page.height - margin) doc.addPage();
    drawTable(doc, pdfHeaders, rows, rowKeys);
  }
}

/**
 * Render the body of the `extensions`/`trunks` reports.
 *
 * @param {PDFDocument} doc
 * @param {object} data
 * @param {Function} [_drawBarChart]      - injectable for testing
 * @param {Function} [_drawMultiBarChart] - injectable for testing
 */
function renderRankingBody(doc, data, _drawBarChart = drawBarChart, _drawMultiBarChart = drawMultiBarChart) {
  const margin = 40;
  const contentWidth = doc.page.width - margin * 2;
  const { rankings, type } = data;
  const label = type === 'extensions' ? 'extensiones' : 'troncales';

  // Total volume chart
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text(`Top ${label} por volumen de llamadas`);
  doc.moveDown(0.2);
  if (rankings.length === 0) {
    drawNoDataMessage(doc);
  } else {
    const chartHeight = 150;
    if (doc.y + chartHeight > doc.page.height - margin) doc.addPage();
    const newY = _drawBarChart(doc, {
      title:  `Total de llamadas por ${type === 'extensions' ? 'extensión' : 'troncal'}`,
      labels: rankings.map(r => r.name),
      values: rankings.map(r => r.total),
      x: margin, y: doc.y, width: contentWidth, height: chartHeight,
    });
    doc.y = newY;
    doc.moveDown(0.4);

    // Contestadas vs No Contestadas comparison (#28)
    const multiHeight = 150;
    if (doc.y + multiHeight > doc.page.height - margin) doc.addPage();
    const newY2 = _drawMultiBarChart(doc, {
      title:  `Contestadas vs No Contestadas por ${type === 'extensions' ? 'extensión' : 'troncal'}`,
      labels: rankings.map(r => r.name),
      series: [
        { label: 'Contestadas',    values: rankings.map(r => r.answered),  color: '#10b981' },
        { label: 'No Contestadas', values: rankings.map(r => r.no_answer), color: '#f59e0b' },
      ],
      x: margin, y: doc.y, width: contentWidth, height: multiHeight,
    });
    doc.y = newY2;
    doc.moveDown(0.6);
  }

  // Ranking table
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a5f').text(`Ranking de ${label}`);
  doc.moveDown(0.2);
  const rankingHeaders = type === 'extensions' ? RANKING_HEADERS_EXTENSIONS : RANKING_HEADERS_TRUNK;
  const rankingRowKeys = type === 'extensions' ? RANKING_ROW_KEYS_EXTENSIONS : RANKING_ROW_KEYS_TRUNK;
  if (rankings.length === 0) {
    drawNoDataMessage(doc);
  } else {
    if (doc.y + 40 > doc.page.height - margin) doc.addPage();
    drawTable(doc, rankingHeaders, rankings, rankingRowKeys);
  }
}

/**
 * Build a full report PDF and pipe it to the HTTP response.
 */
function buildReportPdf(res, { type, from, to, branding, data, filenameBase }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  doc.pipe(res);

  drawReportHeader(doc, { type, from, to, branding });

  if (type === 'executive') {
    renderExecutiveBody(doc, data);
  } else if (type === 'inbound' || type === 'outbound') {
    renderCallsBody(doc, data);
  } else {
    renderRankingBody(doc, data);
  }

  doc.end();
}

/**
 * Write header block rows at the top of an Excel worksheet.
 */
function writeXlsxHeaderBlock(worksheet, { title, companyName, subcompanyName, from, to }) {
  worksheet.addRow([title]).commit();
  worksheet.addRow([companyName]).commit();
  if (subcompanyName) {
    worksheet.addRow([subcompanyName]).commit();
  }
  worksheet.addRow([`Rango de fechas: ${from} — ${to}`]).commit();
  worksheet.addRow([`Generado: ${new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })}`]).commit();
  worksheet.addRow([]).commit();
}

/**
 * Write a data table to a worksheet. Writes a "Sin datos" row if empty.
 */
function writeXlsxTable(worksheet, headers, rows, rowKeys) {
  worksheet.addRow(headers).commit();
  if (rows.length === 0) {
    worksheet.addRow(['Sin datos para el rango seleccionado']).commit();
    return;
  }
  for (const r of rows) {
    worksheet.addRow(rowKeys.map(k => r[k] != null ? r[k] : '')).commit();
  }
}

/**
 * Write a 'Datos para gráfica' sheet with a note and pre-grouped data.
 * Documents the ExcelJS streaming limitation so the user knows to build
 * charts manually in Excel/Google Sheets.
 */
async function writeXlsxChartDataSheet(workbook, headers, rows, rowKeys, headerOpts) {
  const ws = workbook.addWorksheet('Datos para gráfica');
  writeXlsxHeaderBlock(ws, headerOpts);
  ws.addRow(['Datos pre-agrupados para crear gráficas en Excel o Google Sheets (ExcelJS streaming no soporta gráficas nativas)']).commit();
  ws.addRow([]).commit();
  writeXlsxTable(ws, headers, rows, rowKeys);
  await ws.commit();
}

/**
 * Build a full report workbook and stream it to the HTTP response.
 */
async function buildReportXlsx(res, { type, from, to, branding, data, filenameBase }) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
  const title = REPORT_TITLES[type] || 'Reporte';
  const headerOpts = { title, companyName: branding.companyName, subcompanyName: branding.subcompanyName || '', from, to };

  if (type === 'executive') {
    const { overallTotals, trend, inboundTotals, outboundTotals, topExtensions, topTrunks } = data;

    const wsResumen = workbook.addWorksheet('Resumen');
    writeXlsxHeaderBlock(wsResumen, headerOpts);
    writeXlsxTable(
      wsResumen,
      ['Métrica', 'Total', 'Entrantes', 'Salientes'],
      buildExecutiveSummaryRows(overallTotals, inboundTotals, outboundTotals),
      ['metric', 'total', 'inbound', 'outbound']
    );
    await wsResumen.commit();

    const wsTrend = workbook.addWorksheet('Tendencia');
    writeXlsxHeaderBlock(wsTrend, headerOpts);
    writeXlsxTable(wsTrend, ['Fecha', 'Total', 'Contestadas', 'No contestadas', 'Dur. media (min)'],
      trend, ['period_label', 'total', 'answered', 'no_answer', 'avg_duration']);
    await wsTrend.commit();

    const wsExt = workbook.addWorksheet('Top Extensiones');
    writeXlsxHeaderBlock(wsExt, headerOpts);
    writeXlsxTable(wsExt, RANKING_HEADERS_EXTENSIONS, topExtensions, RANKING_ROW_KEYS_EXTENSIONS);
    await wsExt.commit();

    const wsTrunks = workbook.addWorksheet('Top Troncales');
    writeXlsxHeaderBlock(wsTrunks, headerOpts);
    writeXlsxTable(wsTrunks, RANKING_HEADERS_TRUNK, topTrunks, RANKING_ROW_KEYS_TRUNK);
    await wsTrunks.commit();

    // Datos para gráfica — tendencia diaria (#28)
    await writeXlsxChartDataSheet(
      workbook,
      ['Período', 'Total', 'Contestadas', 'No Contestadas'],
      trend,
      ['period_label', 'total', 'answered', 'no_answer'],
      headerOpts
    );

  } else if (type === 'inbound' || type === 'outbound') {
    const { rows, summary } = data;
    const isOutbound  = type === 'outbound';
    const xlsxHeaders = isOutbound ? OUTBOUND_XLSX_HEADERS : INBOUND_XLSX_HEADERS;
    const rowKeys     = isOutbound ? OUTBOUND_ROW_KEYS     : INBOUND_ROW_KEYS;

    const wsResumen = workbook.addWorksheet('Resumen');
    writeXlsxHeaderBlock(wsResumen, headerOpts);
    writeXlsxTable(
      wsResumen,
      ['Disposición', 'Cantidad'],
      [
        { label: 'Total', value: summary.total },
        ...DISPOSITIONS_ORDER.map(d => ({ label: DISPOSITION_LABELS[d], value: summary[d] })),
      ],
      ['label', 'value']
    );
    await wsResumen.commit();

    const wsDetalle = workbook.addWorksheet('Detalle');
    writeXlsxHeaderBlock(wsDetalle, headerOpts);
    writeXlsxTable(wsDetalle, xlsxHeaders, rows, rowKeys);
    await wsDetalle.commit();

    // Datos para gráfica — distribución horaria (#28)
    await writeXlsxChartDataSheet(
      workbook,
      ['Hora', 'Total llamadas'],
      computeHourly(rows),
      ['hour', 'total'],
      headerOpts
    );

  } else {
    // extensions / trunks
    const { rankings } = data;
    const xlsxRankingHeaders = type === 'extensions' ? RANKING_HEADERS_EXTENSIONS : RANKING_HEADERS_TRUNK;

    const xlsxRankingRowKeys = type === 'extensions' ? RANKING_ROW_KEYS_EXTENSIONS : RANKING_ROW_KEYS_TRUNK;
    const wsRanking = workbook.addWorksheet('Ranking');
    writeXlsxHeaderBlock(wsRanking, headerOpts);
    writeXlsxTable(wsRanking, xlsxRankingHeaders, rankings, xlsxRankingRowKeys);
    await wsRanking.commit();

    // Datos para gráfica — contestadas vs no contestadas por nombre (#28)
    await writeXlsxChartDataSheet(
      workbook,
      ['Nombre', 'Total', 'Contestadas', 'No Contestadas'],
      rankings,
      ['name', 'total', 'answered', 'no_answer'],
      headerOpts
    );
  }

  await workbook.commit();
}

function buildExecutiveSummaryRows(overallTotals, inboundTotals, outboundTotals) {
  return [
    { metric: 'Total de llamadas',   total: overallTotals.total,        inbound: inboundTotals.total,        outbound: outboundTotals.total },
    { metric: 'Contestadas',         total: overallTotals.answered,     inbound: inboundTotals.ANSWERED,     outbound: outboundTotals.ANSWERED },
    { metric: 'No contestadas',      total: overallTotals.no_answer,    inbound: inboundTotals['NO ANSWER'], outbound: outboundTotals['NO ANSWER'] },
    { metric: 'Duración media (min)',total: overallTotals.avg_duration, inbound: '—',                        outbound: '—' },
  ];
}

module.exports = {
  toXlsx,
  toPdf,
  drawTable,
  drawBarChart,
  drawMultiBarChart,
  computeHourly,
  buildReportPdf,
  buildReportXlsx,
  renderExecutiveBody,
  renderCallsBody,
  renderRankingBody,
};
