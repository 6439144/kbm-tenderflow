// Small, dependency-free SVG charts (bar, line, donut) for dashboards and analytics.
// Each chart is a <figure> with a caption, an SVG with role="img" + an accessible label, native tooltips on every
// mark, direct value labels, and a data-table fallback (<details>). Empty data renders an explicit "no data yet".
import { useId, type ReactNode } from 'react';
import { useI18n } from '../../i18n';

/** Categorical slots in fixed order (validated light-mode palette; colour follows the entity, never its rank). */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

export interface Datum { key: string; label: string; value: number; color?: string; hint?: string }

const fmtNum = (lang: string, n: number, digits = 0) =>
  new Intl.NumberFormat(lang === 'ar' ? 'ar-KW' : 'en-GB', { maximumFractionDigits: digits }).format(n);

function DataTable({ head, rows, caption }: { head: string[]; rows: (string | number)[][]; caption: string }) {
  const { t } = useI18n();
  return (
    <details className="insight-table-toggle">
      <summary>{t('insight.chart.showTable')}</summary>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Frame({ title, subtitle, children, empty }: { title: string; subtitle?: ReactNode; children: ReactNode; empty: boolean }) {
  const { t } = useI18n();
  return (
    <figure className="insight-chart">
      <figcaption>
        <strong>{title}</strong>
        {subtitle ? <span className="muted small">{subtitle}</span> : null}
      </figcaption>
      {empty ? <p className="insight-nodata">{t('insight.noData')}</p> : children}
    </figure>
  );
}

/** Horizontal bars (mirrors in RTL). One series → the entity colour; labels on the start side, values at the bar end. */
export function BarChart({ title, subtitle, data, valueLabel, digits = 0, unit = '' }: {
  title: string; subtitle?: ReactNode; data: Datum[]; valueLabel: string; digits?: number; unit?: string;
}) {
  const { t, lang } = useI18n();
  const id = useId();
  const rtl = lang === 'ar';
  const W = 640; const labelW = 210; const valueW = 70; const rowH = 30; const barH = 16;
  const H = Math.max(rowH, data.length * rowH) + 6;
  const max = Math.max(0, ...data.map((d) => d.value));
  const plotW = W - labelW - valueW;
  const empty = data.length === 0 || data.every((d) => d.value === 0);
  const fmt = (n: number) => `${fmtNum(lang, n, digits)}${unit}`;
  return (
    <Frame title={title} subtitle={subtitle} empty={empty}>
      <svg className="insight-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} preserveAspectRatio="xMinYMin meet">
        <title id={`${id}-t`}>{`${title}: ${data.map((d) => `${d.label} ${fmt(d.value)}`).join('; ')}`}</title>
        {data.map((d, i) => {
          const y = i * rowH + 4;
          const w = max > 0 ? Math.max(d.value > 0 ? 3 : 0, (d.value / max) * plotW) : 0;
          const x = rtl ? W - labelW - w : labelW;
          const lx = rtl ? W - labelW + 10 : labelW - 10;
          const vx = rtl ? x - 6 : x + w + 6;
          return (
            <g key={d.key} className="insight-mark">
              <title>{`${d.label}: ${fmt(d.value)}${d.hint ? ` — ${d.hint}` : ''}`}</title>
              <rect x={0} y={y - 4} width={W} height={rowH} fill="transparent" />
              <text x={lx} y={y + barH - 3} textAnchor="end" direction={rtl ? 'rtl' : 'ltr'} className="insight-axis-label">
                {d.label.length > 30 ? `${d.label.slice(0, 29)}…` : d.label}
              </text>
              <rect x={x} y={y} width={w} height={barH} rx={4} fill={d.color ?? 'var(--primary)'} />
              <text x={vx} y={y + barH - 3} textAnchor={rtl ? 'end' : 'start'} className="insight-value">{fmt(d.value)}</text>
            </g>
          );
        })}
      </svg>
      <DataTable caption={title} head={[t('insight.chart.item'), valueLabel]} rows={data.map((d) => [d.label, fmt(d.value)])} />
    </Frame>
  );
}

/** Line over time (left-to-right in both languages: dates read chronologically). */
export function LineChart({ title, subtitle, points, valueLabel }: { title: string; subtitle?: ReactNode; points: { x: string; label: string; y: number }[]; valueLabel: string }) {
  const { t, lang } = useI18n();
  const id = useId();
  const W = 640; const H = 200; const padL = 36; const padR = 12; const padT = 12; const padB = 28;
  const max = Math.max(1, ...points.map((p) => p.y));
  const step = points.length > 1 ? (W - padL - padR) / (points.length - 1) : 0;
  const xy = points.map((p, i) => [padL + i * step, padT + (H - padT - padB) * (1 - p.y / max)] as const);
  const path = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const total = points.reduce((a, p) => a + p.y, 0);
  const ticks = [0, Math.round(max / 2), max];
  const peak = points.reduce((b, p, i) => (p.y > points[b].y ? i : b), 0);
  return (
    <Frame title={title} subtitle={subtitle} empty={points.length === 0 || total === 0}>
      <svg className="insight-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} style={{ direction: 'ltr' }}>
        <title id={`${id}-t`}>{`${title}: ${fmtNum(lang, total)} (${points[0]?.label} – ${points[points.length - 1]?.label})`}</title>
        {ticks.map((v) => {
          const y = padT + (H - padT - padB) * (1 - v / max);
          return (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} className="insight-gridline" />
              <text x={padL - 6} y={y + 4} textAnchor="end" className="insight-tick">{fmtNum(lang, v)}</text>
            </g>
          );
        })}
        {points.length > 0 && [0, Math.floor((points.length - 1) / 2), points.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => (
          <text key={i} x={xy[i][0]} y={H - 8} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} className="insight-tick">{points[i].label}</text>
        ))}
        <path d={path} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {xy.map(([x, y], i) => (
          <g key={points[i].x} className="insight-mark">
            <title>{`${points[i].label}: ${fmtNum(lang, points[i].y)}`}</title>
            <rect x={x - step / 2} y={padT} width={Math.max(step, 8)} height={H - padT - padB} fill="transparent" />
            <circle cx={x} cy={y} r={points[i].y > 0 ? 3.5 : 2} fill="var(--primary)" stroke="var(--surface)" strokeWidth={2} className="insight-dot" />
          </g>
        ))}
        {points[peak]?.y > 0 && (
          <text x={xy[peak][0]} y={Math.max(10, xy[peak][1] - 8)} textAnchor="middle" className="insight-value">{fmtNum(lang, points[peak].y)}</text>
        )}
      </svg>
      <DataTable caption={title} head={[t('insight.chart.date'), valueLabel]} rows={points.map((p) => [p.label, fmtNum(lang, p.y)])} />
    </Frame>
  );
}

