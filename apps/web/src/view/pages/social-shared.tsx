import { useSearchParams } from 'react-router-dom';
import {
  AvailabilityTag, CopyButton, Glyph, formatMeasure, intlLocale, isNum, metricDelta, type Metric, type Tuple, type Unit,
} from '@smartsell/ui';
import { useView } from '../data/use-view';
import type { PlanCard } from '../data/types';
import { useText } from '../parts';
import type { PlanInfo } from './ads-logic';
import './social.css';

// Building blocks shared by the social and ads pages (page-local; not part of the shared view kit).

const text = {
  noBaseline: ['無前期可比', 'No prior period', '无前期可比'], vsPrevious: ['較前期', 'vs prior period', '较前期'], tellAgent: ['請你的 Agent：', 'Tell your agent:', '请你的 Agent：'],
} satisfies Record<string, Tuple>;

/**
 * KPI tile with the same look as the shared KpiTile, plus an absolute change (for counts such as followers)
 * and a coverage note (“2 of 3 accounts”), so a partial total never reads as the whole.
 */
export function MeasureTile({ label, metric, unit = 'count', currency, goodDirection = 'up', delta, compare = true, note }: {
  label: string; metric: Metric | null | undefined; unit?: Unit; currency?: string | null; goodDirection?: 'up' | 'down' | 'none';
  delta?: number | null; compare?: boolean; note?: string | null;
}) {
  const { l, lang } = useText();
  const value = metric?.value;
  const known = isNum(value);
  const availability = metric?.availability ?? 'not_collected';
  const ratio = known && compare ? metricDelta(metric) : null;
  const sign = isNum(delta) ? Math.sign(delta) : ratio === null ? 0 : Math.sign(ratio);
  const direction = sign > 0 ? 'up' : sign < 0 ? 'down' : null;
  const tone = !direction || goodDirection === 'none' ? 'neutral' : direction === goodDirection ? 'good' : 'serious';
  const locale = intlLocale(lang);
  const pct = ratio === null ? null : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(ratio);
  const abs = isNum(delta) ? new Intl.NumberFormat(locale, { signDisplay: 'exceptZero', maximumFractionDigits: 0 }).format(delta) : null;
  const showChange = known && compare && (abs !== null || pct !== null);
  return <article className="vs-kpi">
    <span className="vs-kpi-label">{label}</span>
    <strong className={known ? 'vs-kpi-value' : 'vs-kpi-value unknown'}>{known ? formatMeasure(value, unit, currency, lang, true) : '—'}</strong>
    <span className="vs-kpi-meta">
      {(!known || availability !== 'observed') && <AvailabilityTag availability={availability} />}
      {known && compare && (showChange ? <span className={`vs-delta tone-${tone}`}>{direction && <Glyph name={direction} size={12} />}
        {abs ?? pct}{abs !== null && pct !== null && <span className="vsx-delta-pct">{lang === 'en' ? ` (${pct})` : `（${pct}）`}</span>}<small>{l(text.vsPrevious)}</small></span>
        : <small className="muted">{l(text.noBaseline)}</small>)}
    </span>
    {note && <small className="vsx-kpi-note">{note}</small>}
  </article>;
}

/** A table cell value: the number, or what is known about why it is missing. Estimates keep their tag. */
export function MetricValue({ metric, unit = 'count', currency }: { metric: Metric | null | undefined; unit?: Unit; currency?: string | null }) {
  const { lang } = useText();
  if (!metric || !isNum(metric.value)) return <AvailabilityTag availability={metric?.availability ?? 'not_collected'} />;
  return <span className="vsx-value">{formatMeasure(metric.value, unit, currency, lang, true)}{metric.availability === 'estimated' && <AvailabilityTag availability="estimated" />}</span>;
}

export function Notices({ items, tone = 'warning' }: { items: readonly string[]; tone?: 'warning' | 'info' }) {
  if (!items.length) return null;
  return <ul className={`vsx-notices ${tone}`} role="note">{items.map(item => <li key={item}><Glyph name={tone === 'warning' ? 'warning' : 'info'} size={14} /><span>{item}</span></li>)}</ul>;
}

/** A compact “ask your agent” line for a gap inside a section (the full AgentPrompt leads empty pages). */
export function AskAgent({ title, prompt }: { title: string; prompt: string }) {
  const { l, lang } = useText();
  return <div className="vsx-ask">
    <p>{title}</p>
    <p className="vsx-ask-line"><Glyph name="bot" /><span className="muted">{l(text.tellAgent)}</span><q>{lang === 'en' ? prompt : `「${prompt}」`}</q></p>
    <CopyButton text={prompt} className="vs-btn ghost" />
  </div>;
}

/** Single-choice toggle buttons (aria-pressed), styled like the filter chips. */
export function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  return <div className="vs-filter-row vsx-choice" role="group" aria-label={label}>
    {options.map(option => <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

/** A page-local URL parameter (kept in the link, replaced in history so Back leaves the page). */
export function useParam(name: string): [string | null, (value: string | null) => void] {
  const [params, setParams] = useSearchParams();
  return [params.get(name), value => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value); else next.delete(name);
    setParams(next, { replace: true });
  }];
}

/** Plan names and dates by id, read from the same cached plans view the Plans page uses. */
export function usePlans(brandId: string | undefined): Map<string, PlanInfo> {
  const read = useView<PlanCard[]>('/views/plans', { brand_id: brandId }, { allPages: true });
  const rows = Array.isArray(read.value) ? read.value : [];
  return new Map(rows.filter(row => row && typeof row.id === 'string').map(row => [row.id, { id: row.id, name: row.name || row.id, starts_at: row.starts_at ?? null, ends_at: row.ends_at ?? null }]));
}
