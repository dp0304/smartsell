import { waitForReportVersion, type ReportGenerationStatus } from './report-generation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { asRecord, operationPath, parameterNames, type Operation, type RecordData } from '@smartsell/sdk';
import { Drawer } from '@smartsell/ui';
import { callOperation, entity, findOperation, ProblemNotice, recordRows, rowTitle, stringValue, useApi, useRead, versionOf, wsKey } from './api';
import type { Action, Field } from './actions';
import { useCopy } from './i18n';
import { optionLabel, timeZoneChoices } from './option-labels';
import { useDeveloperMode } from './preferences';

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

// Where to create a record when a reference picker has nothing to choose from.
const createRoutes: Record<string, string> = {
  '/brands': 'settings/brands', '/campaigns': 'campaigns', '/content-items': 'content', '/social-accounts': 'settings/accounts',
  '/model-providers': 'automation/models', '/data-sources': 'data/sources', '/import-templates': 'data?tab=templates',
  '/templates': 'assets/templates', '/products': 'commerce', '/stores': 'commerce/stores', '/members': 'settings/members',
};

function optionText(record: RecordData, locale: string) {
  if (record.revision_no !== undefined) {
    const when = typeof record.created_at === 'string' && Number.isFinite(Date.parse(record.created_at))
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.created_at)) : '';
    return [locale === 'en' ? `Version ${stringValue(record.revision_no)}` : `第 ${stringValue(record.revision_no)} 版`, when].filter(Boolean).join(' · ');
  }
  const title = rowTitle(record);
  const extra = [record.platform ?? record.provider, record.handle].map(stringValue).filter(Boolean).map(value => optionLabel(value, locale));
  return [title, ...extra].filter(Boolean).join(' · ') || stringValue(record.id);
}

function optionValue(field: Field, record: RecordData) {
  return stringValue(field.key === 'template_key' ? record.key ?? record.template_key ?? record.id : record.id);
}

function Hint({ field }: { field: Field }) {
  const { label } = useCopy();
  return field.hint ? <small>{label(field.hint)}</small> : null;
}

function ReferencePicker({ field, initial, lookupIds = [], choices, pending = false, createPath, onChange }: { field: Field; initial: string; lookupIds?: string[]; choices?: RecordData[]; pending?: boolean; createPath?: string; onChange?: (value: string) => void }) {
  const { t, label, locale } = useCopy();
  const api = useApi();
  const lookup = useRead(choices ? '/__none__' : field.lookup ?? '/__none__', lookupIds);
  const waitingForParent = lookupIds.some(id => !id);
  // Member rows carry only IDs and roles, so describe them by who they are rather than by UUID.
  const records = (choices ?? recordRows(lookup.data?.data))?.map(record => field.lookup !== '/members' || rowTitle(record) !== stringValue(record.id) ? record : {
    ...record, title: [record.user_id === api.session.user.id ? label(['我', 'Me']) : label(['成員', 'Member']) + ' ' + stringValue(record.user_id ?? record.id).slice(0, 8),
      record.role ? optionLabel(stringValue(record.role), locale) : ''].filter(Boolean).join(' · '),
  });
  const multiple = field.type === 'ids';
  const [value, setValue] = useState(initial);
  const [picked, setPicked] = useState<string[]>(() => initial.split(',').map(id => id.trim()).filter(Boolean));
  // Preselect the only option, or the newest saved version, so nobody has to copy IDs between screens.
  const preferred = !records?.length ? '' : records.some(record => record.revision_no !== undefined)
    ? optionValue(field, [...records].sort((a, b) => Number(b.revision_no) - Number(a.revision_no))[0])
    : records.length === 1 && !field.optional ? optionValue(field, records[0]) : '';
  useEffect(() => {
    if (!multiple && !value && preferred) { setValue(preferred); onChange?.(preferred); }
  }, [multiple, preferred, value, onChange]);
  const caption = <>{field.label ? label(field.label) : field.key}{field.optional || <span aria-hidden="true"> *</span>}</>;
  const route = createPath ?? (field.lookup ? createRoutes[field.lookup] : undefined);
  if (waitingForParent) return <label className="field">{caption}<select disabled><option>{label(['請先完成上一個欄位', 'Complete the previous field first'])}</option></select><input type="hidden" name={field.key} value="" /></label>;
  // Without read access, or when the list fails, accept a typed ID so the form still works.
  if (!choices && !pending && (!lookup.op || lookup.isError)) {
    return <label className="field">{caption}<input name={field.key} defaultValue={initial} required={!field.optional} onChange={event => onChange?.(event.target.value)} />
      <small>{t('referenceLoadFailed')}</small></label>;
  }
  if (!records || pending) return <label className="field">{caption}<select disabled><option>{t('loading')}</option></select></label>;
  if (!records.length) return <div className="field">{caption}<div className="field-empty">
    <span>{label(['目前沒有可選的項目', 'Nothing to choose yet'])}</span>
    {route && <Link to={`/w/${encodeURIComponent(api.ws)}/${route}`}>{label(['前往建立', 'Create one'])} →</Link>}
  </div>{!field.optional && <input type="hidden" name={field.key} value="" required />}</div>;
  if (multiple) return <fieldset className="field choice-list"><legend>{caption}</legend>
    {records.map(record => {
      const id = optionValue(field, record);
      return <label key={id} className="check"><input type="checkbox" checked={picked.includes(id)} onChange={event => {
        const next = event.target.checked ? [...picked, id] : picked.filter(item => item !== id);
        setPicked(next); onChange?.(next.join(','));
      }} />{optionText(record, locale)}</label>;
    })}
    <input type="hidden" name={field.key} value={picked.join(',')} />
    <Hint field={field} />
  </fieldset>;
  return <label className="field">{caption}
    <select name={field.key} value={value} required={!field.optional} onChange={event => { setValue(event.target.value); onChange?.(event.target.value); }}>
      <option value="">{t('select')}</option>
      {records.map((record, index) => <option key={`${optionValue(field, record)}-${index}`} value={optionValue(field, record)}>{optionText(record, locale)}</option>)}
    </select><Hint field={field} />
  </label>;
}

