import { useEffect, useRef, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleDot, Inbox, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError, type Entity } from './workbench-api';
import { titleCase } from './catalog';

export const statusOf = (record: Entity) => String(record.data.status ?? record.data.state ?? record.data.production_stage ?? '');
export const recordName = (record: Entity) => String(record.data.title ?? record.data.name ?? record.data.subject ?? record.data.display_name ?? record.data.email ?? record.data.sku ?? record.data.slug ?? record.id);
export function useFormat() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? 'zh-Hant';
  return {
    locale, t,
    number: (value: number) => new Intl.NumberFormat(locale).format(value),
    date: (value: string, includeTime = false) => {
      const date = new Date(value);
      return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', ...(includeTime ? { timeStyle: 'short' } : {}) }).format(date);
    },
    label: (prefix: string, key: string, copy?: readonly [string, string]) => copy ? copy[locale === 'en' ? 1 : 0] : t(`${prefix}.${key}`, { defaultValue: titleCase(key.split('.').at(-1) ?? key) }),
  };
}
export function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t } = useTranslation();
  const apiError = error instanceof ApiError ? error : undefined;
  const forbidden = apiError?.status === 403;
  const missing = apiError?.status === 404;
  return <div className="wb-error" role="alert"><CircleAlert size={18} /><div><strong>{t(forbidden ? 'ui.forbidden' : missing ? 'ui.endpointUnavailable' : 'ui.error')}</strong>{apiError?.message && <p>{apiError.message}</p>}</div>{retry && <button onClick={retry}>{t('ui.retry')}</button>}</div>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="wb-empty"><Inbox size={22} aria-hidden="true" /><p>{children}</p></div>;
}
export function Status({ value }: { value: string }) {
  const { label } = useFormat();
  if (!value) return <>—</>;
  const good = /^(approved|active|published|resolved|done|ready|succeeded|healthy|connected|completed)$/.test(value);
  const bad = /critical|failed|blocked|invalid|reject|error|revoked/.test(value);
  const warn = /pending|unknown|high|partial|stale|degraded/.test(value);
  const Icon = good ? CircleCheck : bad ? CircleAlert : CircleDot;
  return <span className={`wb-status ${good ? 'good' : bad ? 'bad' : warn ? 'warn' : 'neutral'}`}><Icon size={13} aria-hidden="true" />{label('state', value)}</span>;
}
export function Detail({ record }: { record: Entity }) {
  const { label, date } = useFormat();
  return <dl className="wb-fields">{Object.entries({ id: record.id, ...record.data, version: record.version, updated_at: record.updated_at }).map(([key, value]) => <div key={key}><dt>{label('field', key)}</dt><dd>{typeof value === 'object' && value !== null ? <pre>{JSON.stringify(value, null, 2)}</pre> : /_at$/.test(key) && typeof value === 'string' ? date(value, true) : String(value ?? '—')}</dd></div>)}</dl>;
}
export function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="wb-drawer" aria-label={title} onCancel={event => { event.preventDefault(); close(); }}><header><h2>{title}</h2><button className="wb-icon" aria-label={t('ui.close')} onClick={close}><X size={20} /></button></header><div className="wb-drawer-body">{children}</div></dialog>;
}
