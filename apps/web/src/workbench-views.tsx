import { useState } from 'react';
import { ChevronLeft, ChevronRight, Filter, Plus, RefreshCw } from 'lucide-react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { Command, Entity, Payload, Workspace } from './workbench-api';
import { asEntity, useCommandRead, useRecordList } from './workbench-data';
import { actions, type Section } from './catalog';
import { commandKey } from './command-panel';
import { RecordDetail } from './record-detail';
import { matchesFilters, RecordFilters, type Filters } from './record-filters';
import { Detail, Dialog, Empty, Failure, recordName, Status, statusOf, useFormat } from './workbench-ui';
import { ContentBoard } from './workbench-content';
import { WorkbenchAssetPreview, WorkbenchMediaUpload } from './workbench-media-upload';

type OpenCommand = (command: Command, record?: Entity) => void;
function RecordTable({ rows, select }: { rows: Entity[]; select: (row: Entity) => void }) {
  const { t, date } = useFormat();
  return <table><thead><tr><th>{t('ui.record')}</th><th>{t('ui.status')}</th><th>{t('ui.updated')}</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><button className="wb-text" onClick={() => select(row)}>{recordName(row)}</button></td><td><Status value={statusOf(row)} /></td><td>{date(row.updated_at, true)}</td></tr>)}</tbody></table>;
}

type CalendarMode = 'day' | 'week' | 'month' | 'list';
const localDay = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const monday = (date: Date) => localDay(date, -((date.getDay() + 6) % 7));

function Calendar({ rows, select, view }: { rows: Entity[]; select: (row: Entity) => void; view: Exclude<CalendarMode, 'list'> }) {
  const { locale, t } = useFormat();
  const [day, setDay] = useState(() => new Date());
  const start = view === 'day' ? localDay(day, 0) : view === 'week' ? monday(day) : monday(new Date(day.getFullYear(), day.getMonth(), 1));
  const count = view === 'day' ? 1 : view === 'week' ? 7 : 42;
  const days = Array.from({ length: count }, (_, index) => localDay(start, index));
  const dayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const timeFormat = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });
  const title = view === 'month' ? new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(day) : dayFormat.formatRange(start, days[count - 1]);
  const move = (offset: number) => setDay(current => view === 'month' ? new Date(current.getFullYear(), current.getMonth() + offset, 1) : localDay(current, offset * count));
  return <>
    <div className="wb-filter"><button className="wb-icon" aria-label={t('ui.previousPeriod')} onClick={() => move(-1)}><ChevronLeft size={18} /></button>
      <button onClick={() => setDay(new Date())}>{t('ui.currentPeriod')}</button><button className="wb-icon" aria-label={t('ui.nextPeriod')} onClick={() => move(1)}><ChevronRight size={18} /></button><span>{title}</span></div>
    <div className={`wb-calendar ${view === 'day' ? 'wb-day' : ''}`}>{days.map(date => <section key={date.toISOString()}>
      <h3>{dayFormat.format(date)}</h3>{rows.flatMap(row => {
        const time = new Date(String(row.data.scheduled_at ?? ''));
        return time >= date && time < localDay(date, 1) ? [<button key={row.id} onClick={() => select(row)}><small>{timeFormat.format(time)}</small><strong>{recordName(row)}</strong><Status value={statusOf(row)} /></button>] : [];
      })}
    </section>)}</div>
  </>;
}

