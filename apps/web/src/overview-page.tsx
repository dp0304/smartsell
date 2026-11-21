import { RefreshCw } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { EntityTable } from '@smartsell/ui';
import { useCommandRead } from './workbench-data';
import { sections } from './catalog';
import { Empty, Failure, Status, useFormat } from './workbench-ui';
import type { Command, Payload } from './workbench-api';

interface Attention {
  provider: string;
  kind: string;
  severity: string;
  title: string;
  due_at?: string;
  resource: { module: string; kind: string; id: string };
  action: { route: string };
}
interface Today { as_of: string; total: number; items: Attention[]; providers: { key: string; status: string; as_of: string; total: number | null }[] }
interface Summary { period: { from: string; to: string; timezone: string }; cards: { key: string; availability: string; data: Payload | null }[] }

export function Overview({ wid, commands }: { wid: string; commands: Command[] }) {
  const { t, label, number, date, locale } = useFormat();
  const [params, setParams] = useSearchParams();
  const tabs = ['today', 'needs', 'health', 'summary'];
  const view = tabs.includes(params.get('view') ?? '') ? params.get('view')! : location.pathname.endsWith('/summary') ? 'summary' : 'today';
  const filters = { ...(params.get('from') ? { from: params.get('from') } : {}), ...(params.get('to') ? { to: params.get('to') } : {}) };
  const today = useCommandRead<Today>(wid, commands, 'workspace', 'overview_today', { limit: 100 }, view !== 'summary');
  const summary = useCommandRead<Summary>(wid, commands, 'workspace', 'overview_summary', filters, view === 'summary');
  const read = view === 'summary' ? summary : today;
  const items = today.data?.items ?? [];
  const base = `/w/${encodeURIComponent(wid)}`;
  function link(row: Attention) {
    const path = row.action.route.split('?')[0];
    const section = sections.find(section => path === `${base}/${section.path}` || path.startsWith(`${base}/${section.path}/`));
    if (!section || !('module' in section)) return row.title;
    const kind = section.views.find(kind => kind === row.resource.kind);
    const query = new URLSearchParams(kind ? { view: kind, record: row.resource.id } : {});
    return <Link to={`${base}/${section.path}?${query}`}>{row.title}</Link>;
  }
  return <>
    <header className="wb-pagehead"><div><p className="wb-kicker">{new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(Date.now())}</p><h1>{t('ui.overview')}</h1></div>
      <button onClick={() => void read.refetch()} disabled={!read.permitted || read.isFetching}><RefreshCw size={16} />{t('ui.retry')}</button></header>
    <div className="wb-tabs" aria-label={t('ui.controls')}>{tabs.map(key => <button key={key} aria-pressed={view === key} onClick={() => setParams({ view: key })}>{t(`ui.${key}`)}</button>)}</div>
    {!read.permitted ? <Empty>{t('ui.endpointUnavailable')}</Empty> : read.isError ? <Failure error={read.error} retry={() => void read.refetch()} /> : read.isPending ? <p role="status">{t('ui.loading')}</p> : null}
    {view === 'today' && today.data && <div className="wb-stats">{(['critical', 'high', 'normal', 'low'] as const).map(severity => <button className="wb-stat" key={severity} onClick={() => setParams({ view: 'needs', severity })}><Status value={severity} /><strong>{number(items.filter(item => item.severity === severity).length)}</strong><small>{t('ui.loadedItems')}</small></button>)}</div>}
    {view === 'health' && today.data && <section className="wb-card"><h2>{t('ui.health')}</h2><EntityTable records={today.data.providers} rowKey={row => row.key} columns={[
      { label: t('ui.queue'), cell: row => label('provider', row.key.replaceAll('.', '_')) }, { label: t('ui.status'), cell: row => <Status value={row.status} /> },
      { label: t('ui.count'), cell: row => row.total == null ? '—' : number(row.total) }, { label: t('ui.updated'), cell: row => date(row.as_of, true) },
    ]} /></section>}
    {(view === 'today' || view === 'needs') && today.data && <section className="wb-card"><header className="wb-cardhead"><h2>{t('ui.needs')}</h2><span>{t('ui.loaded', { loaded: number(items.length), total: number(today.data.total) })}</span>{params.has('severity') && <button onClick={() => setParams({ view: 'needs' })}>{t('ui.all')}</button>}</header>
      {today.data.providers.some(row => row.status !== 'available') && <p className="wb-note">{t('ui.partialOverview')}</p>}
      {items.filter(row => !params.has('severity') || row.severity === params.get('severity')).length ? <EntityTable records={items.filter(row => !params.has('severity') || row.severity === params.get('severity')).slice(0, view === 'today' ? 8 : undefined)} rowKey={row => `${row.kind}:${row.resource.id}`} columns={[
        { label: t('ui.record'), cell: link }, { label: t('ui.queue'), cell: row => label('attention', row.kind) }, { label: t('ui.status'), cell: row => <Status value={row.severity} /> }, { label: t('field.due_at'), cell: row => date(row.due_at ?? '', true) },
      ]} /> : <Empty>{t('ui.empty')}</Empty>}
    </section>}
    {view === 'summary' && read.permitted && <><form className="wb-filter wb-card" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); setParams({ view: 'summary', from: String(form.get('from')), to: String(form.get('to')) }); }}>
      <label>{t('ui.from')}<input name="from" type="date" defaultValue={filters.from ?? ''} required /></label><label>{t('ui.toExclusive')}<input name="to" type="date" defaultValue={filters.to ?? ''} required /></label><button>{t('ui.apply')}</button>
    </form>{summary.data && <section className="wb-card"><header className="wb-cardhead"><h2>{t('ui.summary')}</h2><span>{summary.data.period.from} → {summary.data.period.to} · {summary.data.period.timezone}</span></header><EntityTable records={summary.data.cards} rowKey={row => row.key} columns={[
      { label: t('ui.record'), cell: row => label('metric', row.key) }, { label: t('ui.status'), cell: row => <Status value={String(row.data?.availability ?? row.availability)} /> },
      { label: t('ui.result'), cell: row => row.data && ('output_count' in row.data ? <>{t('ui.output')}: {number(Number(row.data.output_count))} · {t('ui.onTime')}: {typeof row.data.on_time_rate === 'number' ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(row.data.on_time_rate) : '—'}</> : <details><summary>{t('ui.data')}</summary><pre>{JSON.stringify(row.data, null, 2)}</pre></details>) },
    ]} /></section>}</>}
  </>;
}
