import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { type RecordData } from '@smartsell/sdk';
import { Busy } from '@smartsell/ui';
import { callOperation, entity, findOperation, ProblemNotice, ReadState, recordRows, rowTitle, stringValue, useApi, useRead, wsKey } from './api';
import { useCopy } from './i18n';

const running = new Set(['queued', 'running', 'rate_limited', 'cancel_requested']);
const failed = new Set(['failed', 'partially_succeeded']);
const p0bProviders = new Set(['shopify', 'tiktok_shop']);
const storeRoot = (ws: string) => `/w/${encodeURIComponent(ws)}/commerce`;
const isInitialSync = (store: RecordData) => Boolean(store.connection_id && !store.last_snapshot_at &&
  ['connecting', 'degraded', 'needs_reauth'].includes(stringValue(store.status)));

const failureLabels: Record<string, [string, string, string?]> = {
  authorization_required: ['授權缺失或已失效', 'Authorization is missing or expired', '授权缺失或已失效'],
  connection_invalid: ['授權已失效', 'The store authorization is no longer valid', '授权已失效'],
  ip_not_allowed: ['平台不允許目前的出口 IP', 'The platform does not allow the current outbound IP', '平台不允许目前的出口 IP'],
  invalid_provider_cursor: ['平台回傳的分頁游標無效', 'The platform returned an invalid pagination cursor', '平台回传的分页光标无效'],
  manual_import_available: ['平台不支援此同步，可改用檔案匯入', 'This sync is unavailable; use file import instead', '平台不支持此同步，可改用文件导入'],
  provider_request_failed: ['平台商品目錄請求失敗', 'The platform catalog request failed', '平台商品目录请求失败'],
  source_unavailable: ['商品資料來源無法使用', 'The catalog data source is unavailable', '商品数据源无法使用'],
};

function catalogRuns(value: unknown) {
  return (recordRows(value) ?? []).filter(row => row.resource === 'products' && row.run_type === 'catalog_snapshot')
    .sort((a, b) => stringValue(b.created_at).localeCompare(stringValue(a.created_at)) || stringValue(b.id).localeCompare(stringValue(a.id)));
}

function latestCatalogRun(store: RecordData, source: RecordData, runs: RecordData[]) {
  return runs.find(run => run.data_source_id === source.id &&
    (store.provider !== 'tiktok_shop' || run.id === store.catalog_snapshot_run_id));
}

function catalogState(store: RecordData, source: RecordData, latest?: RecordData) {
  const status = stringValue(latest?.status);
  const reason = store.status !== 'needs_reauth' && source.status_reason === 'ip_not_allowed' ? 'ip_not_allowed' : stringValue(store.status_reason);
  return {
    reason,
    connectionBlocked: store.status === 'needs_reauth' || reason === 'ip_not_allowed',
    pending: running.has(status),
    runFailed: failed.has(status),
  };
}

