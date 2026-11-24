import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { fill } from '../copy';
import type { AlertChannelsView, OwnerAlert } from '../data/hub-types';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, PageHeader, RouterLink, Section, useText } from '../parts';
import { alertKindText, hub } from '../hub-copy';
import { Badge, Empty, WriteError, isoLocal, localLabel, todayIn, tr, useHubWrite } from '../hub-parts';

const local = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');
const tone = (alert: OwnerAlert) => alert.severity === 'urgent' ? 'critical' : alert.severity === 'normal' ? 'warning' : 'neutral';

function AlertRow({ alert, onRead }: { alert: OwnerAlert; onRead?: (id: string) => void }) {
  const { l, lang } = useText();
  return <li className={`hub-alert ${alert.read_at ? 'read' : 'unread'}`}>
    <div className="hub-alert-head"><Badge tone={tone(alert)}>{tr(l, alertKindText, alert.kind)}</Badge>
      <time dateTime={alert.at} className="muted hub-small">{localLabel(isoLocal(alert.at), todayIn(), lang)}</time></div>
    <RouterLink to={local(alert.web_url)} className="hub-alert-title">{alert.title}</RouterLink>
    {alert.body && <p>{alert.body}</p>}
    <p className="hub-links">
      {alert.post && <RouterLink to={local(alert.post.web_url)}>{alert.post.label}</RouterLink>}
      {alert.channel && <RouterLink to={local(alert.channel.web_url)}>{alert.channel.label}</RouterLink>}
      {alert.machine && <RouterLink to={local(alert.machine.web_url)}>{alert.machine.label}</RouterLink>}
      {!alert.read_at && onRead && <button type="button" className="vs-link-button" onClick={() => onRead(alert.id)}>{l(hub.alerts.markRead)}</button>}
    </p>
  </li>;
}

function useMarkRead() {
  const write = useHubWrite();
  const [error, setError] = useState<unknown>();
  return { error, mark: async (body: { ids: string[] } | { all: true }) => {
    setError(undefined);
    try { await write('POST', '/hub/alerts/read', body); } catch (failure) { setError(failure); }
  } };
}

/** Header bell (§9.1): unread count, the latest alerts, each linked to its post, channel or machine. */
export function AlertBell() {
  const { l } = useText();
  const { base } = useViewContext();
  const read = useView<OwnerAlert[]>('/views/alerts');
  // WV-13: views_alerts pages at 50; the count is every unread alert (all pages of ?unread=true), not the first page's.
  const unreadRead = useView<OwnerAlert[]>('/views/alerts', { unread: 'true' }, { allPages: true });
  const { mark, error } = useMarkRead();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const alerts = Array.isArray(read.value) ? read.value : [];
  const unread = Array.isArray(unreadRead.value) ? unreadRead.value.length : alerts.filter(alert => !alert.read_at).length;
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return <div className="hub-bell" ref={box}>
    <button type="button" className="vs-icon-button hub-bell-button" aria-expanded={open} aria-haspopup="dialog"
      aria-label={`${l(hub.alerts.bell)}${unread ? ` · ${fill(l(hub.alerts.unread), { n: unread })}` : ''}`} onClick={() => setOpen(!open)}>
      <Bell size={17} aria-hidden="true" />{unread > 0 && <span className="hub-bell-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <div className="hub-bell-panel" role="dialog" aria-label={l(hub.alerts.bell)}>
      <header><strong>{l(hub.alerts.bell)}</strong>{unread > 0 && <button type="button" className="vs-link-button" onClick={() => void mark({ all: true })}>{l(hub.alerts.markAll)}</button>}</header>
      {alerts.length ? <ul className="hub-alert-list">{alerts.slice(0, 8).map(alert => <AlertRow key={alert.id} alert={alert} onRead={id => void mark({ ids: [id] })} />)}</ul>
        : <p className="muted">{l(hub.alerts.empty)}</p>}
      <WriteError error={error} />
      <footer><RouterLink to={`${base}/notifications`}>{l(hub.alerts.all)}</RouterLink><RouterLink to={`${base}/settings/notifications`}>{l(hub.alerts.settings)}</RouterLink></footer>
    </div>}
  </div>;
}

