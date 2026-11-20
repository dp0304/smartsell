import { Activity, ArrowRight, Bell, CalendarDays, CheckCircle2, Circle, CircleAlert, ClipboardList, Layers3, Mail, Package, Pencil, Store } from 'lucide-react';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { EmptyState, EntityTable, Panel, Pill } from '@smartsell/ui';
import { ReadState, callOperation, findOperation, recordRows, stringValue, useApi, useRead, wsKey } from './api';
import { useCopy } from './i18n';
import { setupLabel, setupStepNames, setupStepRoutes } from './workspace-onboarding';
import { TermsRenewal } from './workspace-terms-renewal';
import './dashboard-aurora.css';

const destinations: Record<string, [string, string]> = {
  work_item: ['settings/brands', 'work'], approval_request: ['approvals', 'approvals'], publish_target: ['calendar', 'targets'],
  execution_task: ['execution', 'tasks'], conversation: ['inbox', 'conversations'], notification: ['settings/brands', 'notifications'],
  data_source: ['data', 'sources'], connection: ['settings/accounts', 'connections'], connector_device: ['settings/accounts', 'devices'],
  social_account: ['settings/accounts', 'accounts'], account_block: ['settings/accounts', 'blocks'], listing: ['commerce', 'listings'],
};

const steps = [
  ['workspace', 'settings/brands', '/brands', Store], ['campaign', 'campaigns', '/campaigns', Layers3],
  ['commerce', 'commerce', '/products', Package], ['content', 'content', '/content-items', Pencil],
  ['planning', 'calendar', '/calendar', CalendarDays], ['execution', 'execution', '/execution-tasks', Activity],
  ['inbox', 'inbox', '/conversations', Bell], ['analytics', 'reports', '/reports', ClipboardList],
] as const;

// Steps re-checked during this page session, so the checklist reflects work done elsewhere without repeated writes.
const rechecked = new Set<string>();

function SetupChecklist() {
  const { label } = useCopy();
  const api = useApi();
  const client = useQueryClient();
  const read = useRead('/onboarding/:flow', ['initial_setup_v1'], {}, 'workspace');
  const rows = recordRows(read.data?.data) ?? [];
  const check = findOperation(api, 'POST', '/onboarding/:flow/steps/:step/check', 'workspace');
  const pending = rows.filter(row => row.status !== 'done' && row.status !== 'skipped').map(row => stringValue(row.step_key))
    .filter(key => key && !rechecked.has(`${api.ws}:${key}`));
  useEffect(() => {
    if (!check || !pending.length) return;
    for (const key of pending) rechecked.add(`${api.ws}:${key}`);
    void (async () => {
      for (const key of pending) await callOperation(api, check, ['initial_setup_v1', key], { body: { only_if_passed: true } }).catch(() => undefined);
      await client.invalidateQueries({ queryKey: wsKey(api.ws) });
    })();
  }, [api, check, client, pending.join(',')]);
  const finished = rows.filter(row => row.status === 'done' || row.status === 'skipped').length;
  if (!read.data || !rows.length || finished === rows.length) return null;
  const base = `/w/${encodeURIComponent(api.ws)}`;
  return <Panel><div className="panel-head"><h2>{label(['開始使用 SmartSell', 'Get started with SmartSell'])}</h2>
    <span className="setup-progress"><meter min={0} max={rows.length} value={finished} />{label([`已完成 ${finished} / ${rows.length}`, `${finished} of ${rows.length} done`])}
      <Link to={`${base}/setup`}>{label(['查看全部', 'View all'])}</Link></span></div>
    <ol className="setup-steps">{rows.map(row => {
      const key = stringValue(row.step_key);
      const done = row.status === 'done' || row.status === 'skipped';
      const name = setupStepNames[key];
      return <li key={key} className={done ? 'done' : undefined}>
        <span>{done ? <CheckCircle2 size={17} className="step-done" aria-hidden="true" /> : <Circle size={17} className="step-todo" aria-hidden="true" />}{name ? label(name) : key}</span>
        {!done && setupStepRoutes[key] && <Link to={`${base}/${setupStepRoutes[key]}`}>{label(['去完成', 'Do it'])} →</Link>}
      </li>;
    })}</ol></Panel>;
}

