import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CircleCheck, RotateCcw } from 'lucide-react';
import { ApiError, api, recordOptions, submission, type Command, type Entity, type Payload, type Submission } from './workbench-api';
import { actions, type Action, type Field } from './catalog';
import { CommandResult, commandFollowUps } from './command-result';
import { asEntity, useCommandRead, values } from './workbench-data';
import { Dialog, Empty, Failure, recordName, useFormat } from './workbench-ui';

export const commandKey = (command: Command) => `${command.module}.${command.action}`;
export const hasCommandForm = (command: Command) => Object.hasOwn(actions, commandKey(command));
export function useCommands(wid: string, enabled = Boolean(wid)) {
  return useQuery({ queryKey: ['workspace', wid, 'commands'], enabled, queryFn: ({ signal }) => api.commands(wid, signal) });
}

function initialValue(field: Field, record?: Entity) {
  const value = field.seed === false ? undefined : record?.data[field.seed ?? field.name];
  if (field.shape === 'nullable-id' && value === null) return 'null';
  if (value == null) return field.default;
  if (field.type === 'lines' && Array.isArray(value)) return value.join('\n');
  if (field.type === 'datetime-local' && typeof value === 'string') {
    const date = new Date(value);
    return Number.isFinite(date.valueOf()) ? new Date(date.valueOf() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23).replace(/:00\.000$/, '') : field.default;
  }
  if (field.type === 'json') return JSON.stringify(value, null, 2);
  return String(value);
}

const creatorLookups: Record<string, string> = { 'creator.creator': 'creators_search', 'workspace.market': 'list_markets' };
const versionFields = ['expected_version', 'version'];

function Editor({ field, wid, record, spec, command, commands, invalid, clearError }: {
  field: Field; wid: string; record?: Entity; spec: Action; command: Command; commands: Command[];
  invalid: boolean; clearError: () => void;
}) {
  const { label, t, locale } = useFormat();
  // Keep the version paired with the field values displayed when the editor opened.
  const [bound] = useState(() => {
    if (!record) return;
    if (spec.targetField === field.name) return record.id;
    if (field.seed !== false && versionFields.includes(field.name) && record.version > 0) return record.version;
  });
  const [module = '', kind = ''] = field.ref ?? [];
  const needsLookup = Boolean(field.ref && bound === undefined);
  const lookup = command.module === 'creator' ? creatorLookups[`${module}.${kind}`] : undefined;
  const scoped = useCommandRead<unknown>(wid, commands, module, lookup ?? '', {}, needsLookup && Boolean(lookup));
  const query = useQuery({ ...recordOptions(wid, module, kind), enabled: needsLookup && !lookup, retry: (count, error) => !(error instanceof ApiError && [403, 404].includes(error.status)) && count < 2 });
  const options = lookup ? values(scoped.data).flatMap(value => asEntity(value, module, kind) ?? []) : query.data ?? [];
  const initial = initialValue(field, record);
  const [csv, setCsv] = useState(initial ?? '');
  const [readError, setReadError] = useState<unknown>();
  const upload = useRef(0);
  const fieldLabel = label('field', field.name, field.label);
  const attributes = { name: field.name, required: !field.optional, defaultValue: initial, 'aria-invalid': invalid || undefined, onChange: clearError };
  if (bound !== undefined) return <label>{fieldLabel}<input {...attributes} defaultValue={undefined} readOnly value={bound} /></label>;
  const manualReference = field.ref && (query.isError || scoped.isError || (lookup ? !scoped.permitted || scoped.isSuccess : query.isSuccess) && !options.length);
  const selectOptions = field.choices || field.ref && !manualReference;
  return <div className="wb-form-field"><label><span>{fieldLabel}{field.optional && <small>{t('ui.optional')}</small>}</span>
    {selectOptions ? <select {...attributes}><option value="">{t('ui.select')}</option>{initial && field.ref && !options.some(row => row.id === initial) && <option value={initial}>{initial}</option>}{options.map(row => <option value={row.id} key={row.id}>{recordName(row)}</option>)}{field.choices?.map(value => <option key={value} value={value}>{label('state', value)}</option>)}</select>
      : field.type === 'checkbox' ? <input name={field.name} type="checkbox" required={field.mustCheck} defaultChecked={initial === 'true'} aria-invalid={attributes['aria-invalid']} onChange={clearError} />
      : field.type === 'csv' ? <textarea name={field.name} required={attributes.required} value={csv} onChange={event => { ++upload.current; setCsv(event.target.value); setReadError(undefined); clearError(); }} rows={7} spellCheck={false} aria-invalid={attributes['aria-invalid']} />
      : field.type === 'textarea' || field.type === 'json' || field.type === 'lines' ? <textarea {...attributes} rows={5} spellCheck={field.type !== 'json'} />
      : <input {...attributes} type={field.secret ? 'password' : field.type ?? 'text'} min={field.min} max={field.max} step={field.type === 'number' ? field.integer ? 1 : 'any' : field.type === 'datetime-local' ? 'any' : undefined} />}
    </label>
    {manualReference && <small>{locale.startsWith('en') ? 'Enter a record ID.' : '請輸入紀錄 ID。'}</small>}
    {field.type === 'csv' && <><input type="file" accept=".csv,text/csv" aria-label={fieldLabel} onChange={event => {
      const file = event.target.files?.[0];
      const request = ++upload.current;
      if (file) void file.text().then(value => {
        if (request === upload.current) { setCsv(value); setReadError(undefined); clearError(); }
      }, error => { if (request === upload.current) setReadError(error); });
    }} />{readError != null && <Failure error={readError} />}{csv && <small>{t('ui.rows', { count: csv.trimEnd().split(/\r?\n/).length })}</small>}</>}
  </div>;
}