/** /app/:ws/notifications — every owner alert, newest first. */
export function NotificationsPage() {
  const { l } = useText();
  const { base } = useViewContext();
  const [params, setParams] = useSearchParams();
  const unreadOnly = params.get('unread') === 'true';
  // WV-13: every alert, not only the newest page of 50.
  const read = useView<OwnerAlert[]>('/views/alerts', { unread: unreadOnly ? 'true' : undefined }, { allPages: true });
  const { mark, error } = useMarkRead();
  return <>
    <PageHeader title={l(hub.alerts.title)} subtitle={l(hub.alerts.subtitle)} asOf={read.asOf}>
      <label className="hub-check"><input type="checkbox" checked={unreadOnly} onChange={event => setParams(event.target.checked ? { unread: 'true' } : {}, { replace: true })} />{l(hub.alerts.onlyUnread)}</label>
      <button type="button" className="vs-btn" onClick={() => void mark({ all: true })}>{l(hub.alerts.markAll)}</button>
      <RouterLink to={`${base}/settings/notifications`} className="vs-btn">{l(hub.alerts.settings)}</RouterLink>
    </PageHeader>
    <WriteError error={error} />
    <Loaded read={read}>{alerts => <section className="vs-card">{alerts.length ? <ul className="hub-alert-list">{alerts.map(alert => <AlertRow key={alert.id} alert={alert} onRead={id => void mark({ ids: [id] })} />)}</ul>
      : <Empty>{l(hub.alerts.empty)}</Empty>}</section>}</Loaded>
  </>;
}

type Kind = 'ntfy' | 'bark' | 'telegram';
interface Draft { kind: Kind; url: string; chat_id: string; token: string; clearToken: boolean; token_set: boolean }
const toDraft = (channel: AlertChannelsView['channels'][number]): Draft => ({ kind: channel.kind, url: channel.url ?? '', chat_id: channel.chat_id ?? '', token: '', clearToken: false, token_set: !!channel.token_set });

