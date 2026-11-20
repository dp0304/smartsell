import { ReportExports } from './ReportExports';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDownRight, ArrowRight, Plus, Search } from 'lucide-react';
import { asRecord, operationPath, type RecordData } from '@smartsell/sdk';
import { EmptyState, EntityTable, Panel, Pill } from '@smartsell/ui';
import { entity, findOperation, ReadState, recordRows, rowTitle, stringValue, useApi, useRead } from './api';
import { createActions, generalImport, permitsAction, rowActions, type Action } from './actions';
import { Json, OperationForm, type Selection } from './OperationForm';
import type { Module, Resource } from './modules';
import { useCopy } from './i18n';
import { OperationAssetPreview, OperationMediaUpload } from './workbench-media-upload';
import { AnalyticsReadWorkspace, AnalyticsWorkspace, isAnalyticsReadResource, PageExperimentReport } from './analytics-workspace';
import { AnalyticsResult } from './analytics-result';
import { CampaignBacklink, CampaignWorkspace } from './campaign-workspace';
import { AdAdjustment, AdsWorkspaceReads } from './ads-workspace';
import { IntelAlerts, IntelCompare, IntelWatch, IntelWatchCreate } from './intel-observation-view';
import { IntelBoard, IntelCreatives, IntelTrend } from './intel-research-view';
import { IntelCandidate, IntelListening } from './intel-decisions';
import { CustomerIdentities, InboxCoverage, InboxEngagement, InboxRuleRuns, InboxSlaSample, ReviewDetails, ReviewSourceDetails } from './inbox-engagement';
import { LeadBoard, LeadFollowup } from './lead-followup';
import { CreatorAttribution } from './creator-detail';
import { CreatorAudienceObservations, CreatorCollaborationLive, CreatorLiveSession, CreatorPlanButton, CreatorProfileAssociations } from './creator-operations';

import { ContentFactWorkbench } from './workbench-content';
import { MappingWorkspace, ProductDetail, ProductForm, productSearchLabel, useCatalogQuery } from './commerce-workbench';
import { CommerceImports, ImportReview } from './commerce-import-view';
import { PromotionCreate, PromotionDetail } from './commerce-promotions';
import { ProductCatalogSync, StoreSyncCenter } from './commerce-store-sync';
import { ExecutionReview, PauseWithdrawals, PostAudit, PublishingCalendar, TargetReview } from './publishing-workflow-view';
import { CommerceChangesTable } from './commerce-changes-view';
import { InboxActivity, InboxContext, InboxDelivery, InboxDraft, InboxThread } from './inbox-workflow-view';
import { completePostOperation, executionWorkspaceActions, requestOfficialPostOperation, requestPostOperation, targetWorkspaceActions } from './core-actions';
import { conversationWorkspaceActions } from './support-actions';
import { Status, Timestamp } from './workflow-view-ui';
import { LifecycleAudience, LifecycleCampaign, LifecycleConsent, LifecycleFlow, LifecycleHealth } from './lifecycle-workspace';
import { RecordFilters, matchesFilters, type Filters } from './record-filters';
import { CommandLanguage } from './workspace-tools';
import { AgentAssistant } from './agent-assistant';
import type { Entity } from './workbench-api';
import { ApprovalBatch, approvalBatchPath, approvalTargetId } from './approval-batch';
import { brandScopedLists } from './workspace-brand-scope';

const workflowActions = { tasks: executionWorkspaceActions, targets: targetWorkspaceActions, conversations: conversationWorkspaceActions } as Record<string, Action[]>;
const commerceImportTab: Resource = { key: 'store-imports', label: ['CSV 匯入', 'CSV imports'], path: '/imports' };
const markNotificationRead: Action = { path: '/notifications/read', label: ['標記為已讀', 'Mark as read'] };

function NotificationTable({ rows, open }: { rows: RecordData[]; open: Open }) {
  const api = useApi();
  const { t, label } = useCopy();
  const mayMarkRead = findOperation(api, 'POST', markNotificationRead.path, 'workspace');
  return <EntityTable records={rows} rowKey={rowId} columns={[
    { label: t('title'), cell: row => row.type === 'notification_digest' ? <>
      {label(['每日通知摘要', 'Daily notification digest'])}
      <ul>{(recordRows(row.items) ?? []).map((item, index) => <li key={`${stringValue(item.resource_id)}:${index}`}>
        {item.type === 'mentioned' ? label(['有人提及你', 'You were mentioned']) : stringValue(item.title)}
      </li>)}</ul>
    </> : stringValue(row.title) },
    { label: t('status'), cell: row => <Pill>{row.read_at ? label(['已讀', 'Read']) : label(['未讀', 'Unread'])}</Pill> },
    { label: t('created_at'), cell: row => <Timestamp value={row.created_at} /> },
    { label: label(['操作', 'Action']), cell: row => mayMarkRead && !row.read_at &&
      <button onClick={() => open(markNotificationRead.path, markNotificationRead, [], {}, { ids: [rowId(row)] })}>{label(markNotificationRead.label)}</button> },
  ]} />;
}
const optionNames: Record<string, readonly [string, string]> = {
  manual: ['人工處理', 'Manual tasks'],
  pending: ['待我審批', 'Pending my review'], submitted: ['我提交的', 'Submitted by me'], expired: ['已過期或失效', 'Expired or invalidated'],
  all: ['全部', 'All'], mine: ['指派給我', 'Assigned to me'], unassigned: ['未指派', 'Unassigned'], open: ['開啟', 'Open'],
  waiting: ['等候顧客', 'Waiting for customer'], snoozed: ['已暫緩', 'Snoozed'], resolved: ['已解決', 'Resolved'], exceptions: ['僅顯示例外', 'Exceptions only'],
};
const rowId = (row: RecordData) => stringValue(row.id ?? row.key ?? row.target_id ?? row.publish_target_id);
type Open = (path: string, action: Action, ids?: string[], record?: RecordData, seed?: RecordData) => void;

