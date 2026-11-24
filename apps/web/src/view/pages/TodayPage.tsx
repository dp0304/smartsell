import { useState } from 'react';
import { ExternalLink, Monitor } from 'lucide-react';
import { pauseOf, type MachineSummary, type PostSummary, type TodayData, type TodayGroup, type TodayItem } from '../data/hub-types';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, PageHeader, RouterLink, Section, useText } from '../parts';
import { RELOGIN, attentionKindText, hub } from '../hub-copy';
import { Badge, ChannelName, Empty, ModeBadge, OnlineBadge, PostStatusBadge, WriteError, ZoneNote, localLabel, providerName, tr, useHubWrite } from '../hub-parts';
import { reloginMessage, requestRelogin } from './ChannelPage';
import { PostDetail } from './post-detail';

const local = (path: string) => path.replace(/^https?:\/\/[^/]+/, '');
const POST_ACTIONS = new Set(['approve', 'reject', 'cancel', 'reschedule', 'retry', 'confirm_result', 'mark_not_published', 'force_release']);

/** What the card currently says; a notice about an earlier press belongs to the card as it was then (WV-9). */
export const cardSignature = (item: Pick<TodayItem, 'detail' | 'actions'>) => JSON.stringify([item.detail, item.actions.map(action => [action.kind, action.path ?? null])]);

function AttentionCard({ item, today, posts }: { item: TodayItem; today: string; posts: Map<string, PostSummary> }) {
  const { l, lang } = useText();
  const write = useHubWrite();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  // WV-9: 「已送出。」 is a notice, not a latch: the button stays usable (a check or resume can be needed again when the same
  // problem comes back), and the notice goes away once the card changes.
  const [sent, setSent] = useState<string | null>(null);
  const done = sent === cardSignature(item);
  const [notice, setNotice] = useState<string>();
  const post = item.post ? posts.get(item.post.id) : undefined;
  const postActions = item.actions.filter(action => POST_ACTIONS.has(action.kind));
  // 「重新登入」 (§9.2 login card, E21): on every login card, and wherever the hub offers open_login. It opens the sign-in window on the
  // channel's machine; the owner signs in there.
  const reloginChannel = item.channel && (item.kind === 'login' || item.actions.some(action => action.kind === 'open_login')) ? item.channel : null;
  async function call(path: string, body?: Record<string, unknown>) {
    setPending(true); setError(undefined); setNotice(undefined); setSent(null);
    try { await write('POST', path, body ?? {}); setSent(cardSignature(item)); } catch (failure) { setError(failure); } finally { setPending(false); }
  }
  async function relogin(channel: NonNullable<TodayItem['channel']>) {
    setPending(true); setError(undefined); setNotice(undefined);
    try { setNotice(reloginMessage(l, await requestRelogin(write, channel.id), { machine: item.machine?.label ?? l(hub.common.unknownMachine), channel: channel.label })); }
    catch (failure) { setError(failure); } finally { setPending(false); }
  }
  return <article className={`hub-attn sev-${item.severity}`} aria-labelledby={`attn-${item.id}`}>
    <header>
      <Badge tone={item.severity === 'urgent' ? 'critical' : 'warning'}>{tr(l, attentionKindText, item.kind)}</Badge>
      <h3 id={`attn-${item.id}`}>{item.post ? <RouterLink to={local(item.post.web_url)}>{item.title}</RouterLink> : item.title}</h3>
    </header>
    {item.detail && <p>{item.detail}</p>}
    {post && (post.caption_excerpt || item.kind === 'approval') && <p className="hub-quote">{post.caption_excerpt || l(hub.common.noCaption)}</p>}
    <p className="hub-links">
      {item.machine && <RouterLink to={local(item.machine.web_url)}>{item.machine.label}</RouterLink>}
      {item.channel && <RouterLink to={local(item.channel.web_url)}>{item.channel.label}</RouterLink>}
      {item.post && <RouterLink to={local(item.post.web_url)}>{l(hub.common.openPost)}</RouterLink>}
      {item.due_at && post?.approval_deadline_local && <span className="muted">{l(hub.today.deadline)} {localLabel(post.approval_deadline_local, today, lang)}</span>}
    </p>
    <div className="vs-actions">
      {reloginChannel && <button type="button" className="vs-btn primary-soft" disabled={pending} onClick={() => void relogin(reloginChannel)}>{l(RELOGIN.button)}</button>}
      {item.actions.filter(action => !POST_ACTIONS.has(action.kind) && action.kind !== 'open' && action.kind !== 'open_login').map(action => action.kind === 'open_remote'
        ? <a key={action.kind} className="vs-btn" href={action.path}>{action.label}</a>
        : action.path && action.method ? <button key={action.kind} type="button" className="vs-btn primary-soft" disabled={pending}
          onClick={() => void call(action.path!, action.body)}>{action.label}</button> : null)}
      {postActions.length > 0 && item.post && <button type="button" className="vs-btn primary-soft" aria-expanded={open} onClick={() => setOpen(!open)}>
        {postActions.map(action => action.label).join(' / ')}</button>}
      {!item.post && item.actions.some(action => action.kind === 'open') && <RouterLink to={local(item.web_url)} className="vs-btn">{item.actions.find(action => action.kind === 'open')!.label}</RouterLink>}
    </div>
    {notice && <p className="vs-notice good" role="status">{notice}</p>}
    {done && <p className="vs-notice good" role="status">{l(hub.action.done)}</p>}
    <WriteError error={error} />
    {open && item.post && <div className="hub-attn-detail"><PostDetail postId={item.post.id} compact /></div>}
  </article>;
}