function Inbox({ wid, rows, selected, select, commands, open }: { wid: string; rows: Entity[]; selected?: Entity; select: (row: Entity) => void; commands: Command[]; open: OpenCommand }) {
  const { t, date, label } = useFormat();
  const [cursor, setCursor] = useState<string>();
  const messages = useCommandRead<{ messages: unknown[]; notes: unknown[]; next_cursor?: string }>(wid, commands, 'inbox', 'get_conversation', { conversation_id: selected?.id, limit: 100, ...(cursor ? { after: cursor } : {}) }, Boolean(selected));
  const thread = messages.data?.messages.flatMap(value => asEntity(value, 'inbox', 'message') ?? []);
  const notes = messages.data?.notes.flatMap(value => asEntity(value, 'inbox', 'internal_note') ?? []);
  const body = (row: Entity) => String((row.data.untrusted_content as Payload | undefined)?.body_text ?? row.data.body_text ?? row.data.body ?? row.data.text ?? '—');
  const available = commands.filter(command => command.module === 'inbox' && actions[commandKey(command)]?.target === 'conversation' && command.action !== 'get_conversation');
  return <div className="wb-inbox"><div className="wb-queue">{rows.map(row => <button key={row.id} aria-pressed={row.id === selected?.id} onClick={() => select(row)}><strong>{recordName(row)}</strong><Status value={statusOf(row)} /></button>)}</div>
    {selected ? <><section className="wb-thread"><h2>{recordName(selected)}</h2>{messages.permitted && messages.isPending && <p>{t('ui.loading')}</p>}{messages.isError && <Failure error={messages.error} retry={() => void messages.refetch()} />}{thread?.length === 0 && <Empty>{t('ui.noMessages')}</Empty>}{thread?.map(row => <article key={row.id}><small>{date(String(row.data.sent_at ?? row.created_at), true)}</small><p>{body(row)}</p></article>)}{messages.data?.next_cursor && <button onClick={() => setCursor(messages.data?.next_cursor)}>{t('ui.nextMessages')}</button>}{cursor && <button onClick={() => setCursor(undefined)}>{t('ui.firstMessages')}</button>}{Boolean(notes?.length) && <section className="wb-note"><h3>{t('ui.internalNotes')}</h3>{notes?.map(row => <article key={row.id}><p>{body(row)}</p></article>)}</section>}</section><aside className="wb-context"><h2>{t('ui.context')}</h2><Detail record={selected} /><div className="wb-inline-actions">{available.map(command => <button key={command.action} onClick={() => open(command, selected)}>{label('command', commandKey(command), actions[commandKey(command)]?.label)}</button>)}</div></aside></> : <div className="wb-thread"><Empty>{t('ui.selectConversation')}</Empty></div>}
  </div>;
}