function Display({ name, value }: { name: string; value: unknown }) {
  const { locale, t } = useCopy();
  if (value === null || value === undefined || value === '') return <>—</>;
  if (typeof value === 'object') return <span title={JSON.stringify(value)}>{stringValue(asRecord(value).value) || stringValue(asRecord(value).availability) || '…'}</span>;
  const text = String(value);
  if (name.endsWith('_at') && !Number.isNaN(Date.parse(text))) return <time dateTime={text}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(text))}</time>;
  if (['status', 'display_status', 'sub_status', 'production_stage', 'availability'].includes(name)) {
    const tone = /unknown|pending|waiting|manual/.test(text) ? 'warning' : /failed|blocked|rejected/.test(text) ? 'critical' : /active|ready|approved|published|completed/.test(text) ? 'good' : 'neutral';
    return <Pill tone={tone}>{t(`state.${text}`, { defaultValue: text })}</Pill>;
  }
  return <span title={text}>{text}</span>;
}

function Actions({ group, record, open, ids = [rowId(record)], seed = {} }: { group: string; record: RecordData; open: Open; ids?: string[]; seed?: RecordData }) {
  const api = useApi();
  const { label } = useCopy();
  const ai = useRead('/ai/status', group === 'jobs' ? [] : ['']);
  const purposes = asRecord(ai.data?.data).purposes;
  const available = (workflowActions[group] ?? rowActions[group] ?? []).filter(action => {
    if (group === 'jobs' && (!Array.isArray(purposes) || !purposes.includes('plan') ||
        !['open', 'returned'].includes(stringValue(record.status)) || record.cancel_requested_at ||
        (record.assignee_id && record.assignee_id !== api.session.user.id))) return false;
    if (group === 'conversations' && action.path.endsWith('/read') && !seed.message_id) return false;
    if (group === 'conversations' && action.path.endsWith('/reply-drafts') && !record.last_message_id) return false;
    if (group === 'tasks' && action.path.endsWith('/manual-abandon') && Array.isArray(record.pending_side_effects) && record.pending_side_effects.length) return false;
    const op = findOperation(api, action.method ?? 'POST', action.path);
    return op && ids.every(Boolean) && permitsAction(group, action, record, op.name);
  });
  return available.length > 0 && <div className="action-row">{available.map(action => <button key={label(action.label)} onClick={() => open(action.path, action, ids, record, group === 'targets' && /\/(approve|reject|request-changes)$/.test(action.path) ? { resource_hash: asRecord(record.approval).resource_hash } : action.path.endsWith('/read') ? seed : group === 'conversations' ? {} : seed)}>{label(action.label)}</button>)}</div>;
}

function DataBlock({ path, ids, title, onPick, pickLabel }: { path: string; ids: string[]; title: string; onPick?: (record: RecordData) => void; pickLabel?: (record: RecordData) => string }) {
  const { t } = useCopy();
  const read = useRead(path, ids);
  if (!read.op) return null;
  const rows = recordRows(read.data?.data);
  return <section className="detail-block"><h3>{title}</h3><ReadState read={read} />{read.data && (rows ? (rows.length ?
    <EntityTable records={rows} rowKey={rowId} columns={[{ label: t('recordId'), cell: row => onPick ? <button className="text-button" onClick={() => onPick(row)}>{pickLabel?.(row) ?? rowTitle(row)}</button> : rowTitle(row) }, { label: t('data'), cell: row => <details><summary>{t('details')}</summary><Json value={row} /></details> }]} /> :
    <EmptyState title={t('empty')} />) : <Json value={read.data.data} />)}</section>;
}

function LinkedDetails({ group, record, open, onRelated }: { group: string; record: RecordData; open: Open; onRelated: (kind: string, id: string) => void }) {
  const { t, label } = useCopy();
  const id = rowId(record);
  if (group === 'content') {
    const variants = (recordRows(record.variants ?? record.content_variants) ?? []).map(row => entity(row.variant ?? row));
    return <section className="detail-block"><h3>{t('linked')}</h3>{variants.map(variant => <button key={rowId(variant)} onClick={() => onRelated('variant', rowId(variant))}>{rowTitle(variant)} · {stringValue(variant.locale)}</button>)}</section>;
  }
  if (group === 'variants') return <><ContentFactWorkbench key={id} record={record} /><DataBlock path="/content-variants/:id/revisions" ids={[id]} title={t('revisions')}
    pickLabel={revision => `${label(['排期版本', 'Schedule revision'])} ${stringValue(revision.revision_no)}`}
    onPick={revision => {
      const action = createActions.targets;
      open(action.path, action, [], {}, { brand_id: record.brand_id, campaign_id: record.campaign_id, content_item_id: record.content_item_id, content_variant_id: id, variant_revision_id: rowId(revision), content_format: record.format });
    }} /></>;
  if (group === 'products') return <DataBlock path="/products/:id/facts" ids={[id]} title={t('facts')} />;
  if (group === 'brands') return <DataBlock path="/brands/:id/markets" ids={[id]} title={t('markets')} />;
  if (group === 'reports') return <><DataBlock path="/reports/:id/versions" ids={[id]} title={t('revisions')} onPick={version => onRelated('report-id', rowId(version))} /><section className="detail-block"><h3>{t('revisions')}</h3>{(recordRows(record.versions) ?? []).map(version => {
    const number = stringValue(version.version_no ?? version.number ?? version.version ?? version.n);
    return <button key={number} onClick={() => onRelated('report', number)}>{number}</button>;
  })}</section></>;
  return null;
}