function GroupCard({ group, today }: { group: TodayGroup; today: string }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const providers = [...new Set(group.posts.map(post => providerName(l, post.channel.provider)))].join(' + ');
  return <article className="hub-group">
    <header>
      <h3>{group.title || group.caption_excerpt || l(hub.common.noCaption)} <span className="muted">→ {providers}</span></h3>
      {group.just_scheduled && <Badge tone="info">{l(hub.today.justScheduled)}</Badge>}
    </header>
    {group.caption_excerpt && group.caption_excerpt !== group.title && <p className="hub-quote">{group.caption_excerpt}</p>}
    <ul className="hub-rows">{group.posts.map(post => <li key={post.post_id}>
      <RouterLink to={`${base}/posts/${encodeURIComponent(post.post_id)}`} className="hub-row">
        <span className="hub-row-time">{localLabel(post.local_time, today, lang)}</span>
        <span className="hub-row-main"><ChannelName provider={post.channel.provider} handle={post.channel.handle} label={post.channel.label} />
          <small className="muted">{post.machine ? post.machine.name : l(hub.common.manual)}</small></span>
        <span className="hub-row-tags"><ModeBadge mode={post.mode} />
          {post.approval === 'awaiting_owner' && post.approval_deadline_local ? <Badge tone="warning">{l(hub.today.deadline)} {localLabel(post.approval_deadline_local, today, lang)}</Badge> : null}
          <PostStatusBadge status={post.status} />{pauseOf(post) && <Badge tone="warning">{l(hub.common.paused)}</Badge>}</span>
      </RouterLink>
    </li>)}</ul>
  </article>;
}

export function MachineMini({ machine, today }: { machine: MachineSummary; today: string }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  return <RouterLink to={`${base}/machines/${encodeURIComponent(machine.machine_id)}`} className="hub-machine-mini">
    <span className="hub-machine-name"><Monitor size={16} aria-hidden="true" />{machine.name}</span>
    <OnlineBadge online={machine.online} paused={machine.paused} />
    <small className="muted">{machine.channels.length} {l(hub.today.channels)}{machine.next_job && <> · {l(hub.today.nextJob)} {localLabel(machine.next_job.local_time, today, lang)}</>}</small>
    {machine.warnings.length > 0 && <Badge tone="warning">{machine.warnings.length} {l(hub.today.warnings)}</Badge>}
  </RouterLink>;
}