function CatalogSyncStatus({ store, source, latest, runs, controls = false, emptyState }: {
  store: RecordData; source: RecordData; latest?: RecordData; runs: ReturnType<typeof useRead>; controls?: boolean; emptyState?: ReactNode;
}) {
  const api = useApi();
  const client = useQueryClient();
  const { t, label } = useCopy();
  const storeId = stringValue(store.id);
  const sourceId = stringValue(source.id);
  const { reason, connectionBlocked, pending, runFailed } = catalogState(store, source, latest);
  const problem = connectionBlocked || runFailed;
  const failure = (connectionBlocked && reason ? reason : stringValue(latest?.error_reason)) || 'provider_request_failed';
  const retry = findOperation(api, 'POST', '/sync-runs/:id/retry', 'ingest');
  const start = findOperation(api, 'POST', '/stores/:id/sync', 'commerce');
  const register = findOperation(api, 'POST', '/data-sources', 'ingest');
  const canCollect = Boolean(store.connection_id && ['connecting', 'degraded', 'active'].includes(stringValue(store.status)) && !connectionBlocked);
  const [action, setAction] = useState<'retry' | 'start' | 'register'>();
  const [error, setError] = useState<unknown>();
  const waiting = Boolean(sourceId && runs.op && runs.isPending);

  async function collect(kind: NonNullable<typeof action>) {
    if (action) return;
    setAction(kind);
    setError(undefined);
    try {
      if (kind === 'retry' && retry && latest) await callOperation(api, retry, [stringValue(latest.id)], { body: {} });
      if (kind === 'start' && start) await callOperation(api, start, [storeId], { body: { mode: 'full', resource: 'products' } });
      if (kind === 'register' && register) await callOperation(api, register, [], { body: {
        kind: 'store', name: rowTitle(store), provider: store.provider, store_id: store.id,
        connection_id: store.connection_id, resources: ['products'],
      } });
      await client.invalidateQueries({ queryKey: wsKey(api.ws) });
    } catch (failure) { setError(failure); }
    finally { setAction(undefined); }
  }

  return <><section aria-label={label(['商品同步狀態', 'Catalog sync status', '商品同步状态'])} className="fields">
    {!controls && <strong>{rowTitle(store)}</strong>}
    {problem ? <div role="alert" className="problem"><strong>{label(['商品同步失敗', 'Catalog sync failed', '商品同步失败'])}</strong>
      <p>{failureLabels[failure] ? label(failureLabels[failure]) : failure} <small>({failure})</small></p>
    </div> : waiting ? <Busy label={t('loading')} /> : pending || isInitialSync(store) ? <div role="status">
      <strong>{label(['同步中', 'Syncing catalog'])}</strong>{!store.last_snapshot_at && <p>{label(['店鋪已連線，商品快照尚未完成。', 'The store is connected; its catalog snapshot is not complete yet.', '店铺已连接，商品快照尚未完成。'])}</p>}
    </div> : store.last_snapshot_at ? <p role="status">{label(['商品快照已完成', 'Catalog snapshot complete'])}</p> :
      controls && <p>{store.status === 'connecting' ? label(['等待店鋪授權', 'Awaiting store authorization', '等待店铺授权']) : label(['尚未同步商品', 'No catalog snapshot yet'])}</p>}
    {error !== undefined && <ProblemNotice error={error} />}
    <div className="toolbar">
      {canCollect && source.status === 'active' && runFailed && retry && <button type="button" disabled={Boolean(action)} onClick={() => void collect('retry')}>{label(['重試同步', 'Retry sync', '重试同步'])}</button>}
      {controls && canCollect && !waiting && !runs.isError && !pending && !runFailed && source.status === 'active' && start && <button type="button" disabled={Boolean(action)} onClick={() => void collect('start')}>{label(['同步商品目錄', 'Sync catalog', '同步商品目录'])}</button>}
      {controls && canCollect && !sourceId && register && <button type="button" disabled={Boolean(action)} onClick={() => void collect('register')}>{label(['建立唯讀商品資料來源', 'Set up read-only catalog source', '创建唯读商品数据源'])}</button>}
      {controls ? <Link to={`${storeRoot(api.ws)}/products?store=${encodeURIComponent(storeId)}`}>{label(['查看店鋪商品', 'View store products', '查看店铺商品'])}</Link> :
        <Link to={`${storeRoot(api.ws)}/stores/${encodeURIComponent(storeId)}`}>{label(['查看店鋪同步設定', 'Open store sync settings', '查看店铺同步设置'])}</Link>}
    </div>
  </section>{!problem && !waiting && !pending && !isInitialSync(store) && emptyState}</>;
}

function StoreCatalogSync({ store, controls, emptyState }: { store: RecordData; controls?: boolean; emptyState?: ReactNode }) {
  const source = entity(store.data_source);
  const sourceId = stringValue(source.id);
  const runs = useRead(sourceId ? '/sync-runs' : '/__none__', [], { data_source_id: sourceId }, 'ingest');
  return <>
    <CatalogSyncStatus store={store} source={source} latest={latestCatalogRun(store, source, catalogRuns(runs.data?.data))} runs={runs} controls={controls} emptyState={emptyState} />
    {runs.isError && <ReadState read={runs} />}
  </>;
}

export function ProductCatalogSync({ storeId, emptyState }: { storeId: string; emptyState?: ReactNode }) {
  return storeId ? <ScopedCatalogSync storeId={storeId} emptyState={emptyState} /> : <WorkspaceCatalogSync emptyState={emptyState} />;
}

function WorkspaceCatalogSync({ emptyState }: { emptyState?: ReactNode }) {
  const api = useApi();
  const stores = useRead('/stores', [], api.brandId ? { brand_id: api.brandId } : {}, 'commerce');
  const connected = (recordRows(stores.data?.data) ?? []).filter(store => store.connection_id && store.status !== 'disabled');
  const sources = useRead(connected.length ? '/data-sources' : '/__none__', [], {}, 'ingest');
  const storeSources = (recordRows(sources.data?.data) ?? []).filter(source => source.kind === 'store' && source.status !== 'disabled');
  const runs = useRead(storeSources.length ? '/sync-runs' : '/__none__', [], {}, 'ingest');
  const snapshots = catalogRuns(runs.data?.data);
  const visible = connected.flatMap(store => {
    const source = storeSources.find(source => source.store_id === store.id && source.connection_id === store.connection_id) ?? {};
    const latest = latestCatalogRun(store, source, snapshots);
    const { connectionBlocked, pending, runFailed } = catalogState(store, source, latest);
    return isInitialSync(store) || connectionBlocked || pending || runFailed ? [{ store, source, latest }] : [];
  });
  const reads = [stores, sources, runs];
  const loading = reads.find(read => read.op && read.isPending);
  return <>
    {reads.filter(read => read.op && read.isError).map(read => <ReadState key={read.op!.name} read={read} />)}
    {visible.map(({ store, source, latest }) => <CatalogSyncStatus key={stringValue(store.id)} store={store} source={source} latest={latest} runs={runs} />)}
    {!visible.length && emptyState && (loading ? <ReadState read={loading} /> : emptyState)}
  </>;
}