export function readForm(data: FormData, fields: Field[]): Payload {
  const body: Payload = {};
  for (const field of fields) {
    const { name } = field;
    const value = String(data.get(name) ?? '');
    const trimmed = value.trim();
    if (field.type === 'checkbox') {
      if (field.mustCheck && !data.has(name)) throw new Error(name);
      body[name] = data.has(name);
      continue;
    }
    if (!trimmed) {
      if (field.optional) continue;
      throw new Error(name);
    }
    if (field.choices && !field.choices.includes(trimmed)) throw new Error(name);
    if (field.type === 'number') {
      const number = Number(trimmed);
      if (!Number.isFinite(number) || field.integer && !Number.isSafeInteger(number) || field.min !== undefined && number < field.min || field.max !== undefined && number > field.max) throw new Error(name);
      body[name] = number;
    } else if (field.type === 'lines') {
      body[name] = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    } else if (field.shape === 'nullable-id') {
      body[name] = trimmed === 'null' ? null : trimmed;
      if (trimmed.startsWith('"')) {
        try { body[name] = JSON.parse(trimmed) as unknown; } catch { throw new Error(name); }
        if (typeof body[name] !== 'string' || !(body[name] as string).trim()) throw new Error(name);
      }
    } else if (field.type === 'json') {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { throw new Error(name); }
      if (field.shape === 'array' && !Array.isArray(parsed) || field.shape === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error(name);
      body[name] = parsed;
    } else if (field.type === 'datetime-local') {
      const instant = new Date(value);
      if (!Number.isFinite(instant.valueOf())) throw new Error(name);
      body[name] = instant.toISOString();
    } else {
      body[name] = field.type === 'csv' || field.type === 'textarea' || field.secret ? value : trimmed;
    }
  }
  return body;
}

function CommandForm({ wid, command, selected, commands, follow }: {
  wid: string; command: Command; selected?: Entity; commands: Command[]; follow: (action: string, row: Entity) => void;
}) {
  const { t, label } = useFormat();
  const queryClient = useQueryClient();
  const spec = actions[commandKey(command)];
  const previous = useRef<Submission>(undefined);
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [validation, setValidation] = useState<string>();
  const [confirmation, setConfirmation] = useState<Payload>();
  const [outcome, setOutcome] = useState<{ data: unknown }>();
  const decision = command.module === 'planning' && ['approve', 'reject', 'request_changes'].includes(command.action);
  const approval = decision && selected?.module === 'planning' && ['approval', 'approval_request'].includes(selected.kind) ? selected : undefined;
  const relatedId = typeof approval?.data.target_id === 'string' ? approval.data.target_id : undefined;
  const relatedTarget = useCommandRead<Payload>(wid, commands, 'planning', 'get_target', { target_id: relatedId }, Boolean(relatedId));
  const resolved = relatedTarget.data && asEntity(relatedTarget.data, 'planning', 'publish_target');
  const selectedKind = selected?.kind === 'variant_revision' ? 'content_revision' : selected?.kind;
  const record = approval && resolved?.id === relatedId && resolved ? { ...resolved, data: { ...resolved.data, frozen_hash: approval.data.frozen_hash ?? resolved.data.frozen_hash } }
    : selected?.module === (spec.targetModule ?? command.module) && selectedKind === spec.target ? selected : undefined;
  if (relatedId && relatedTarget.permitted && !record) {
    return relatedTarget.isError ? <Failure error={relatedTarget.error} retry={() => void relatedTarget.refetch()} />
      : relatedTarget.isPending ? <p role="status">{t('ui.loading')}</p> : <Empty>{t('ui.noForm')}</Empty>;
  }

  async function execute(body: Payload) {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setConfirmation(undefined);
    setFailure(undefined);
    setOutcome(undefined);
    const attempt = submission(body, previous.current);
    previous.current = attempt;
    try {
      const data = await api.execute(wid, command, attempt.body, attempt.key);
      setOutcome({ data });
      previous.current = undefined;
      void queryClient.invalidateQueries({ queryKey: ['workspace', wid] });
    } catch (error) {
      setFailure(error);
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidation(undefined);
    try {
      const body = readForm(new FormData(event.currentTarget), spec.fields);
      const problem = spec.validate?.(body);
      if (problem) throw new Error(problem);
      if (spec.confirm) setConfirmation(body);
      else void execute(body);
    } catch (error) {
      setValidation(error instanceof Error ? error.message : '');
    }
  }

  const result = outcome?.data && typeof outcome.data === 'object' ? outcome.data as Payload : undefined;
  const available = (action: string) => commands.some(item => item.module === command.module && item.action === action && hasCommandForm(item));
  const next = commandFollowUps(command, result).filter(item => available(item.action));
  const recheck = failure instanceof ApiError && failure.code === 'preflight_changed' && typeof previous.current?.body.batch_id === 'string' && available('preflight_import')
    ? asEntity({ id: previous.current.body.batch_id }, 'commerce', 'import_batch') : undefined;
  const invalidField = spec.fields.find(field => field.name === validation);
  return <><form className="wb-form" onSubmit={submit}>
    <fieldset disabled={pending || Boolean(confirmation)}>
      {spec.fields.map(field => <Editor key={`${record?.id ?? 'new'}:${field.name}`} field={field} wid={wid} record={record} spec={spec} command={command} commands={commands} invalid={invalidField === field} clearError={() => setValidation(undefined)} />)}
      {validation !== undefined && <p role="alert">{t('ui.invalid')} {invalidField && label('field', invalidField.name, invalidField.label)}</p>}
      <button className="wb-primary" type="submit">{pending ? t('ui.loading') : t('ui.run')}<ArrowRight size={16} /></button>
    </fieldset>
  </form>
    {confirmation && <div className="wb-confirm"><strong>{t('ui.confirm')}</strong><p>{t('ui.confirmHelp')}</p><dl className="wb-fields">{Object.entries(confirmation).filter(([name]) => !spec.fields.find(field => field.name === name)?.secret).map(([name, value]) => <div key={name}><dt>{label('field', name, spec.fields.find(field => field.name === name)?.label)}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl><button onClick={() => setConfirmation(undefined)}>{t('ui.cancel')}</button> <button className="wb-primary" onClick={() => void execute(confirmation)}>{t('ui.confirm')}</button></div>}
    {failure != null && <><Failure error={failure} />
      {recheck ? <button onClick={() => follow('preflight_import', recheck)}>{t('ui.recheckImport')}</button>
        : (!(failure instanceof ApiError) || failure.status === 408 || failure.status === 429 || failure.status >= 500) && <button onClick={() => previous.current && void execute(previous.current.body)} disabled={pending}><RotateCcw size={15} />{t('ui.replay')}</button>}
    </>}
    {outcome && <div className="wb-result" role="status">
      <strong><CircleCheck size={17} />{t('ui.succeeded')}</strong>
      {next.length > 0 && <div className="wb-inline-actions">{next.map(item => <button key={`${item.action}:${item.row.id}`} onClick={() => follow(item.action, item.row)}>
        {label('command', item.action, actions[`${command.module}.${item.action}`]?.label)}
      </button>)}</div>}
      <CommandResult module={command.module} action={command.action} result={result} raw={outcome.data} />
    </div>}
  </>;
}

interface CommandToolsProps { wid: string; commands: Command[]; initial?: Command; selected?: Entity }

export function CommandTools(props: CommandToolsProps) {
  const { wid, initial, selected } = props;
  return <CommandPicker key={`${wid}:${initial ? commandKey(initial) : ''}:${selected?.module ?? ''}:${selected?.kind ?? ''}:${selected?.id ?? ''}`} {...props} />;
}

function CommandPicker({ wid, commands, initial, selected }: CommandToolsProps) {
  const { t, label } = useFormat();
  const [selection, setSelection] = useState(() => ({ key: initial ? commandKey(initial) : '', row: selected }));
  const supported = commands.filter(hasCommandForm);
  const command = supported.find(item => commandKey(item) === selection.key);
  if (!supported.length) return <Empty>{t(commands.length ? 'ui.noForm' : 'ui.noTools')}</Empty>;
  return <>
    <label className="wb-form-field"><span>{t('ui.action')}</span><select value={command ? selection.key : ''} onChange={event => setSelection({ key: event.target.value, row: selected })}>
      <option value="">{t('ui.select')}</option>
      {supported.map(item => <option key={commandKey(item)} value={commandKey(item)}>{label('command', commandKey(item), actions[commandKey(item)].label)}</option>)}
    </select></label>
    {command && <CommandForm key={`${wid}:${selection.key}:${selection.row?.id ?? ''}`} wid={wid} command={command} selected={selection.row} commands={commands} follow={(action, row) => {
      const key = `${command.module}.${action}`;
      if (supported.some(item => commandKey(item) === key)) setSelection({ key, row });
    }} />}
  </>;
}

export function CommandPanel({ close, ...tools }: CommandToolsProps & { close: () => void }) {
  const { t } = useFormat();
  return <Dialog title={t('ui.tools')} close={close}><CommandTools {...tools} /></Dialog>;
}