export function ModulePage({ wid, workspace, userId, section, commands, open }: {
  wid: string; workspace: Workspace; userId: string; section: Extract<Section, { module: string }>; commands: Command[]; open: OpenCommand;
}) {
  const { t, label, number } = useFormat();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [filters, setFilters] = useState<Filters>({});
  const [calendar, setCalendar] = useState<CalendarMode>('week');
  const { pathname } = useLocation();
  const tail = pathname.split('/').slice(3);
  const routeKinds: Record<string, string> = { ideas: 'idea', items: 'content_item', stores: 'store', products: 'product', imports: 'import_batch', sources: 'data_source', health: 'quality_issue', metrics: 'metric_definition', manual: 'execution_task', targets: 'publish_target', c: 'conversation', markets: 'market', members: 'member' };
  const defaultKind = pathname.split('/')[3] === 'posts' ? 'platform_post' : routeKinds[tail[0]];
  const kind = section.views.find(value => value === (params.get('view') ?? defaultKind)) ?? section.views[0];
  const rowId = params.get('record') ?? (defaultKind ? tail[1] : undefined);
  const inboxView = params.get('queue') ?? 'all';
  const read = useRecordList(wid, commands, section.module, kind, kind === 'conversation' ? { limit: 200, view: inboxView } : {});
  const scoped = commands.filter(item => item.module === section.module && actions[commandKey(item)]);
  const active = read.data?.find(row => row.id === rowId);
  const primary = scoped.filter(item => !actions[commandKey(item)].target && actions[commandKey(item)].tab === kind)
    .sort((left, right) => Number(right.action.includes('create')) - Number(left.action.includes('create'))).slice(0, 3);
  const states = [...new Set(read.data?.map(statusOf).filter(Boolean))].sort();
  const filtered = read.data?.filter(row => matchesFilters(row, filters) && (!status || statusOf(row) === status) && `${recordName(row)} ${row.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  const select = (row: Entity) => { const next = new URLSearchParams(params); next.set('view', kind); next.set('record', row.id); setParams(next); };
  const close = () => { const next = new URLSearchParams(params); next.set('view', kind); next.delete('record'); setParams(next); };
  const content = section.module === 'content' && kind === 'content_item';
  const board = content && params.get('layout') === 'board';
  const inbox = section.path === 'inbox' && kind === 'conversation';
  return <><div className="wb-pagehead"><div><p className="wb-kicker">{t(`nav.${section.group}`)}</p><h1>{t(`nav.${section.path}`)}</h1></div><div className="wb-inline-actions">{primary.map(command => <button className="wb-primary" key={command.action} onClick={() => open(command)}><Plus size={16} />{label('command', commandKey(command), actions[commandKey(command)]?.label)}</button>)}</div></div>
    {section.views.length > 1 && <div className="wb-tabs" aria-label={t('ui.controls')}>{section.views.map(value => <button key={value} aria-pressed={value === kind} onClick={() => { setStatus(''); setSearch(''); setFilters({}); setParams({ ...(params.has('source') && { source: params.get('source')! }), view: value }); }}>{label('kind', value)}</button>)}</div>}
    {section.module === 'asset' && kind === 'asset' && <WorkbenchMediaUpload wid={wid} commands={commands} />}
    <section className="wb-card"><div className="wb-filter">{inbox && <select aria-label={t('ui.queue')} value={inboxView} onChange={event => setParams({ ...(params.has('source') && { source: params.get('source')! }), view: kind, queue: event.target.value })}>{['all', 'unassigned', 'mine', 'open', 'waiting', 'snoozed', 'resolved'].map(value => <option key={value} value={value}>{label('queue', value)}</option>)}</select>}<label><Filter size={16} /><input type="search" aria-label={t('ui.search')} placeholder={t('ui.search')} value={search} onChange={event => setSearch(event.target.value)} /></label><select aria-label={t('ui.status')} value={status} onChange={event => setStatus(event.target.value)}><option value="">{t('ui.all')}</option>{states.map(value => <option key={value} value={value}>{label('state', value)}</option>)}</select>{read.data && <span>{number(filtered.length)} {t('ui.count')}</span>}{section.path === 'calendar' && <select aria-label={t('nav.calendar')} value={calendar} onChange={event => setCalendar(event.target.value as CalendarMode)}>{(['day', 'week', 'month', 'list'] as const).map(mode => <option key={mode} value={mode}>{t(`ui.${mode}`)}</option>)}</select>}{content && <button aria-pressed={board} onClick={() => { const next = new URLSearchParams(params); if (board) next.delete('layout'); else next.set('layout', 'board'); setParams(next); }}>{label('ui', 'productionBoard', ['製作看板', 'Production board', '制作看板'])}</button>}<button className="wb-icon wb-push" aria-label={t('ui.retry')} disabled={read.isFetching} onClick={() => void read.refetch()}><RefreshCw size={16} /></button></div>
      {read.data && <RecordFilters key={kind} wid={wid} userId={userId} role={workspace.role} resourceType={`${section.module}.${kind}`}
        storageKey={`smartsell.filters:${wid}:${section.module}:${kind}`} rows={read.data} filters={filters} change={setFilters} />}
      {read.isPending ? <p className="wb-note" role="status">{t('ui.loading')}</p> : read.isError ? <div className="wb-note"><Failure error={read.error} retry={() => void read.refetch()} /></div> : !filtered.length ? <Empty>{t(search || status || Object.values(filters).some(Boolean) ? 'ui.emptySearch' : inbox && inboxView === 'all' ? 'ui.noConnection' : kind === 'sync_run' ? 'ui.notSynced' : 'ui.empty')}</Empty> : inbox ? <Inbox key={active?.id ?? "none"} wid={wid} rows={filtered} selected={active} select={select} commands={commands} open={open} /> : section.path === 'calendar' && calendar !== 'list' ? <Calendar rows={filtered} select={select} view={calendar} /> : board ? <ContentBoard wid={wid} rows={filtered} commands={commands} select={select} /> : <RecordTable rows={filtered} select={select} />}
    </section>
    {active && !inbox && <Dialog title={recordName(active)} close={close}>{section.module === 'asset' && kind === 'asset' && <WorkbenchAssetPreview key={active.id} wid={wid} asset={active} commands={commands} />}<RecordDetail key={active.id} wid={wid} role={workspace.role} initial={active} commands={commands} open={open} /></Dialog>}
  </>;
}