function ScopedCatalogSync({ storeId, emptyState }: { storeId: string; emptyState?: ReactNode }) {
  const read = useRead('/stores/:id', [storeId], {}, 'commerce');
  const store = entity(read.data?.data);
  if (!read.op) return emptyState ?? null;
  if (!read.data) return <ReadState read={read} />;
  return <StoreCatalogSync store={store} emptyState={emptyState} />;
}

export function StoreSyncCenter({ store }: { store: RecordData }) {
  const api = useApi();
  const client = useQueryClient();
  const { t, label } = useCopy();
  const connect = p0bProviders.has(stringValue(store.provider)) && findOperation(api, 'POST', '/stores/:id/connect', 'commerce');
  const canAttach = Boolean(connect && ['import_only', 'needs_reauth', 'connecting'].includes(stringValue(store.status)) &&
    (!store.connection_id || store.status === 'needs_reauth'));
  const connections = useRead(canAttach ? '/connections' : '/__none__', [], {}, 'account');
  const candidates = (recordRows(connections.data?.data) ?? []).filter(row =>
    row.provider === store.provider && row.brand_id === store.brand_id && row.purpose === 'store' && row.status === 'active' &&
    (typeof row.expires_at !== 'string' || Date.parse(row.expires_at) > Date.now()));
  const [choice, setChoice] = useState('');
  const [externalChoice, setExternalChoice] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<unknown>();
  const connectionId = candidates.some(row => row.id === choice) ? choice : '';
  const accounts = useRead('/connections/:id/accounts', [connectionId], {}, 'account');
  const availableAccounts = (recordRows(accounts.data?.data) ?? []).filter(account => typeof account.external_account_id === 'string' &&
    (!store.external_store_id || store.external_store_id === account.external_account_id));
  const externalId = availableAccounts.length === 1 ? stringValue(availableAccounts[0].external_account_id) :
    availableAccounts.some(account => account.external_account_id === externalChoice) ? externalChoice : '';
  async function attach() {
    if (!connect || !connectionId || !externalId || attaching) return;
    setAttaching(true);
    setError(undefined);
    try {
      await callOperation(api, connect, [stringValue(store.id)], { body: {
        connection_id: connectionId, external_store_id: externalId,
      } });
      await client.invalidateQueries({ queryKey: wsKey(api.ws) });
    } catch (failure) { setError(failure); }
    finally { setAttaching(false); }
  }
  return <>
    <h3>{label(['店鋪同步中心', 'Store sync center', '店铺同步中心'])}</h3>
    <StoreCatalogSync store={store} controls />
    {canAttach && connections.op && <>
      <ReadState read={connections} />
      {connections.data && (candidates.length ? <div className="fields">
        <label className="field">{label(['已授權的店鋪連線', 'Authorized store connection', '已授权的店铺连接'])}
          <select value={choice} onChange={event => { setChoice(event.target.value); setExternalChoice(''); }}><option value="">{t('select')}</option>
            {candidates.map(item => <option key={stringValue(item.id)} value={stringValue(item.id)}>{stringValue(item.id)}</option>)}
          </select>
        </label>
        {connectionId && <ReadState read={accounts} />}
        {accounts.data && !availableAccounts.length && <p>{label(['此授權與店鋪身分不符。', 'This authorization does not match the store.', '此授权与店铺身分不符。'])}</p>}
        {availableAccounts.length > 0 && <label className="field">{label(['已驗證的店鋪', 'Verified store', '已验证的店铺'])}
          <select value={externalId} onChange={event => setExternalChoice(event.target.value)}><option value="">{t('select')}</option>
            {availableAccounts.map(account => <option key={stringValue(account.external_account_id)} value={stringValue(account.external_account_id)}>{stringValue(account.display_name ?? account.external_account_id)}</option>)}
          </select>
        </label>}
        <button type="button" disabled={!externalId || attaching} onClick={() => void attach()}>{label(['連接既有店鋪', 'Connect existing store', '连接既有店铺'])}</button>
      </div> : <p>{label(['請先在帳號管理取得與此品牌及店鋪相符的唯讀平台授權。', 'First authorize read-only access for this brand and store in Accounts.', '请先在账号管理取得与此品牌及店铺相符的唯读平台授权。'])}</p>)}
      {error !== undefined && <ProblemNotice error={error} />}
    </>}
  </>;
}