function Input({ field, initial, lookupIds = [], choices, pending, createPath, onChange }: { field: Field; initial: string; lookupIds?: string[]; choices?: RecordData[]; pending?: boolean; createPath?: string; onChange?: (value: string) => void }) {
  const { t, label, locale } = useCopy();
  if (field.type === 'ref' || choices || (field.type === 'ids' && field.lookup)) {
    return <ReferencePicker field={field} initial={initial} lookupIds={lookupIds} choices={choices} pending={pending} createPath={createPath} onChange={onChange} />;
  }
  const common = { name: field.key, defaultValue: initial, required: !field.optional, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => onChange?.(event.target.value) };
  return <label className="field">{field.label ? label(field.label) : field.key}{field.optional || <span aria-hidden="true"> *</span>}
    {field.type === 'file' ? <input name={field.key} type="file" accept=".csv,text/csv" /> :
      field.type === 'select' ? <select {...common}><option value="">{t('select')}</option>{field.options?.map(value => <option key={value} value={value}>{optionLabel(value, locale)}</option>)}</select> :
      field.type === 'timezone' ? <select {...common}>{timeZoneChoices(initial).map(zone => <option key={zone} value={zone}>{zone}</option>)}</select> :
      ['textarea', 'json', 'array'].includes(field.type ?? '') ? <textarea {...common} rows={field.type === 'textarea' ? 4 : 6} spellCheck={field.type === 'textarea'} /> :
        <input {...common} type={field.type && ['date', 'datetime-local', 'email', 'url'].includes(field.type) ? field.type : 'text'} />}
    <Hint field={field} />
  </label>;
}

function object(text: string): RecordData {
  const value: unknown = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not_object');
  return asRecord(value);
}

function readField(field: Field, value: string) {
  if (field.type === 'ids') return value.split(',').map(id => id.trim()).filter(Boolean);
  if (field.type === 'json') return object(value);
  if (field.type === 'array') {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('not_array');
    return parsed;
  }
  if (field.type === 'datetime-local') return field.keepLocal ? value : new Date(value).toISOString();
  if (field.type === 'url' && !['https:', 'http:'].includes(new URL(value).protocol)) throw new Error('invalid_url');
  return value;
}

