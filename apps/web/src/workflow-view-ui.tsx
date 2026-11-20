import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { asRecord, type Method, type RecordData } from '@smartsell/sdk';
import { Pill } from '@smartsell/ui';
import { callOperation, findOperation, recordRows, stringValue, useApi, versionOf, wsKey } from './api';
import { useCopy } from './i18n';

export const records = (value: unknown) => recordRows(value) ?? [];
export function safeUrl(value: unknown) {
  try {
    const url = new URL(stringValue(value));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

export function Status({ value }: { value: unknown }) {
  const { t } = useCopy();
  const status = stringValue(value);
  if (!status) return <>—</>;
  const tone = /blocked|failed|rejected|invalid/.test(status) ? 'critical' : /unknown|pending|awaiting|warning|manual/.test(status) ? 'warning' : /approved|published|merged|resolved|ready|passed/.test(status) ? 'good' : 'neutral';
  return <Pill tone={tone}>{t(`state.${status}`, { defaultValue: status.replaceAll('_', ' ') })}</Pill>;
}

export function Timestamp({ value }: { value: unknown }) {
  const { locale } = useCopy();
  const stamp = stringValue(value);
  if (!stamp || !Number.isFinite(Date.parse(stamp))) return <>—</>;
  return <time dateTime={stamp}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(stamp))}</time>;
}

export function useWorkflowRequest() {
  const api = useApi();
  const client = useQueryClient();
  const flight = useRef(false);
  const attempt = useRef<{ signature: string; key: string } | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  async function run(method: Method, path: string, ids: string[], body?: RecordData, record?: RecordData) {
    const op = findOperation(api, method, path);
    if (!op || flight.current) return;
    flight.current = true;
    setPending(true);
    setError(undefined);
    const version = record && versionOf(record);
    const signature = JSON.stringify([method, path, ids, body, version]);
    if (method !== 'GET' && attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    try {
      const response = await callOperation(api, op, ids, { body, version, key: method === 'GET' ? undefined : attempt.current?.key });
      if (method !== 'GET') {
        attempt.current = undefined;
        await client.invalidateQueries({ queryKey: wsKey(api.ws) });
      }
      return asRecord(response.data);
    } catch (failure) {
      setError(failure);
    } finally {
      flight.current = false;
      setPending(false);
    }
  }
  return { run, pending, error };
}
