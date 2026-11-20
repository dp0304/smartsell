import { waitForReportVersion, type ReportGenerationStatus } from './report-generation';
import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { asRecord, operationPath, parameterNames, type Operation, type RecordData } from '@smartsell/sdk';
import { Drawer } from '@smartsell/ui';
import { callOperation, findOperation, ProblemNotice, recordRows, rowTitle, stringValue, useApi, useRead, versionOf, wsKey } from './api';
import type { Action, Field } from './actions';
import { useCopy } from './i18n';

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

function Input({ field, initial, lookupIds = [], choices, onChange }: { field: Field; initial: string; lookupIds?: string[]; choices?: RecordData[]; onChange?: (value: string) => void }) {
  const { t, label } = useCopy();
  const lookup = useRead(field.lookup ?? '/__none__', lookupIds);
  const listId = `reference-${field.key}`;
  const common = { name: field.key, defaultValue: initial, required: !field.optional, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => onChange?.(event.target.value) };
  return <label className="field">{field.label ? label(field.label) : field.key}{field.optional || <span aria-hidden="true"> *</span>}
    {field.type === 'file' ? <input name={field.key} type="file" accept=".csv,text/csv" /> : field.type === 'select' ? <select {...common}><option value="">{t('select')}</option>{field.options?.map(value => <option key={value}>{value}</option>)}</select> :
      ['textarea', 'json', 'array'].includes(field.type ?? '') ? <textarea {...common} rows={field.type === 'textarea' ? 4 : 6} spellCheck={field.type === 'textarea'} /> :
        <input {...common} type={field.type && ['date', 'datetime-local', 'email', 'url'].includes(field.type) ? field.type : 'text'} list={field.lookup || choices ? listId : undefined} />}
    {(field.lookup || choices) && <datalist id={listId}>{(choices ?? recordRows(lookup.data?.data))?.map((record, index) => {
      const value = field.key === 'template_key' ? record.key ?? record.template_key ?? record.id : record.id;
      return <option key={`${stringValue(value)}-${index}`} value={stringValue(value)}>{rowTitle(record)}</option>;
    })}</datalist>}
    {lookup.isError && <small>{t('referenceLoadFailed')}</small>}
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
  if (field.type === 'datetime-local') return new Date(value).toISOString();
  if (field.type === 'url' && !['https:', 'http:'].includes(new URL(value).protocol)) throw new Error('invalid_url');
  return value;
}

function initialValue(field: Field, record: RecordData) {
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
  const { t, label } = useCopy();
  const api = useApi();
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
    return { ...variant, name: [variant.platform, variant.locale, variant.format].filter(Boolean).join(' · ') };
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
  const followRecord = asRecord(result?.data);
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
      setInvalid(t(code === 'file_too_large' ? 'fileTooLarge' : code === 'select_one_import_source' ? 'selectImportSource' : 'jsonError'));
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

  return <Drawer title={action ? label(action.label) : op.name} closeLabel={t('close')} onClose={() => { if (!pending) onClose(); }}>
    <div className="endpoint"><b>{op.method}</b><code>{path}</code></div>
    {!action && op.summary && <p className="muted">{op.summary}</p>}
    <form onSubmit={submit} className="fields">
      <fieldset disabled={pending || (write && Boolean(result))}>
        {names.map((name, index) => ids[index] ? <div key={name} className="field"><span>{name}</span><code>{ids[index]}</code></div> : <Input key={name} field={{ key: `parameter-${name}`, label: [name, name] }} initial="" />)}
        {action?.fields?.map(field => {
          const initial = initialValue(field, { ...(op.method === 'PATCH' ? record : {}), ...seed });
          if (scheduling && field.key === 'content_item_id') return <Input key={field.key} field={field} initial={initial} onChange={value => { setContentId(value); setVariantId(''); }} />;
          if (scheduling && field.key === 'content_variant_id') return <Input key={`${field.key}:${contentId}`} field={field} initial={contentId === seed.content_item_id ? initial : ''} choices={variants} onChange={setVariantId} />;
          if (scheduling && field.key === 'variant_revision_id') return <Input key={`${field.key}:${variantId}`} field={{ ...field, lookup: '/content-variants/:id/revisions' }} lookupIds={[variantId]} initial={variantId === seed.content_variant_id ? initial : ''} />;
          return <Input key={field.key} field={field} initial={initial} />;
        })}
        {!action && <label className="field">{t(write ? 'payload' : 'parameters')}<textarea rows={8} name={write ? 'payload' : 'query'} defaultValue="{}" spellCheck={false} /></label>}
        {write && (requiredVersion || !action) && !versionOf(record) && <label className="field">{t('version')}<input name="if-match" required={requiredVersion} /><small>{t('versionHelp')}</small></label>}
        {((write && !action) || action?.confirm) && <label className="check"><input type="checkbox" required />{t('confirmAction')}</label>}
        <button className="primary" type="submit">{pending ? t('saving') : t(action ? 'save' : 'execute')}</button>
      </fieldset>
      {invalid && <p className="problem" role="alert">{invalid}</p>}
      {error !== undefined && <ProblemNotice error={error} />}
    </form>
    {pending && reportJob?.status === 'queued' && <section className="result">
      <p role="status">{t('reportQueued')} <code>{reportJob.operation_id}</code></p>
      {cancelJob && <button onClick={() => void cancelReport()} disabled={cancelling}>{t('cancelReportGeneration')}</button>}
    </section>}
    {result && <section className="result"><strong role="status">{t(reportJob ? 'done' : write ? 'accepted' : 'result')}</strong><Json value={result} />
      {canFollow ? <button className="primary" onClick={() => follow(followKind!, followRecord)}>{t('view')}</button> : null}</section>}
  </Drawer>;
}