function initialValue(field: Field, record: RecordData) {
  if (field.read) return field.read(record);
  const value = record[field.key];
  if (value === undefined || value === null) return field.initial ?? '';
  if (field.type === 'json' || field.type === 'array') return JSON.stringify(value, null, 2);
  if (field.type === 'ids' && Array.isArray(value)) return value.join(', ');
  if (field.type === 'datetime-local') {
    const date = new Date(String(value));
    if (Number.isNaN(date.valueOf())) return '';
    return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  return stringValue(value);
}

export interface Selection {
  op: Operation;
  action?: Action;
  ids?: string[];
  record?: RecordData;
  seed?: RecordData;
}

export function OperationForm({ selection, onClose, follow }: { selection: Selection; onClose: () => void; follow: (kind: NonNullable<Action['follow']>, record: RecordData) => void }) {
  const { t, label, locale } = useCopy();
  const api = useApi();
  const developer = useDeveloperMode();
  const client = useQueryClient();
  const { op, action, ids = [], record = {}, seed = {} } = selection;
  const path = operationPath(op, api.ws)!;
  const names = parameterNames(path);
  const write = op.method !== 'GET';
  const scheduling = path === '/publish-targets' && op.method === 'POST';
  const [contentId, setContentId] = useState(stringValue(seed.content_item_id));
  const [variantId, setVariantId] = useState(stringValue(seed.content_variant_id));
  const content = useRead('/content-items/:id', [scheduling ? contentId : '']);
  const variants = recordRows(asRecord(content.data?.data).variants)?.map(row => {
    const variant = asRecord(row.variant ?? row);
    return { id: variant.id, title: [variant.platform, variant.locale, variant.format].map(stringValue).filter(Boolean).map(value => optionLabel(value, locale)).join(' · ') };
  });
  const requiredVersion = Boolean(write && (op.requires_version || op.requires_if_match || op.version_kind || op.versionKind || action?.versioned || (!action && ids.length === 0 && ['PATCH', 'PUT', 'DELETE'].includes(op.method))));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [invalid, setInvalid] = useState('');
  const [result, setResult] = useState<{ data: unknown; next_cursor?: string | null }>();
  const [reportJob, setReportJob] = useState<ReportGenerationStatus>();
  const [cancelling, setCancelling] = useState(false);
  const cancelJob = findOperation(api, 'POST', '/operations/:id/cancel');
  async function cancelReport() {
    if (!reportJob || !cancelJob || cancelling) return;
    setCancelling(true);
    try {
      await callOperation(api, cancelJob, [reportJob.operation_id], { version: reportJob.version, key: crypto.randomUUID() });
    } catch (failure) {
      setError(failure);
    } finally { setCancelling(false); }
  }
  const flight = useRef(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const followKind = action?.follow;
  // Create endpoints answer either with the record or with a wrapper such as { item, variants }.
  const response = asRecord(result?.data);
  const nestedRecord = Object.values(response).map(entity).find(value => typeof value.id === 'string');
  const followRecord = followKind === 'record' && !response.id && nestedRecord ? nestedRecord : response;
  const canFollow = followKind && (followRecord.id || asRecord(followRecord[followKind]).id || followRecord[`${followKind}_id`] || (followKind === 'import' && followRecord.import_batch_id));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (flight.current) return;
    setError(undefined); setInvalid(''); setResult(undefined); setReportJob(undefined);
    const form = new FormData(event.currentTarget);
    const fieldValue = (name: string) => String(form.get(name) ?? '').trim();
    const values = names.map((name, index) => ids[index] ?? fieldValue(`parameter-${name}`));
    const version = write ? versionOf(record) || fieldValue('if-match') : '';
    if (requiredVersion && !version) { setInvalid(t('versionMissing')); return; }
    flight.current = true; setPending(true);
    let body: RecordData | undefined;
    let query: Record<string, string> | undefined;
    try {
      if (write) {
        const input: RecordData = {};
        for (const field of action?.fields ?? []) {
          if (field.type === 'file') {
            const file = form.get(field.key);
            if (file instanceof File && file.size) {
              if (file.size > 1_000_000) throw new Error('file_too_large');
              input[field.key] = await file.text();
            }
            continue;
          }
          const value = fieldValue(field.key);
          if (!value && !field.optional) throw new Error('missing_field');
          if (value) input[field.key] = readField(field, value);
        }
        body = action ? (action.body?.({ ...seed, ...input }) ?? { ...seed, ...input }) : object(fieldValue('payload'));
      } else {
        query = Object.fromEntries(Object.entries(object(fieldValue('query'))).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value ?? '')]));
      }
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : '';
      setInvalid(t(code === 'file_too_large' ? 'fileTooLarge' : code === 'select_one_import_source' ? 'selectImportSource' : code === 'missing_field' ? 'missingField' : 'jsonError'));
      flight.current = false; setPending(false); return;
    }
    if (values.some(value => !value || value === '.' || value === '..' || /[/\\]/.test(value))) { setInvalid(t('jsonError')); flight.current = false; setPending(false); return; }
    const signature = JSON.stringify([values, body, version]);
    if (write && attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    try {
      const response = await callOperation(api, op, values, { body, query, version, key: attempt.current?.key });
      const operationId = asRecord(response.data).operation_id;
      if (op.name === 'reports_generate_version' && typeof operationId === 'string') {
        const status = findOperation(api, 'GET', '/operations/:id')!;
        const version = findOperation(api, 'GET', '/report-versions/:id')!;
        const ref = await waitForReportVersion(async () => (await callOperation(api, status, [operationId])).data as ReportGenerationStatus,
          setReportJob);
        setResult(await callOperation(api, version, [ref.version_id]));
      } else setResult(response);
      if (write) void client.invalidateQueries({ queryKey: wsKey(api.ws) });
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : '';
      if (code === 'report_generation_cancelled' || code === 'report_generation_failed') {
        attempt.current = null;
        setInvalid(t(code === 'report_generation_cancelled' ? 'reportGenerationCancelled' : 'reportGenerationFailed'));
      } else setError(failure);
    } finally { flight.current = false; setPending(false); }
  }

  const fieldFor = (field: Field) => {
    const initial = initialValue(field, { ...(op.method === 'PATCH' ? record : {}), ...seed });
    if (scheduling && field.key === 'content_item_id') return <Input key={field.key} field={field} initial={initial} onChange={value => { setContentId(value); setVariantId(''); }} />;
    if (scheduling && field.key === 'content_variant_id') return <Input key={`${field.key}:${contentId}`} field={field} initial={contentId === seed.content_item_id ? initial : ''} choices={variants ?? []} pending={Boolean(content.op) && content.isPending} createPath={`content?tab=content&id=${encodeURIComponent(contentId)}`} lookupIds={[contentId]} onChange={setVariantId} />;
    if (scheduling && field.key === 'variant_revision_id') return <Input key={`${field.key}:${variantId}`} field={{ ...field, lookup: '/content-variants/:id/revisions' }} lookupIds={[variantId]} initial={variantId === seed.content_variant_id ? initial : ''} />;
    return <Input key={field.key} field={field} initial={initial} />;
  };
  const fields = action?.fields ?? [];
  const advancedFields = fields.filter(field => field.advanced);
  const createdRecord = response.id ? entity(response) : entity(response[followKind ?? ''] ?? nestedRecord ?? response);
  // Records without a name fall back to their ID, which means nothing to the reader.
  const created = rowTitle(createdRecord) === stringValue(createdRecord.id) ? '' : rowTitle(createdRecord);

  return <Drawer title={action ? label(action.label) : op.name} closeLabel={t('close')} onClose={() => { if (!pending) onClose(); }}>
    {(developer || !action) && <div className="endpoint"><b>{op.method}</b><code>{path}</code></div>}
    {!action && op.summary && <p className="muted">{op.summary}</p>}
    <form onSubmit={submit} className="fields">
      <fieldset disabled={pending || (write && Boolean(result))}>
        {names.map((name, index) => ids[index] ? developer && <div key={name} className="field"><span>{name}</span><code>{ids[index]}</code></div> : <Input key={name} field={{ key: `parameter-${name}`, label: [name, name] }} initial="" />)}
        {fields.filter(field => !field.advanced).map(fieldFor)}
        {advancedFields.length > 0 && <details className="form-more"><summary>{label(['更多設定', 'More settings'])}</summary>{advancedFields.map(fieldFor)}</details>}
        {!action && <label className="field">{t(write ? 'payload' : 'parameters')}<textarea rows={8} name={write ? 'payload' : 'query'} defaultValue="{}" spellCheck={false} /></label>}
        {write && (requiredVersion || !action) && !versionOf(record) && <label className="field">{t('version')}<input name="if-match" required={requiredVersion} /><small>{t('versionHelp')}</small></label>}
        {((write && !action) || action?.confirm) && <label className="check"><input type="checkbox" required />{t('confirmAction')}</label>}
        {!(write && result) && <button className="primary" type="submit">{pending ? t('saving') : t(action ? 'save' : 'execute')}</button>}
      </fieldset>
      {invalid && <p className="problem" role="alert">{invalid}</p>}
      {error !== undefined && <ProblemNotice error={error} />}
    </form>
    {pending && reportJob?.status === 'queued' && <section className="result">
      <p role="status">{t('reportQueued')}{developer && <> <code>{reportJob.operation_id}</code></>}</p>
      {cancelJob && <button onClick={() => void cancelReport()} disabled={cancelling}>{t('cancelReportGeneration')}</button>}
    </section>}
    {result && <section className="result"><strong role="status">{write && !reportJob ? label(['已完成', 'Saved']) : t(reportJob ? 'done' : 'result')}</strong>
      {write && created && <p>{created}</p>}
      {(!write || developer) ? <details open={!write}><summary>{label(['回應資料', 'Response data'])}</summary><Json value={result} /></details> : null}
      <div className="action-row">
        {canFollow ? <button className="primary" onClick={() => follow(followKind!, followRecord)}>{t('view')}</button> : null}
        <button type="button" onClick={onClose}>{label(['完成', 'Done'])}</button>
      </div></section>}
  </Drawer>;
}