/** /app/:ws/settings/notifications — phone push (ntfy, Bark, Telegram), a test push and the two optional alerts (§5.9, S10). */
export function NotificationSettingsPage() {
  const { l, lang } = useText();
  const read = useView<AlertChannelsView>('/hub/alerts/channels');
  const write = useHubWrite();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [prefs, setPrefs] = useState<AlertChannelsView['preferences'] | null>(null);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState<string>();
  const view = read.value;
  const current = drafts ?? view?.channels.map(toDraft) ?? [];
  const preferences = prefs ?? view?.preferences ?? { published: true, daily_summary: true };
  const update = (index: number, patch: Partial<Draft>) => setDrafts(current.map((draft, at) => at === index ? { ...draft, ...patch } : draft));
  async function act(key: string, call: () => Promise<string>) {
    setPending(key); setError(undefined); setMessage(undefined);
    try { setMessage(await call()); } catch (failure) { setError(failure); } finally { setPending(undefined); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void act('save', async () => {
      const channels = current.map(draft => draft.kind === 'ntfy' ? { kind: 'ntfy', url: draft.url.trim(), ...(draft.clearToken ? { token: null } : draft.token ? { token: draft.token.trim() } : {}) }
        : draft.kind === 'bark' ? { kind: 'bark', url: draft.url.trim() }
          : { kind: 'telegram', chat_id: draft.chat_id.trim(), ...(draft.clearToken ? { bot_token: null } : draft.token ? { bot_token: draft.token.trim() } : {}) });
      await write('PUT', '/hub/alerts/channels', { channels, preferences });
      setDrafts(null); setPrefs(null);
      return l(hub.push.saved);
    });
  }
  const missing = (['ntfy', 'bark', 'telegram'] as Kind[]).filter(kind => !current.some(draft => draft.kind === kind));
  return <>
    <PageHeader title={l(hub.push.title)} subtitle={l(hub.push.subtitle)} asOf={read.asOf} />
    <Loaded read={read}>{loaded => <form className="hub-detail" onSubmit={save}>
      <Section title={l(hub.push.channels)}>
        {current.length === 0 && <p className="muted">{l(hub.push.none)}</p>}
        {current.map((draft, index) => {
          const saved = loaded.channels.find(channel => channel.kind === draft.kind);
          const test = saved?.last_test;
          return <fieldset key={draft.kind} className="hub-push">
            <legend>{l(hub.push[draft.kind])}</legend>
            {draft.kind !== 'telegram' ? <label className="hub-field">{l(draft.kind === 'ntfy' ? hub.push.ntfyUrl : hub.push.barkUrl)}
              <input type="url" required inputMode="url" value={draft.url} onChange={event => update(index, { url: event.target.value })} /></label>
              : <label className="hub-field">{l(hub.push.telegramChat)}<input required value={draft.chat_id} onChange={event => update(index, { chat_id: event.target.value })} /></label>}
            {draft.kind !== 'bark' && <label className="hub-field">{l(draft.kind === 'ntfy' ? hub.push.ntfyToken : hub.push.telegramToken)}
              <input type="password" autoComplete="off" value={draft.token} placeholder={draft.token_set ? l(hub.push.tokenSet) : ''} disabled={draft.clearToken}
                required={draft.kind === 'telegram' && !draft.token_set} onChange={event => update(index, { token: event.target.value })} />
              {draft.token_set && <span className="hub-check"><input type="checkbox" checked={draft.clearToken} onChange={event => update(index, { clearToken: event.target.checked })} />{l(hub.push.clearToken)}</span>}</label>}
            {draft.kind === 'ntfy' && /^https:\/\/ntfy\.sh\//.test(draft.url) && <p className="muted hub-small">{l(hub.push.publicTopic)}</p>}
            {test && <p className="hub-small">{l(hub.push.lastTest)}: <Badge tone={test.status === 'sent' ? 'good' : test.status === 'failed' ? 'critical' : 'neutral'}>
              {test.status === 'sent' ? l(hub.push.sent) : test.status === 'failed' ? l(hub.push.failed) : l(hub.push.queued)}</Badge> {test.at && localLabel(isoLocal(test.at), todayIn(), lang)} {test.error ?? ''}</p>}
            {saved?.last_delivery && <p className="hub-small muted">{l(hub.push.lastDelivery)}: {saved.last_delivery.at && localLabel(isoLocal(saved.last_delivery.at), todayIn(), lang)} {saved.last_delivery.error ?? ''}</p>}
            <button type="button" className="vs-link-button" onClick={() => setDrafts(current.filter((_, at) => at !== index))}>{l(hub.push.remove)}</button>
          </fieldset>;
        })}
        {missing.length > 0 && <div className="vs-actions">{missing.map(kind => <button key={kind} type="button" className="vs-btn"
          onClick={() => setDrafts([...current, { kind, url: '', chat_id: '', token: '', clearToken: false, token_set: false }])}>{l(hub.push.add)} · {l(hub.push[kind])}</button>)}</div>}
        <div className="vs-actions">
          <button type="button" className="vs-btn" disabled={!loaded.channels.length || !!pending || drafts !== null} onClick={() => void act('test', async () => {
            await write('POST', '/hub/alerts/test', {}); return l(hub.push.testQueued);
          })}>{l(hub.push.test)}</button>
        </div>
      </Section>
      <Section title={l(hub.push.prefs)}>
        <label className="hub-check"><input type="checkbox" checked={preferences.published} onChange={event => setPrefs({ ...preferences, published: event.target.checked })} />{l(hub.push.published)}</label>
        <label className="hub-check"><input type="checkbox" checked={preferences.daily_summary} onChange={event => setPrefs({ ...preferences, daily_summary: event.target.checked })} />{l(hub.push.dailySummary)}</label>
        <p className="muted hub-small">{l(hub.push.prefsHint)}</p>
      </Section>
      <Section title={l(hub.push.laptop)}><p>{l(hub.push.laptopHint)}</p><p className="muted">{l(hub.push.tailnet)}</p></Section>
      <div className="hub-savebar">
        <button type="submit" className="vs-btn primary-soft" disabled={(!drafts && !prefs) || pending === 'save'}>{pending === 'save' ? l(hub.common.saving) : l(hub.common.save)}</button>
        {message && <p className="vs-notice good" role="status">{message}</p>}
        <WriteError error={error} />
      </div>
    </form>}</Loaded>
  </>;
}
