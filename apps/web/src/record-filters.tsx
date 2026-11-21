import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { listSavedViews, saveView, type SavedView } from './saved-views-api';
import { api, ApiError, recordOptions, submission, type Entity, type Submission } from './workbench-api';
import { Dialog, Failure, recordName, useFormat } from './workbench-ui';

const dimensions = [
  ['brand_id', ['brand_id'], ['workspace', 'brand']],
  ['account_id', ['account_id', 'social_account_id'], ['account', 'social_account']],
  ['platform', ['platform', 'provider']],
  ['market_id', ['market_id'], ['workspace', 'market']],
  ['campaign_id', ['campaign_id'], ['campaign', 'campaign']],
  ['assignee_id', ['assignee_id', 'assignee_user_id', 'owner_user_id', 'owner_id']],
] as const;

export type Filters = Record<string, string>;
const recordDate = (row: Entity) => String(row.data.scheduled_at ?? row.data.due_at ?? row.data.published_at ?? row.updated_at).slice(0, 10);
const dimensionValue = (row: Entity, keys: readonly string[]) => String(keys.map(key => row.data[key]).find(value => typeof value === 'string') ?? '');

export function matchesFilters(row: Entity, filters: Filters) {
  const day = recordDate(row);
  return (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to) &&
    dimensions.every(([key, fields]) => !filters[key] || dimensionValue(row, fields) === filters[key]);
}

const filterKeys = ['from', 'to', ...dimensions.map(([key]) => key)];

function readFilters(value: unknown): Filters {
  if (!value || typeof value !== 'object') return {};
  const fields = value as Record<string, unknown>;
  return Object.fromEntries(filterKeys.flatMap(key => {
    const entry = fields[key];
    return Object.hasOwn(fields, key) && typeof entry === 'string' && entry ? [[key, entry]] : [];
  }));
}

type PresetFilters = { filters: Filters; change: (value: Filters) => void };
type PresetScope = { wid: string; userId: string; role: string; resourceType: string };

export function RecordFilters({ storageKey, wid, userId, role, resourceType, rows, filters, change, names = {} }:
  PresetFilters & PresetScope & { storageKey: string; rows: Entity[]; names?: Record<string, string> }) {
  const { t, label } = useFormat();
  const options = dimensions.map(([key, fields, ref]) => ({ key, ref, values: [...new Set(rows.map(row => dimensionValue(row, fields)).filter(Boolean))].sort() }));
  const queries = useQueries({ queries: options.map(({ ref, values }) => ({ ...recordOptions(wid, ref?.[0] ?? '', ref?.[1] ?? ''), enabled: Boolean(ref && values.length) })) });
  const set = (name: string, value: string) => change({ ...filters, [name]: value });
  return <details className="wb-dimension-filters"><summary>{t('ui.dimensionFilters')}</summary><div className="wb-filter">
    {options.map(({ key, ref, values }, index) => (values.length > 0 || filters[key]) && <label key={key}>{label('field', key)}<select value={filters[key] ?? ''} onChange={event => set(key, event.target.value)}>
      <option value="">{t('ui.allValues')}</option>{[...new Set([...values, filters[key]].filter(Boolean))].map(value => {
        const row = queries[index].data?.find(record => record.id === value);
        return <option key={value} value={value}>{row ? recordName(row) : ref ? names[value] ?? value : label('state', value)}</option>;
      })}
    </select></label>)}
    <label>{t('ui.from')}<input type="date" value={filters.from ?? ''} onChange={event => set('from', event.target.value)} /></label>
    <label>{t('ui.untilDate')}<input type="date" min={filters.from} value={filters.to ?? ''} onChange={event => set('to', event.target.value)} /></label>
  </div>
    <FilterPresets key={`${userId}:${storageKey}`} {...{ wid, userId, role, resourceType, storageKey, filters, change }} />
  </details>;
}

const presetCopy = {
  select: ['篩選預設', 'Filter presets', '筛选预设'],
  empty: ['尚無篩選預設', 'No filter presets yet', '尚无筛选预设'],
  create: ['新增預設', 'New preset', '添加预设'],
  update: ['以目前篩選更新預設', 'Update preset with current filters', '以目前筛选更新预设'],
  name: ['預設名稱', 'Preset name', '预设名称'],
  visibility: ['可見範圍', 'Visibility', '可见范围'],
  personal: ['個人', 'Personal', '个人'],
  shared: ['工作區共享', 'Workspace shared', '工作区共享'],
  save: ['儲存預設', 'Save preset', '保存预设'],
  saved: ['已儲存預設', 'Preset saved', '已保存预设'],
  conflict: ['此預設已變更。請關閉並重新開啟編輯視窗。', 'This preset changed. Close and reopen the editor.', '此预设已变更。请关闭并重新打开编辑窗口。'],
} as const;