export function Dashboard({ view }: { view: 'today' | 'summary' | 'personal' }) {
  const { t, locale, label } = useCopy();
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const base = `/w/${encodeURIComponent(api.ws)}`;
  const workspace = api.session.workspaces.find(item => item.id === api.ws);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const summary = view === 'summary';
  const tab = view === 'today' ? params.get('tab') : undefined;
  const read = useRead(summary ? '/overview/summary' : view === 'personal' ? '/me/inbox' : '/overview/today', [], { ...(summary ? { from, to } : { limit: '100' }), ...(api.brandId && { brand_id: api.brandId }) }, 'workspace');
  const data = asRecord(read.data?.data);
  const items = recordRows(read.data?.data) ?? [];
  const providers = recordRows(data.providers) ?? [];
  const attention = tab === 'needs' && params.get('priority') === 'high'
    ? items.filter(item => ['blocker', 'high'].includes(String(item.severity))) : items;
  const unavailable = providers.filter(provider => provider.availability !== 'available');
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: 'full' });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const formatDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? date.format(new Date(value)) : '—';
  const formatNumber = (value: unknown) => typeof value === 'number' ? number.format(value) : '—';
  const efficiency = asRecord(data.execution_efficiency);
  const onTime = asRecord(efficiency.on_time_rate);
  const countOf = (kinds: string[], types: string[]) => items.filter(item => kinds.includes(stringValue(item.kind)) || types.includes(stringValue(asRecord(item.resource).type))).length;
  const allowedSteps = steps.filter(([module, , path]) => findOperation(api, 'GET', path, module));
  const metrics = (recordRows(data.cards) ?? []).flatMap(card => {
    const report = asRecord(card.metrics);
    const rows = recordRows(report.rows) ?? [];
    const coverage = asRecord(report.coverage);
    return rows.length ? rows.flatMap(row => Object.entries(asRecord(row.values)).map(([key, value]) => ({ key, ...asRecord(value), coverage }))) :
      (recordRows(card.unavailable) ?? []).map(row => ({ ...row, key: row.metric_key }));
  });

  function itemLink(row: RecordData) {
    const resource = asRecord(row.resource);
    const target = destinations[stringValue(resource.type)];
    const title = t(`attentionKind.${stringValue(row.kind)}`, { defaultValue: stringValue(row.title) });
    if (row.kind === 'terms_outdated' && typeof asRecord(row.terms_renewal).social_account_id === 'string') {
      return <TermsRenewal renewal={asRecord(row.terms_renewal)} title={title} />;
    }
    if (!target || typeof resource.id !== 'string') {
      const sources = Array.isArray(row.sources) ? row.sources : [];
      return ['connector_auto_halted', 'account_emergency_stop'].includes(String(row.kind)) && sources.length
        ? <>{title}<small className="muted"> · {sources.map(source => t(`haltSource.${source}`, { defaultValue: String(source) })).join(', ')}</small></>
        : title;
    }
    const id = target[1] === 'approvals' ? '' : resource.id;
    return <Link to={`${base}/${target[0]}?${new URLSearchParams({ tab: target[1], ...(id ? { id } : {}) })}`}>{title}</Link>;
  }

  const overview = <>
    <header className="overview-hero dashboard-hero"><div className="hero-orbit" aria-hidden="true" /><div>
      <p>{workspace?.name} · {fullDate.format(new Date())}</p>
      <h1>{t(summary ? 'dashboardSummary' : view === 'personal' ? 'dashboardPersonal' : 'today')}</h1>
      <span>{t(summary ? 'dashboardSummaryHint' : view === 'personal' ? 'dashboardPersonalHint' : 'dashboardHint')}</span>
    </div></header>
    <nav className="tabs dashboard-tabs" aria-label={t('home')}>
      {([['today', 'home', 'today'], ['needs', 'home?tab=needs', 'attention'], ['health', 'home?tab=health', 'workspaceStatus'], ['personal', 'me', 'dashboardPersonal'], ['summary', 'home/summary', 'dashboardSummary']] as const).map(([key, path, label]) => {
        const selected = (tab ?? view) === key;
        return <Link className={selected ? 'selected' : undefined} aria-current={selected ? 'page' : undefined} key={key} to={`${base}/${path}`}>{t(label)}</Link>;
      })}
    </nav>
    {view === 'today' && !tab && read.data && <div className="dashboard-stats">
      {([
        [ClipboardList, 'dashboardApprovals', countOf(['approval'], ['approval_request']), 'approvals'],
        [CircleAlert, 'dashboardPublishing', countOf(['missed_publish', 'outcome_unknown'], ['execution_task']), 'execution'],
        [Mail, 'dashboardReplies', countOf(['pending_reply', 'unassigned_conversation'], ['conversation']), 'inbox'],
        [CheckCircle2, 'dashboardSources', unavailable.length ? label([`${unavailable.length} 個異常`, `${unavailable.length} need attention`]) : providers.length ? label(['全部正常', 'All healthy']) : '—', 'home?tab=health'],
      ] as const).map(([Icon, key, value, href]) => <Link key={key} className="panel dashboard-stat" to={`${base}/${href}`}><Icon size={19} aria-hidden="true" /><div><span>{t(key)}</span><strong className={typeof value === 'string' ? 'stat-text' : undefined}>{typeof value === 'string' ? value : formatNumber(value)}</strong></div></Link>)}
    </div>}
  </>;

  return <>
    {view === 'today' && tab === null ? <section className="dashboard-aurora">{overview}</section> : overview}
    {summary && read.op && <Panel><form className="panel-head summary-filter" key={`${from}/${to}/${read.data ? "ready" : "pending"}`} onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setParams({ from: String(form.get('from')), to: String(form.get('to')) });
    }}>
      <div className="inline-form"><label>{t('startDate')} <input type="date" name="from" defaultValue={from || stringValue(data.from)} required /></label>
        <label>{t('exclusiveEndDate')} <input type="date" name="to" defaultValue={to || stringValue(data.to)} required /></label>
        <button type="submit" disabled={read.isFetching}>{t('applyRange')}</button></div>
      {read.data && <small>{stringValue(data.from)} → {stringValue(data.to)} · {stringValue(data.timezone)}</small>}
    </form></Panel>}
    {view === 'today' && !tab && findOperation(api, 'GET', '/onboarding/:flow', 'workspace') && <SetupChecklist />}
    <Panel>
      <div className="panel-head"><h2>{t(summary ? 'dashboardMetrics' : tab === 'health' ? 'workspaceStatus' : 'attention')}</h2><small>{read.isFetching ? t('loading') : formatDate(data.as_of)}</small></div>
      <ReadState read={read} />
      {read.data && (summary ? <>
        <div className="dashboard-stats dashboard-summary-stats">
          <div className="dashboard-stat"><div><span>{t('scheduledCount')}</span><strong>{formatNumber(efficiency.scheduled_count)}</strong></div></div>
          <div className="dashboard-stat"><div><span>{t('verifiedCount')}</span><strong>{formatNumber(efficiency.verified_count)}</strong></div></div>
          <div className="dashboard-stat"><div><span>{t('onTimeRate')}</span><strong>{typeof onTime.value === 'number' ? percent.format(onTime.value) : '—'}</strong><small>{t(`state.${String(onTime.availability ?? 'not_collected')}`)}{typeof onTime.coverage === 'number' ? ` · ${t('coverage')} ${percent.format(onTime.coverage)}` : ''}</small></div></div>
        </div>
        {metrics.length ? <EntityTable records={metrics as RecordData[]} rowKey={row => stringValue(row.key)} columns={[
          { label: t('name'), cell: row => t(`metric.${stringValue(row.key)}`, { defaultValue: stringValue(row.key) }) },
          { label: t('result'), cell: row => formatNumber(row.value) },
          { label: t('availability'), cell: row => <Pill>{t(`state.${stringValue(row.availability)}`, { defaultValue: stringValue(row.availability) || '—' })}</Pill> },
          { label: t('coverage'), cell: row => { const coverage = asRecord(row.coverage); return typeof coverage.subjects_total === 'number' ? `${formatNumber(coverage.subjects_observed)} / ${formatNumber(coverage.subjects_total)}` : '—'; } },
        ]} /> : <EmptyState title={t('noMetrics')} />}
      </> : tab === 'health' ? providers.length ? <EntityTable records={providers} rowKey={row => stringValue(row.provider)} columns={[
        { label: t('provider'), cell: row => t(`provider.${stringValue(row.provider)}`, { defaultValue: stringValue(row.provider) }) },
        { label: t('availability'), cell: row => <Pill tone={row.availability === 'available' ? 'good' : 'warning'}>{t(`state.${stringValue(row.availability)}`, { defaultValue: stringValue(row.availability) })}</Pill> },
        { label: t('attention'), cell: row => formatNumber(row.total) },
        { label: t('updated_at'), cell: row => formatDate(row.as_of) },
      ]} /> : <EmptyState title={t('noProviders')} /> : <>
        {params.get('priority') === 'high' && <div className="panel-head"><span>{t('dashboardUrgent')}</span><Link to={`${base}/home?tab=needs`}>{t('allAttention')}</Link></div>}
        {unavailable.length > 0 && <p role="status" className="notice">{t('providerUnavailable')} {unavailable.map(provider => stringValue(provider.provider)).join(', ')}</p>}
        {attention.length ? <EntityTable records={attention} rowKey={row => `${stringValue(row.kind)}:${stringValue(asRecord(row.resource).id)}`} columns={[
          { label: t('title'), cell: itemLink }, { label: t('status'), cell: row => <Pill tone={row.severity === 'blocker' ? 'critical' : row.severity === 'high' ? 'warning' : 'neutral'}>{t(`state.${stringValue(row.severity)}`, { defaultValue: stringValue(row.severity) })}</Pill> },
          { label: t('due_at'), cell: row => formatDate(row.due_at) },
        ]} /> : <EmptyState title={t(params.get('priority') === 'high' ? 'noUrgentAttention' : unavailable.length ? 'noAvailableAttention' : 'noAttention')} detail={t('dashboardEmptyHint')}
          action={findOperation(api, 'GET', '/brands', 'workspace') && <Link className="button" to={`${base}/settings/brands`}>{t('module.workspace')}<ArrowRight size={15} /></Link>} />}
      </>)}
    </Panel>
    {view === 'today' && !tab && (recordRows(data.skipped_steps) ?? []).length > 0 && <Panel>
      <div className="panel-head"><h2>{t('onboardingSkipped')}</h2></div>
      <ul>{(recordRows(data.skipped_steps) ?? []).map(step => <li key={stringValue(step.step_key)}>
        {t(`onboardingStep.${stringValue(step.step_key)}`, { defaultValue: stringValue(step.step_key) })} · {stringValue(asRecord(step.check_result).impact)}
      </li>)}</ul>
    </Panel>}
    {view === 'today' && !tab && allowedSteps.length > 0 && <Panel><div className="panel-head"><h2>{t('inProgress')}</h2></div><div className="workflow-grid dashboard-workflow">
      {findOperation(api, 'GET', '/onboarding/:flow', 'workspace') && <Link to={`${base}/setup`}><ClipboardList size={19} aria-hidden="true" /><strong>{label(setupLabel)}</strong><ArrowRight size={15} aria-hidden="true" /></Link>}
      {allowedSteps.map(([key, path, , Icon]) => <Link key={key} to={`${base}/${path}`}><Icon size={19} aria-hidden="true" /><strong>{t(`module.${key}`)}</strong><ArrowRight size={15} aria-hidden="true" /></Link>)}
    </div></Panel>}
  </>;
}