export function TodayPage() {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const read = useView<TodayData>('/views/today');
  return <>
    <PageHeader title={l(hub.today.title)} subtitle={l(hub.today.subtitle)} asOf={read.asOf} timeZone={read.value?.timezone} />
    <Loaded read={read}>{today => {
      const posts = new Map([...today.upcoming.flatMap(group => group.posts), ...today.recent_published].map(post => [post.post_id, post]));
      return <div className="hub-today">
        <dl className="hub-counts" aria-label={l(hub.today.counts)}>
          {([['scheduled', hub.today.scheduled], ['published', hub.today.published], ['needs_owner', hub.today.needsOwner], ['missed', hub.today.missed], ['unknown', hub.today.unknown]] as const)
            .map(([key, label]) => <div key={key} className={today.counts[key] && ['needs_owner', 'missed', 'unknown'].includes(key) ? 'alert' : undefined}><dt>{l(label)}</dt><dd>{today.counts[key]}</dd></div>)}
        </dl>
        <Section title={<>{l(hub.today.attention)}{today.attention.length > 0 && <span className="vs-badge">{today.attention.length}</span>}</>} className="hub-attention">
          {today.attention.length ? <div className="hub-attn-list">{today.attention.map(item => <AttentionCard key={item.id} item={item} today={today.date} posts={posts} />)}</div>
            : <Empty>{l(hub.today.nothing)}</Empty>}
        </Section>
        {/* WV-6: every time on this page is in the zone the hub computed Today in (the workspace zone, or ?tz=). */}
        <Section title={l(hub.today.upcoming)}
          action={<span className="hub-head-tools"><ZoneNote zone={today.timezone} /><RouterLink to={`${base}/calendar`}>{l(hub.nav.calendar)}</RouterLink></span>}>
          {today.upcoming.length ? <div className="hub-groups">{today.upcoming.map(group => <GroupCard key={group.content_item_id || group.posts[0].post_id} group={group} today={today.date} />)}</div>
            : <Empty>{l(hub.today.noUpcoming)}</Empty>}
        </Section>
        <div className="vs-columns">
          <Section title={l(hub.today.machines)} action={<RouterLink to={`${base}/machines`}>{l(hub.common.viewAll)}</RouterLink>}>
            {today.machines.length ? <div className="hub-machine-grid">{today.machines.map(machine => <MachineMini key={machine.machine_id} machine={machine} today={today.date} />)}</div>
              : <Empty action={<RouterLink to={`${base}/get-started?step=machines`} className="vs-btn primary-soft">{l(hub.today.pair)}</RouterLink>}>{l(hub.today.noMachines)}</Empty>}
          </Section>
          <Section title={l(hub.today.recent)}>
            {today.recent_published.length ? <ul className="hub-rows">{today.recent_published.map(post => <li key={post.post_id} className="hub-row static">
              <span className="hub-row-time">{localLabel(post.local_time, today.date, lang)}</span>
              <span className="hub-row-main"><RouterLink to={`${base}/posts/${encodeURIComponent(post.post_id)}`}><ChannelName provider={post.channel.provider} handle={post.channel.handle} label={post.channel.label} /></RouterLink>
                <small className="muted">{post.caption_excerpt || l(hub.common.noCaption)}</small></span>
              {post.url && <a className="hub-ext" href={post.url} target="_blank" rel="noreferrer noopener">{l(hub.common.platformPost)}<ExternalLink size={13} aria-hidden="true" /></a>}
            </li>)}</ul> : <Empty>{l(hub.today.noRecent)}</Empty>}
          </Section>
        </div>
      </div>;
    }}</Loaded>
  </>;
}