function FilterPresets({ wid, userId, role, resourceType, storageKey, filters, change }:
  PresetScope & PresetFilters & { storageKey: string }) {
  const { t, label, locale } = useFormat();
  const copy = (key: keyof typeof presetCopy) => label('ui', key, presetCopy[key]);
  const [selectedId, setSelectedId] = useState('');
  const [editing, setEditing] = useState<SavedView | 'new'>();
  const [saved, setSaved] = useState(false);
  const catalog = useQuery({
    queryKey: ['workspace', wid, 'permission-operations'],
    queryFn: ({ signal }) => api.permissionOperations(wid, signal),
  });
  const allowed = (action: 'list' | 'create' | 'update') =>
    catalog.data?.some(op => op.name === `workspace_saved_views_${action}`) ?? false;
  const canList = allowed('list');
  const queryKey = ['workspace', wid, 'saved-views', userId] as const;
  const views = useQuery({ queryKey, queryFn: ({ signal }) => listSavedViews(wid, signal), enabled: canList });

  if ((catalog.isSuccess && !canList) || (catalog.error instanceof ApiError && catalog.error.status === 404)) {
    return <LocalPresets {...{ storageKey, filters, change }} />;
  }
  if (catalog.isError) return <Failure error={catalog.error} retry={() => void catalog.refetch()} />;
  if (views.isError) return <Failure error={views.error} retry={() => void views.refetch()} />;
  if (catalog.isPending || views.isPending) return <p className="wb-note" role="status">{t('ui.loading')}</p>;

  const scoped = views.data.filter(view => view.resource_type === resourceType)
    .sort((left, right) => left.name.localeCompare(right.name, locale));
  const selected = scoped.find(view => view.id === selectedId);
  const canEdit = selected?.owner_id === userId && allowed('update');
  return <div className="wb-filter">
    <label>{copy('select')}<select value={selected?.id ?? ''} disabled={!scoped.length} onChange={event => {
      setSelectedId(event.target.value);
      setSaved(false);
    }}>
      <option value="">{scoped.length ? t('ui.select') : copy('empty')}</option>
      {scoped.map(view => <option key={view.id} value={view.id}>{view.name} ({copy(view.shared ? 'shared' : 'personal')})</option>)}
    </select></label>
    <button type="button" disabled={!selected} onClick={() => { if (selected) change(readFilters(selected.filters)); }}>{t('ui.apply')}</button>
    {allowed('create') && <button type="button" onClick={() => { setSaved(false); setEditing('new'); }}>{copy('create')}</button>}
    {canEdit && <button type="button" onClick={() => { setSaved(false); setEditing(selected); }}>{copy('update')}</button>}
    {saved && <span role="status">{copy('saved')}</span>}
    {editing && <PresetEditor wid={wid} resourceType={resourceType} filters={filters} current={editing === 'new' ? undefined : editing}
      canShare={['owner', 'admin', 'manager', 'analyst', 'editor'].includes(role)} queryKey={queryKey}
      close={() => setEditing(undefined)} onSaved={view => { setSelectedId(view.id); setSaved(true); }} />}
  </div>;
}

function PresetEditor({ wid, resourceType, filters, current, canShare, queryKey, close, onSaved }: {
  wid: string; resourceType: string; filters: Filters; current?: SavedView; canShare: boolean;
  queryKey: readonly string[]; close: () => void; onSaved: (view: SavedView) => void;
}) {
  const { t, label } = useFormat();
  const copy = (key: keyof typeof presetCopy) => label('ui', key, presetCopy[key]);
  const client = useQueryClient();
  const attempt = useRef<Submission>(undefined);
  const write = useMutation({
    mutationFn: ({ body, key }: Submission) => saveView(wid, body, key, current),
    onSuccess: view => {
      client.setQueryData<SavedView[]>(queryKey, previous => [...(previous ?? []).filter(item => item.id !== view.id), view]);
      void client.invalidateQueries({ queryKey });
    },
    onError: error => {
      if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey });
    },
  });
  const conflict = write.error instanceof ApiError && write.error.status === 409;
  const title = copy(current ? 'update' : 'create');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (write.isPending || conflict) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    if (!name) return;
    const shared = form.get('visibility') === 'shared';
    const body = {
      name,
      filters: readFilters(filters),
      ...(!current && { resource_type: resourceType }),
      ...(canShare || (current?.shared && !shared) ? { shared } : {}),
    };
    attempt.current = submission(body, attempt.current);
    write.mutate(attempt.current, { onSuccess: view => { onSaved(view); close(); } });
  }
  return <Dialog title={title} close={() => { if (!write.isPending) close(); }}>
    <form className="wb-form" onSubmit={submit}><fieldset disabled={write.isPending || conflict}>
      <label>{copy('name')}<input name="name" defaultValue={current?.name} maxLength={250} required onChange={event => {
        event.currentTarget.setCustomValidity(event.currentTarget.value.trim() ? '' : t('ui.invalid'));
      }} /></label>
      {(canShare || current?.shared) && <label>{copy('visibility')}<select name="visibility" defaultValue={current?.shared ? 'shared' : 'personal'}>
        <option value="personal">{copy('personal')}</option>
        <option value="shared">{copy('shared')}</option>
      </select></label>}
      <button className="wb-primary" type="submit">{write.isPending ? t('ui.loading') : copy('save')}</button>
    </fieldset></form>
    {conflict ? <p role="alert">{copy('conflict')}</p> : write.isError && <Failure error={write.error} />}
  </Dialog>;
}

function LocalPresets({ storageKey, filters, change }: PresetFilters & { storageKey: string }) {
  const { t } = useFormat();
  const [saved, setSaved] = useState<Filters>();
  const [error, setError] = useState<unknown>();
  function save() {
    setError(undefined);
    setSaved(undefined);
    try {
      localStorage.setItem(storageKey, JSON.stringify(filters));
      setSaved(filters);
    } catch (failure) { setError(failure); }
  }
  function restore() {
    setError(undefined);
    setSaved(undefined);
    try {
      change(readFilters(JSON.parse(localStorage.getItem(storageKey) ?? '{}')));
    } catch (failure) { setError(failure); }
  }
  return <div className="wb-filter">
    <button type="button" onClick={save}>{t('ui.saveView')}</button>
    <button type="button" onClick={restore}>{t('ui.savedView')}</button>
    {saved === filters && <span role="status">{t('ui.filtersSaved')}</span>}
    {error != null && <Failure error={error} />}
  </div>;
}