/** Donut for a part-to-whole split with a legend (identity never by colour alone: label + value in the legend). */
export function DonutChart({ title, subtitle, data, valueLabel }: { title: string; subtitle?: ReactNode; data: Datum[]; valueLabel: string }) {
  const { t, lang } = useI18n();
  const id = useId();
  const shown = data.filter((d) => d.value > 0);
  const total = shown.reduce((a, d) => a + d.value, 0);
  const R = 70; const r = 46; const C = 90;
  let acc = 0;
  const arcs = shown.map((d, i) => {
    const a0 = (acc / total) * Math.PI * 2; acc += d.value;
    const a1 = (acc / total) * Math.PI * 2;
    const gap = shown.length > 1 ? 0.012 : 0;
    const p = (rad: number, a: number) => [C + rad * Math.sin(a), C - rad * Math.cos(a)];
    const large = a1 - a0 - 2 * gap > Math.PI ? 1 : 0;
    const [x0, y0] = p(R, a0 + gap); const [x1, y1] = p(R, a1 - gap); const [x2, y2] = p(r, a1 - gap); const [x3, y3] = p(r, a0 + gap);
    const full = shown.length === 1;
    const dPath = full
      ? `M${C},${C - R} A${R},${R} 0 1 1 ${C - 0.01},${C - R} Z M${C},${C - r} A${r},${r} 0 1 0 ${C + 0.01},${C - r} Z`
      : `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z`;
    return { d, path: dPath, color: d.color ?? SERIES[i % SERIES.length] };
  });
  return (
    <Frame title={title} subtitle={subtitle} empty={total === 0}>
      <div className="insight-donut">
        <svg viewBox="0 0 180 180" role="img" aria-labelledby={`${id}-t`} className="insight-donut-svg">
          <title id={`${id}-t`}>{`${title}: ${shown.map((a) => `${a.label} ${fmtNum(lang, a.value)}`).join('; ')}`}</title>
          {arcs.map((a) => (
            <path key={a.d.key} d={a.path} fill={a.color} fillRule="evenodd" className="insight-mark">
              <title>{`${a.d.label}: ${fmtNum(lang, a.d.value)} (${Math.round((a.d.value / total) * 100)}%)`}</title>
            </path>
          ))}
          <text x={C} y={C + 2} textAnchor="middle" className="insight-donut-total">{fmtNum(lang, total)}</text>
          <text x={C} y={C + 20} textAnchor="middle" className="insight-tick">{t('insight.chart.total')}</text>
        </svg>
        <ul className="insight-legend">
          {arcs.map((a) => (
            <li key={a.d.key}>
              <span className="insight-swatch" style={{ background: a.color }} aria-hidden="true" />
              <span>{a.d.label}</span>
              <strong>{fmtNum(lang, a.d.value)}</strong>
            </li>
          ))}
        </ul>
      </div>
      <DataTable caption={title} head={[t('insight.chart.item'), valueLabel]} rows={shown.map((d) => [d.label, fmtNum(lang, d.value)])} />
    </Frame>
  );
}

/** A tile in the existing dashboard style (.tiles/.tile so demo tours keep finding them). */
export function Tile({ value, label, tone, hint, to }: { value: ReactNode; label: ReactNode; tone?: 'ok' | 'warn' | 'danger'; hint?: ReactNode; to?: ReactNode }) {
  return (
    <div className={`tile insight-tile ${tone ? `insight-tile-${tone}` : ''}`}>
      <div className="tile-num">{value}</div>
      <div className="tile-label">{label}</div>
      {hint ? <div className="muted small">{hint}</div> : null}
      {to}
    </div>
  );
}

/** Days → readable duration ("3.2 d" / "5 h" / "12 min"). */
export function useDuration() {
  const { t, lang } = useI18n();
  return (d: number | null | undefined) => {
    if (d === null || d === undefined) return '—';
    if (d >= 1) return t('insight.dur.days', { n: fmtNum(lang, d, 1) });
    const h = d * 24;
    if (h >= 1) return t('insight.dur.hours', { n: fmtNum(lang, h, 1) });
    return t('insight.dur.minutes', { n: fmtNum(lang, Math.max(0, h * 60), 0) });
  };
}

/** CSV download of a table (UTF-8 with BOM so Excel shows Arabic correctly). Values come straight from the API. */
export function downloadCsv(name: string, head: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v);
    // Spreadsheet formula injection: a text cell must never start with = + - @ (numbers are written as numbers).
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name.endsWith('.csv') ? name : `${name}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
