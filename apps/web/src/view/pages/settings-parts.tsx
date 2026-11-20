import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { ApiError, request, workspacePath, type Method, type RecordData } from '@smartsell/sdk';
import { ProblemNotice } from '../../api';
import { useViewContext } from '../data/use-view';
import { viewPrefix } from '../data/keys';
import { useText } from '../parts';
import { problemText } from './settings-logic';
import { text } from './settings-text';

/** Human-only writes from settings: CSRF, Idempotency-Key and an optional If-Match, then the dashboard reads refresh. */
export function useSettingsWrite() {
  const { ws, session } = useViewContext();
  const client = useQueryClient();
  return async <T,>(method: Method, path: string, options: { body?: RecordData; key?: string; version?: number | string } = {}) => {
    try { return await request<T>(`${workspacePath(ws)}${path}`, { method, body: options.body, key: options.key, version: options.version, csrf: session.csrf_token }); }
    finally { void client.invalidateQueries({ queryKey: viewPrefix(ws) }); }
  };
}

/** A plain-language line for known problems, with the API detail kept below it. */
export function WriteProblem({ error }: { error: unknown }) {
  const { l } = useText();
  const known = error instanceof ApiError ? problemText(error.status, error.problem.code) : undefined;
  return <div className="st-problem">{known && <p className="vs-notice warning" role="alert">{l(known)}</p>}<ProblemNotice error={error} /></div>;
}

/** A modal dialog; Escape and the close button both go through onClose so React owns the open state. */
export function Dialog({ title, onClose, children, busy = false }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean }) {
  const { l } = useText();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="st-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="st-dialog-head"><h2 id={titleId}>{title}</h2>
      <button type="button" className="vs-btn ghost vs-icon-button" aria-label={l(text.close)} disabled={busy} onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
    <div className="st-dialog-body">{children}</div>
  </dialog>;
}

export function Field({ label, hint, children, required = false }: { label: string; hint?: string; children: ReactNode; required?: boolean }) {
  const { l } = useText();
  return <label className="vs-field st-field"><span>{label}{required && <abbr className="st-required" title={l(text.required)} aria-hidden="true">*</abbr>}</span>{children}{hint && <small className="muted">{hint}</small>}</label>;
}

/** One Idempotency-Key per intended write: a retry reuses it, any edit to the form starts a new one. */
export function useStableKey() {
  const key = useRef<string>(undefined);
  return { take: () => (key.current ??= crypto.randomUUID()), reset: () => { key.current = undefined; } };
}