const productionStages = ['accepted', 'drafting', 'design', 'awaiting_assets', 'internal_review', 'ready', 'archived'];

function ProductionBoard({ rows, onPick }: { rows: RecordData[]; onPick: (row: RecordData) => void }) {
  const { t, locale } = useCopy();
  const byStage = new Map<string, RecordData[]>();
  for (const row of rows) {
    const stage = stringValue(row.production_stage);
    const lane = byStage.get(stage);
    if (lane) lane.push(row);
    else byStage.set(stage, [row]);
  }
  const columns = [...productionStages, ...[...byStage.keys()].filter(stage => !productionStages.includes(stage))];
  const number = new Intl.NumberFormat(locale);
  return <div className="production-board" aria-label={t('productionBoard')} role="region" tabIndex={0}>
    {columns.map(stage => {
      const items = byStage.get(stage) ?? [];
      return <section className="production-lane" key={stage}>
        <h3>{stage ? t(`state.${stage}`, { defaultValue: stage.replaceAll('_', ' ') }) : t('unassignedStage')} <small>{number.format(items.length)}</small></h3>
        {items.map(row => <button type="button" key={rowId(row)} onClick={() => onPick(row)}>
          <strong>{rowTitle(row)}</strong>
          {Boolean(row.production_due_at) && <small><Timestamp value={row.production_due_at} /></small>}
        </button>)}
      </section>;
    })}
  </div>;
}

const relatedPaths: Record<string, [string, string]> = { import: ['/imports/:id', 'imports'], variant: ['/content-variants/:id', 'variants'], target: ['/publish-targets/:id', 'targets'], report: ['/reports/:id/versions/:n', 'reportVersions'], 'report-id': ['/report-versions/:id', 'reportVersionIds'], reply: ['/reply-drafts/:id', 'replies'], delivery: ['/outbound-replies/:id', 'deliveries'] };

function BackfillProgress({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const progress = asRecord(record.progress);
  const runs = recordRows(record.runs) ?? [];
  const gaps = recordRows(record.gaps) ?? [];
  return <section className="message">
    <h3>{label(['回補進度', 'Backfill progress'])}</h3>
    <p>{label(['已完成分片', 'Completed shards'])} {String(progress.complete ?? 0)} / {String(progress.total ?? 0)}</p>
    <EntityTable records={[...runs, ...gaps]} rowKey={rowId} columns={[
      { label: label(['資源', 'Resource']), cell: row => stringValue(row.resource) },
      { label: label(['開始', 'From']), cell: row => <Timestamp value={row.window_from ?? row.from} /> },
      { label: label(['結束', 'To']), cell: row => <Timestamp value={row.window_to ?? row.to} /> },
      { label: label(['狀態', 'Status']), cell: row => ['unrecoverable', 'unavailable'].includes(String(row.status))
        ? label(['超出保留期 · 不可恢復', 'Beyond retention · Unrecoverable']) : <Status value={row.executor_status?.toString().startsWith('budget_') ? row.executor_status : row.status} /> },
    ]} />
  </section>;
}

function SourceBudget({ sourceId }: { sourceId: string }) {
  const { label } = useCopy();
  const read = useRead('/data-health', [], {}, 'ingest');
  const state = asRecord(recordRows(read.data?.data)?.find(row => row.data_source_id === sourceId)?.collection_budget);
  if (!state.policy) return null;
  return <section className="message" role="status">
    <p>{state.policy === 'pause' ? label(['已達採集預算，採集已暫停。', 'Collection paused because the budget was reached.'])
      : label(['已達採集預算，採集已降頻。', 'Collection slowed because the budget was reached.'])}</p>
    {Boolean(state.blocked && state.next_request_at) && <p>{label(['下次可採集時間', 'Next eligible request'])} <Timestamp value={state.next_request_at} /></p>}
  </section>;
}

export function ModulePage({ module, initialTab, initialId, initialVersion, initialView }: { module: Module; initialTab?: string; initialId?: string; initialVersion?: string; initialView?: string }) {
  const api = useApi();
  const { t, label, locale } = useCopy();
  const [params, setParams] = useSearchParams();
  const tabs = module.key === 'commerce' ? [...module.resources, commerceImportTab] : module.resources;
  const resource = tabs.find(item => item.key === (params.get('tab') ?? initialTab)) ?? module.resources[0];
  const [selection, setSelection] = useState<Selection>();
  const [relatedRecord, setRelatedRecord] = useState<RecordData>({});
  const [filter, setFilter] = useState('');
  const [creatingProduct, setCreatingProduct] = useState(false);
  const isProducts = module.key === 'commerce' && resource.key === 'products';
  const productStore = isProducts ? params.get('store') ?? '' : '';
  const productStoreParam: Record<string, string> = productStore ? { store: productStore } : {};
  const isMapping = module.key === 'commerce' && resource.key === 'mapping';
  const productQuery = useCatalogQuery(isProducts ? filter : '');
  const searchLabel = isProducts ? label(productSearchLabel) : t('search');
  const [checked, setChecked] = useState<string[]>([]);
  const [batch, setBatch] = useState<RecordData[]>();
  const [dimensions, setDimensions] = useState<Filters>({});
  const [cursors, setCursors] = useState<string[]>([]);
  const [scope, setScope] = useState(initialView === 'manual' ? 'manual' : '');
  const [advanced, setAdvanced] = useState(false);
  const [board, setBoard] = useState(initialView === 'board');
  const [calendar, setCalendar] = useState(!initialTab && module.key === 'planning');
  const selected = params.get('id') ?? (!params.has('tab') ? initialId ?? '' : '');
  const deepVersion = Boolean(initialVersion && selected === initialId && !params.has('tab'));
  const versions = useRead('/reports/:id/versions', [deepVersion ? selected : '']);
  const versionRecord = recordRows(versions.data?.data)?.find(row => stringValue(row.version_no) === initialVersion);
  const related = params.get('related') ?? (versionRecord ? 'report-id' : null);
  const relatedId = params.get('rid') ?? rowId(versionRecord ?? {});
  const isInbox = resource.key === 'conversations';
  const approvals = resource.key === 'approvals';
  const batchAvailable = approvals && (!scope || scope === 'pending') && Boolean(findOperation(api, 'POST', approvalBatchPath, 'planning') && findOperation(api, 'GET', '/publish-targets/:id', 'planning'));
  const isStoreImport = resource.key === commerceImportTab.key;
  const analyticsRead = module.key === 'analytics' && isAnalyticsReadResource(resource.key) ? resource.key : undefined;
  const customAnalyticsRead = analyticsRead || (module.key === 'analytics' && (resource.key === 'cohorts' || resource.key === 'audience'));
  const intelView = module.key === 'intel' && ['compare', 'creatives', 'mentions'].includes(resource.key) ? resource.key : undefined;
  const scoped = isInbox || approvals || resource.key === 'tasks';
  const scopeOptions = approvals ? ['pending', 'submitted', 'expired'] : isInbox ? ['all', 'mine', 'unassigned', 'open', 'waiting', 'snoozed', 'resolved'] : ['all', 'exceptions', 'manual'];
  const read = useRead(isStoreImport || isMapping || customAnalyticsRead || intelView ? '/__none__' : resource.key === 'tasks' && scope === 'exceptions' ? '/execution-exceptions' : resource.path, [], {
    ...(cursors.length && { cursor: cursors.at(-1)! }), ...(isProducts && productQuery && { query: productQuery }), ...(productStore && { store_id: productStore }), ...(resource.key === 'tasks' && scope === 'manual' && { status: 'manual' }), ...((isInbox || approvals) && scope && { view: scope }),
  }, module.key);
  const page = recordRows(read.data?.data)?.filter(row => !api.brandId || !brandScopedLists.has(resource.path) ||
    (resource.path === '/brands' ? row.id : row.brand_id) === api.brandId);
  const filterRecord = (row: RecordData): Entity => ({
    id: rowId(row), module: module.key, kind: resource.key, data: row,
    version: Number(row.version ?? 0), created_at: stringValue(row.created_at), updated_at: stringValue(row.updated_at),
  });
  const rows = page?.filter(row => matchesFilters(filterRecord(row), dimensions) &&
    (isProducts || !filter || Object.values(row).some(value => stringValue(value).toLowerCase().includes(filter.toLowerCase()))));
  const selectedApprovals = batchAvailable ? rows?.filter(row => checked.includes(approvalTargetId(row))) ?? [] : [];
  const selectedRow = page?.find(row => rowId(row) === selected) ?? {};
  const relatedInfo = related ? relatedPaths[related] : undefined;
  const group = relatedInfo?.[1] ?? (approvals ? 'targets' : resource.key);
  const conversation = useRead('/conversations/:id', [isInbox ? selected : '']);
  const conversationData = entity(conversation.data?.data);
  const thread = { ...entity(conversationData.conversation), ...conversationData };
  const ids = related === 'report' ? [selected, relatedId] : [relatedInfo ? relatedId : selected];
  const details = useRead(relatedInfo?.[0] ?? (approvals ? '/publish-targets/:id' : module.key === 'intel' && resource.key === 'trends' ? undefined : resource.detail) ?? '/__none__', ids);
  const detail = entity(details.data?.data);
  const nested = entity(detail.conversation ?? detail.item ?? detail.variant ?? detail.report);
  const record: RecordData = { ...(relatedInfo ? relatedRecord : selectedRow), ...nested, ...detail, ...(details.data?.etag ? { etag: details.data.etag } : {}) };
  const recordReady = !details.op || Boolean(details.data);
  const create = createActions[resource.key];
  const availableCreate = isProducts ? findOperation(api, 'POST', '/products', 'commerce') : create && findOperation(api, create.method ?? 'POST', create.path);
  const [openedInitialForm, setOpenedInitialForm] = useState(false);
  useEffect(() => {
    if (initialView !== 'new' || params.has('tab') || openedInitialForm) return;
    const action = module.key === 'ingest' ? generalImport : create;
    if (!action) return;
    const op = findOperation(api, action.method ?? 'POST', action.path);
    if (op) {
      setSelection({ op, action });
      setOpenedInitialForm(true);
    }
  }, [api, create, initialView, module.key, openedInitialForm, params]);
  const currentTargets = resource.key === 'targets' && calendar;

  function open(path: string, action: Action, ids?: string[], record?: RecordData, seed?: RecordData) {
    const op = findOperation(api, action.method ?? 'POST', path);
    if (op) setSelection({ op, action, ids, record, seed });
  }
  function resourceParams(tab: string): Record<string, string> {
    if (tab === 'products') return productStoreParam;
    const date = currentTargets && tab === 'targets' ? params.get('date') : null;
    return date ? { date } : {};
  }
  function choose(id: string, tab = resource.key) { if (id) { setParams({ tab, id, ...resourceParams(tab) }); setRelatedRecord({}); } }
  function importTab(id?: string, store?: string) { setParams({ tab: commerceImportTab.key, ...(store && { store }), ...(id && { related: 'import', rid: id }) }); setRelatedRecord({}); }
  function chooseTab(tab: string) {
    setParams({ tab }); setCursors([]); setFilter(''); setChecked([]); setDimensions({}); setScope(''); setAdvanced(false); setBoard(false); setCalendar(module.key === 'planning' && tab === 'targets'); setRelatedRecord({});
  }
  function closeRecord() {
    setRelatedRecord({});
    if (isStoreImport) importTab(undefined, params.get('store') ?? undefined);
    else if (relatedInfo && selected) choose(selected);
    else setParams({ tab: resource.key, ...resourceParams(resource.key) });
  }
  function onRelated(kind: string, id: string) { setParams({ tab: resource.key, ...resourceParams(resource.key), ...(selected ? { id: selected } : {}), related: kind, rid: id }); }
  function follow(kind: string, value: RecordData) {
    let record = entity(value);
    if (!record.id && value[kind] && typeof value[kind] === 'object') record = entity(value[kind]);
    const id = stringValue(record.id ?? value[`${kind}_id`] ?? value.import_batch_id);
    if (!id) return;
    setSelection(undefined); setRelatedRecord(record);
    if (kind === 'target' && module.key === 'planning') choose(id, 'targets');
    else if (kind === 'import' && module.key === 'commerce') importTab(id, stringValue(record.store_id));
    else onRelated(kind, id);
  }
  const emptyRecords = <EmptyState title={t(filter || Object.values(dimensions).some(Boolean) ? 'noMatches' : 'empty')}
    detail={!filter ? (isProducts ? t('importHint') : t('emptyDetail')) : undefined}
    action={!filter && !availableCreate && isProducts && <button onClick={() => setParams({ tab: 'stores' })}>{t('resource.stores')} <ArrowRight size={15} /></button>} />;
  return <>
    <header className="page-heading"><div><h1>{t(`module.${module.key}`)}</h1><p>{t(`description.${module.key}`)}</p></div><div className="toolbar">
      {module.key === 'ingest' && findOperation(api, 'POST', generalImport.path) && <button onClick={() => open(generalImport.path, generalImport)}><Plus size={16} />{label(generalImport.label)}</button>}
      {(module.key === 'commerce' || module.key === 'ingest') && findOperation(api, 'GET', '/imports/:id') && <form className="inline-form" onSubmit={event => { event.preventDefault(); const id = String(new FormData(event.currentTarget).get('batch') ?? '').trim(); if (id && !/[/\\]/.test(id) && id !== '.' && id !== '..') onRelated('import', id); }}><input name="batch" required aria-label={t('batchId')} placeholder={t('batchId')} /><button>{t('importOpen')}</button></form>}
      {module.key === 'commerce' && !isStoreImport && findOperation(api, 'GET', '/imports') && <button onClick={() => chooseTab(commerceImportTab.key)}>{label(commerceImportTab.label)}</button>}
      {module.key === 'creator' && resource.key === 'live' && <CreatorPlanButton open={open} />}
      {module.key === 'commerce' && resource.key === 'promotions' && <PromotionCreate onCreated={id => { setFilter(''); choose(id, 'promotions'); }} />}
      {availableCreate && <button className="primary" onClick={() => isProducts ? setCreatingProduct(true) : create && open(create.path, create)}><Plus size={16} />{isProducts ? label(['新增商品', 'Create product']) : label(create.label)}</button>}
    </div></header>
    <div className="tabs" aria-label={t('allModules')}>{tabs.map(tab => <button key={tab.key} className={resource.key === tab.key && !advanced ? 'selected' : ''} onClick={() => chooseTab(tab.key)}>{label(tab.label)}</button>)}
      <button className={advanced ? 'selected advanced-tab' : 'advanced-tab'} onClick={() => setAdvanced(value => !value)}>{t('advanced')} <ArrowDownRight size={14} /></button>
    </div>
    {advanced ? <Advanced module={module} onOpen={setSelection} /> : <>
      {module.key === 'asset' && resource.key === 'assets' && <OperationMediaUpload />}
      {module.key === 'analytics' && (resource.key === 'cohorts' || resource.key === 'attribution' || resource.key === 'audience') && <AnalyticsWorkspace key={resource.key} resource={resource.key} />}
      {analyticsRead && <AnalyticsReadWorkspace key={analyticsRead} resource={analyticsRead} onPick={choose} />}
      {module.key === 'ads' && resource.key === 'adaccounts' && <AdsWorkspaceReads />}
      {intelView === 'compare' && <IntelCompare />}
      {intelView === 'creatives' && <IntelCreatives />}
      {intelView === 'mentions' && <IntelListening />}
      {module.key === 'intel' && resource.key === 'watch' && findOperation(api, 'POST', '/watch-targets', 'intel') && <IntelWatchCreate />}
      {module.key === 'intel' && resource.key === 'alerts' && <IntelAlerts />}
      {resource.key === 'targets' && <div className="view-switch"><button aria-pressed={calendar} onClick={() => setCalendar(true)}>{t('calendar')}</button><button aria-pressed={!calendar} onClick={() => setCalendar(false)}>{t('list')}</button></div>}
      {resource.key === 'content' && <div className="view-switch"><button aria-pressed={board} onClick={() => setBoard(true)}>{t('productionBoard')}</button><button aria-pressed={!board} onClick={() => setBoard(false)}>{t('list')}</button></div>}
      {currentTargets && <PublishingCalendar onPick={choose} />}
      {isInbox && <InboxSlaSample />}
      {isMapping && <MappingWorkspace key={api.ws} />}
      {isStoreImport && !relatedInfo && <CommerceImports key={params.get('store') ?? ''} storeId={params.get('store') ?? ''} onPick={importTab} onStores={() => chooseTab('stores')} />}
      {scoped && <div className="view-switch">{scopeOptions.map(option => <button key={option} aria-pressed={(scope || scopeOptions[0]) === option} onClick={() => { setScope(option); setChecked([]); setCursors([]); }}>{label(optionNames[option])}</button>)}</div>}
      <div className={isInbox ? 'inbox-grid' : (!isStoreImport && !currentTargets && (selected || relatedInfo)) ? 'record-layout' : ''}>
        {(!currentTargets || isInbox) && !isStoreImport && !isMapping && !customAnalyticsRead && !intelView && <Panel><div className="panel-head"><h2>{label(resource.label)}</h2><label className="search-input"><Search size={16} /><input type="search" value={filter} aria-label={searchLabel} placeholder={searchLabel} onChange={event => { setFilter(event.target.value); if (isProducts) setCursors([]); }} /></label></div>
          {!!page?.length && !isInbox && <CommandLanguage><RecordFilters key={resource.key}
            wid={api.ws} userId={api.session.user.id ?? ''} role={api.session.workspaces.find(workspace => workspace.id === api.ws)?.role ?? ''}
            resourceType={`${module.key}.${resource.key}`} storageKey={`smartsell.filters:${api.ws}:${api.session.user.id}:${module.key}:${resource.key}`}
            rows={page.map(filterRecord)} filters={dimensions} change={setDimensions} /></CommandLanguage>}
          {!read.op && resource.listUnavailable ? <EmptyState title={t('noAccess')} detail={label(resource.listUnavailable === 'unmounted'
            ? ['此部署未在工作區目錄提供租戶管理端點。', 'This deployment does not expose the tenant administration endpoint in the workspace catalog.']
            : ['目前的 API 尚未提供此讀取端點。', 'This read endpoint is not yet available in the API.'])} /> : <ReadState read={read} />}
          {batchAvailable && selectedApprovals.length > 0 && <div className="panel-head"><button onClick={() => setBatch(selectedApprovals)}>{t('approvalBatchPreview')} · {new Intl.NumberFormat(locale).format(selectedApprovals.length)}</button></div>}
          {isProducts && read.data && <ProductCatalogSync key={productStore} storeId={productStore}
            emptyState={rows?.length === 0 && productQuery === filter.trim() ? emptyRecords : undefined} />}
          {read.data && (!isProducts || productQuery === filter.trim()) && (resource.key === 'coverage' && module.key === 'inbox' ? <InboxCoverage value={read.data.data} /> : module.key === 'lifecycle' && resource.key === 'health' ? <LifecycleHealth data={read.data.data} /> : rows ? (resource.key === 'leads' ? <LeadBoard rows={rows} onPick={row => choose(rowId(row))} /> : rows.length ? approvals ? <EntityTable records={rows} rowKey={rowId} columns={[
              ...(batchAvailable ? [{ label: t('select'), cell: (row: RecordData) => {
                const id = approvalTargetId(row);
                return id && <input type="checkbox" aria-label={rowTitle(row) || id} checked={checked.includes(id)} disabled={checked.length >= 250 && !checked.includes(id)} onChange={event => {
                  const selected = event.currentTarget.checked;
                  setChecked(current => selected ? [...current, id] : current.filter(item => item !== id));
                }} />;
              } }] : []),
              { label: label(['發布目標', 'Publish target']), cell: row => <button className="text-button" onClick={() => choose(stringValue(row.resource_id ?? row.target_id ?? row.publish_target_id))}>{stringValue(row.title ?? row.resource_id ?? row.target_id)}</button> },
              { label: t('status'), cell: row => <Status value={row.status} /> },
              { label: label(['步驟', 'Step']), cell: row => stringValue(row.current_step) },
              { label: t('due_at'), cell: row => <Timestamp value={row.due_at} /> },
            ]} /> : resource.key === 'notifications' ? <NotificationTable rows={rows} open={open} /> : resource.key === 'content' && board ? <ProductionBoard rows={rows} onPick={row => choose(rowId(row))} /> : resource.key === 'changes' ? <CommerceChangesTable rows={rows} onPick={row => choose(rowId(row))} /> : <ResourceTable rows={rows} resource={resource} onPick={row => choose(rowId(row))} compact={isInbox || Boolean(selected || relatedInfo)} /> :
            isProducts ? null : emptyRecords) : <Json value={read.data.data} />)}
          {(!isProducts || productQuery === filter.trim()) && (cursors.length > 0 || read.data?.next_cursor) && <div className="pagination">{cursors.length > 0 && <button onClick={() => setCursors(prev => prev.slice(0, -1))}>{t('previousPeriod')}</button>}{read.data?.next_cursor && <button onClick={() => setCursors(prev => [...prev, read.data!.next_cursor!])}>{t('next')}</button>}</div>}
        </Panel>}
        {(selected || relatedInfo || isInbox) && <Panel className="record-detail"><div className="panel-head"><h2>{rowTitle(record) || t('details')}</h2>{(selected || relatedInfo) && <button className="icon-button" aria-label={t('close')} onClick={closeRecord}>×</button>}</div>
          {!(selected || relatedInfo) ? <EmptyState title={t('selectRecord')} /> : <>
            {details.op && <ReadState read={details} />}
            {recordReady && <div className="detail-body">
              {module.key === 'campaign' && group === 'campaigns' && <CampaignWorkspace key={selected} record={record} id={selected} />}
              {((module.key === 'content' && group === 'content') || (module.key === 'traffic' && group === 'links')) && <CampaignBacklink record={record} />}
              {module.key === 'analytics' && group === 'reportVersionIds' && <><AnalyticsResult action="reports_get" result={record} locale={locale} /><ReportExports key={rowId(record)} record={record} /></>}
              {module.key === 'analytics' && group === 'experiments' && typeof record.landing_page_id === 'string' && <PageExperimentReport pageId={record.landing_page_id} experimentId={selected} />}
              {module.key === 'asset' && group === 'assets' && <OperationAssetPreview record={record} />}
              {module.key === 'ads' && group === 'adjustments' && record.id != null && <AdAdjustment record={record} />}
              {module.key === 'intel' && group === 'watch' && record.id != null && <IntelWatch key={selected} record={record} />}
              {module.key === 'intel' && group === 'boards' && record.id != null && <IntelBoard key={selected} record={record} />}
              {module.key === 'intel' && group === 'trends' && <IntelTrend key={selected} record={{ ...record, id: selected }} />}
              {module.key === 'intel' && group === 'candidates' && record.id != null && <IntelCandidate key={selected} record={record} />}
              {group === 'targets' && <TargetReview record={record} />}
              {module.key === 'ingest' && group === 'backfills' && <BackfillProgress record={record} />}
              {module.key === 'ingest' && group === 'sources' && <SourceBudget sourceId={selected} />}
              {module.key === 'workspace' && group === 'work' && record.resource_type === 'quality_issue' &&
                <Link to={`/w/${encodeURIComponent(api.ws)}/data/health/issues?tab=quality&id=${encodeURIComponent(stringValue(record.resource_id))}`}>{label(['查看品質問題', 'View quality issue'])}</Link>}
              {group === 'pauses' && <PauseWithdrawals record={record} />}
              {group === 'tasks' && <ExecutionReview task={record} />}
              {group === 'posts' && (() => {
                const kinds = Array.isArray(record.official_operations) ? record.official_operations.filter(kind => typeof kind === 'string') : [];
                const official = requestOfficialPostOperation(kinds);
                const canRequest = record.post_status !== 'deleted' && findOperation(api, 'POST', requestPostOperation.path) &&
                  !(recordRows(record.post_operations) ?? []).some(row => ['manual', 'queued', 'submitting', 'accepted', 'outcome_unknown'].includes(String(row.status)));
                return <>
                <PostAudit post={record} onComplete={findOperation(api, 'POST', completePostOperation.path) ? operation => {
                  open(completePostOperation.path, completePostOperation, [rowId(operation)], operation);
                } : undefined} />
                {canRequest && <button onClick={() => open(requestPostOperation.path, requestPostOperation, ids, record)}>{label(requestPostOperation.label)}</button>}
                {canRequest && kinds.length > 0 && <button onClick={() => open(official.path, official, ids, record)}>{label(official.label)}</button>}
              </>;
              })()}
              {group === 'variants' && <section className="message"><h3>{t('draftPreview')}</h3><p>{stringValue(asRecord(record.draft_doc).body ?? asRecord(asRecord(record.draft_doc).rendered).text) || '—'}</p></section>}
              {group === 'imports' && <ImportReview key={ids.at(-1)} batch={record} id={ids.at(-1)!} />}
              {module.key === 'commerce' && group === 'stores' && rowId(record) && <StoreSyncCenter key={selected} store={record} />}
              {group === 'stores' && findOperation(api, 'POST', '/stores/:id/imports') && <button className="primary" onClick={() => importTab(undefined, selected)}>{label(['匯入店鋪 CSV', 'Import store CSV'])}</button>}
              {group === 'conversations' && <><InboxThread key={selected} record={record} /><InboxActivity record={record} /></>}
              {group === 'replies' && conversation.data && <InboxDraft key={relatedId} draft={record} conversation={thread} onSubmitted={id => onRelated('delivery', id)} />}
              {group === 'deliveries' && conversation.data && <InboxDelivery delivery={record} conversation={thread} />}
              {group === 'conversations' && <InboxEngagement id={selected} record={record} open={open} />}
              {group === 'autoRules' && <InboxRuleRuns id={selected} />}
              {group === 'reviews' && <ReviewDetails id={selected} record={record} open={open} />}
              {group === 'reviewSources' && <ReviewSourceDetails id={selected} record={record} open={open} />}
              {group === 'customers' && <CustomerIdentities record={record} />}
              {module.key === 'lifecycle' && record.id === selected && <>
                {group === 'customers' && <LifecycleConsent id={selected} />}
                {group === 'segments' && <LifecycleAudience record={record} />}
                {group === 'espCampaigns' && <LifecycleCampaign key={selected} record={record} />}
                {group === 'flows' && <LifecycleFlow key={selected} record={record} />}
              </>}
              {group === 'creators' && Boolean(detail.creator) && <><CreatorAudienceObservations record={entity(detail.creator)} open={open} /><CreatorProfileAssociations id={selected} open={open} /></>}
              {group === 'collabs' && selected && <><CreatorAttribution key={selected} id={selected} /><CreatorCollaborationLive id={selected} open={open} /></>}
              {group === 'live' && Boolean(detail.live_session) && <CreatorLiveSession record={{ ...entity(detail.live_session), clips: detail.clips }} open={open} />}
              {group === 'leads' && <LeadFollowup record={record} open={open} />}
              {!['imports', 'replies', 'stores'].includes(group) && <Actions group={group} record={record} open={open} ids={ids} seed={group === 'variants' ? { base_revision_id: record.current_revision_id ?? null } : group === 'conversations' ? { message_id: record.last_message_id } : {}} />}
              {group === 'products' && record.id != null && <ProductDetail key={rowId(record)} product={record} />}
              {module.key === 'commerce' && group === 'promotions' && record.id != null && <PromotionDetail key={rowId(record)} record={record} />}
              {(group === 'work' || group === 'content') && rowId(record) && <CommandLanguage><AgentAssistant key={rowId(record)} wid={api.ws} page={module.key}
                role={api.session.workspaces.find(workspace => workspace.id === api.ws)?.role ?? ''}
                row={{ id: rowId(record), kind: group === 'work' ? 'work_item' : 'content_item', data: record, version: Number(record.version) }} /></CommandLanguage>}
              <LinkedDetails group={group} record={{ ...record, id: rowId(record) || ids.at(-1) }} open={open} onRelated={onRelated} />
              <details><summary>{t('data')}</summary><Json value={Object.keys(record).length ? record : { id: ids.at(-1) }} /></details>
            </div>}
          </>}
        </Panel>}
        {isInbox && <InboxContext record={thread} hasSelection={Boolean(selected && conversation.data)} onOpenDraft={id => onRelated('reply', id)} />}
      </div>
    </>}
    {isProducts && creatingProduct && <ProductForm close={() => setCreatingProduct(false)} saved={row => { setFilter(''); setCursors([]); choose(rowId(row), 'products'); }} />}
    {batch && <ApprovalBatch requests={batch} close={() => { setBatch(undefined); setChecked([]); }} />}
    {selection && <OperationForm selection={selection} onClose={() => setSelection(undefined)} follow={follow} />}
  </>;
}

function ResourceTable({ rows, resource, compact, onPick }: { rows: RecordData[]; resource: Resource; compact: boolean; onPick: (row: RecordData) => void }) {
  const { t } = useCopy();
  const fields = resource.fields ?? ['name', 'status', 'updated_at'];
  const rowIndexes = new Map(rows.map((row, index) => [row, index]));
  return <EntityTable records={rows} rowKey={row => `${rowId(row)}-${rowIndexes.get(row)}`} columns={[
    { label: t(fields[0], { defaultValue: fields[0] }), cell: row => <button className="text-button table-title" onClick={() => onPick(row)}>{stringValue(row[fields[0]]) || rowTitle(row) || t('view')}</button> },
    ...fields.slice(1, compact ? 2 : undefined).map(field => ({ label: t(field, { defaultValue: field }), cell: (row: RecordData) => <Display name={field} value={row[field]} /> })),
  ]} />;
}

function Advanced({ module, onOpen }: { module: Module; onOpen: (selection: Selection) => void }) {
  const api = useApi();
  const { t } = useCopy();
  const [filter, setFilter] = useState('');
  const operations = api.catalog.filter(op => op.module === module.key && operationPath(op, api.ws) && `${op.name} ${op.path} ${op.summary ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return <Panel><div className="panel-head"><h2>{t('advanced')}</h2><input value={filter} onChange={event => setFilter(event.target.value)} aria-label={t('search')} placeholder={t('search')} /></div>{operations.length ? <div className="operation-list">{operations.map(op => <button key={`${op.method}-${op.path}`} onClick={() => onOpen({ op })}><Pill>{op.method}</Pill><span><strong>{op.name}</strong><code>{operationPath(op, api.ws)}</code>{op.summary && <small>{op.summary}</small>}</span><ArrowRight size={16} /></button>)}</div> : <EmptyState title={t(filter ? 'noMatches' : 'noAccess')} detail={!filter ? t('noAccessDetail') : undefined} />}</Panel>;
}
