import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { asRecord, request, workspacePath } from '@smartsell/sdk';
import { Busy, formatNumber } from '@smartsell/ui';
import { fill } from '../copy';
import { pauseOf, type PostDetailView } from '../data/hub-types';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, RouterLink, useText } from '../parts';
import { approvalText, blockerText, eventTextEn, hub, missedReasonText } from '../hub-copy';
import { ChannelName, ModeBadge, OnlineBadge, PauseNote, PostActions, PostStatusBadge, isoLocal, localLabel, todayIn, tr } from '../hub-parts';

/** A short-lived signed link for a workspace file (GET /files/:id/download?inline=true), for previews and screenshots. */
function useSignedUrl(path: string | null) {
  const { ws } = useViewContext();
  return useQuery({ queryKey: ['workspace', ws, 'signed-file', path], enabled: !!path, staleTime: 4 * 60_000, retry: false,
    queryFn: async ({ signal }) => String(asRecord((await request<{ url: string }>(`${workspacePath(ws)}${path}`, { signal })).data).url ?? '') });
}

function MediaPreview({ media }: { media: PostDetailView['media'][number] }) {
  const { l, lang } = useText();
  const signed = useSignedUrl(media.file_id && media.status === 'ready' ? `/files/${encodeURIComponent(media.file_id)}/download?inline=true` : null);
  const mb = media.bytes ? `${formatNumber(Math.round(media.bytes / 104857.6) / 10, lang)} MB` : '';
  const seconds = media.duration_ms ? `${Math.round(media.duration_ms / 1000)} s` : '';
  const size = media.width && media.height ? `${media.width}×${media.height}` : '';
  const pct = media.bytes && media.uploaded_bytes !== null ? Math.min(100, Math.round(media.uploaded_bytes / media.bytes * 100)) : null;
  return <figure className="hub-media">
    {signed.data ? media.kind === 'video' ? <video controls preload="metadata" src={signed.data} /> : <img src={signed.data} alt={media.filename} />
      : <div className="hub-media-placeholder">{media.status === 'ready' ? (signed.isError ? media.filename : l(hub.post.previewing)) : media.status === 'uploading' && pct !== null ? fill(l(hub.post.uploading), { pct }) : media.status}</div>}
    <figcaption><strong>{media.filename}</strong><span className="muted">{[mb, seconds, size, media.sha256 ? `${l(hub.post.shaShort)} ${media.sha256.slice(0, 12)}` : ''].filter(Boolean).join(' · ')}</span>
      {media.status === 'uploading' && pct !== null && <progress max={100} value={pct} />}</figcaption>
  </figure>;
}

function Evidence({ item }: { item: { file_id: string; url: string; label: string } }) {
  const signed = useSignedUrl(item.url.startsWith('/files/') ? item.url : null);
  return signed.data ? <a href={signed.data} target="_blank" rel="noreferrer noopener" className="hub-shot"><img src={signed.data} alt={item.label} /></a>
    : <span className="hub-shot muted">{item.label}</span>;
}

export function PostDetailBody({ detail, compact = false }: { detail: PostDetailView; compact?: boolean }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const post = detail.post;
  const today = todayIn(post.timezone);
  const task = detail.task;
  const blocker = post.blocker;
  const pause = pauseOf(post);
  return <div className={`hub-post ${compact ? 'compact' : ''}`}>
    <div className="hub-post-head">
      <PostStatusBadge status={post.status} />
      <span className="hub-when">{localLabel(post.local_time, today, lang)}{post.latest_local_time && post.local_time && <small className="muted"> · {l(hub.post.latest)} {localLabel(post.latest_local_time, today, lang)}</small>}</span>
      <span className="muted hub-small">{post.timezone}</span>
      {post.plan_tag && <span className="hub-tag">#{post.plan_tag}</span>}
      <span className="muted hub-small">{l(post.created_by.type === 'agent' ? hub.post.createdByAgent : hub.post.createdByHuman)}</span>
    </div>
    {blocker && <div className={`hub-callout ${blocker.resumable_by === 'auto' ? 'warn' : 'critical'}`} role="note">
      <strong>{tr(l, blockerText, String(blocker.code))}</strong><p>{blocker.message}</p>
      {blocker.resumable_by === 'auto' && !blocker.message.includes('自動繼續') && <p className="muted">{l(hub.today.autoResume)}</p>}
    </div>}
    {pause && <PauseNote pause={pause} today={today} zone={post.timezone} compact={compact} />}
    {post.status === 'rejected' && <div className="hub-callout warn" role="note"><strong>{tr(l, approvalText, 'rejected')}</strong><p>{l(hub.post.rejected)}</p></div>}
    {post.status === 'missed' && post.missed_reason && <div className="hub-callout critical" role="note"><strong>{l(hub.today.missed)}</strong>
      <p>{tr(l, missedReasonText, post.missed_reason)}</p></div>}
    {post.owner_action && <div className="hub-callout warn" role="note">
      <strong>{fill(l(hub.post.clickWindow), { from: localLabel(post.owner_action.from_local, today, lang), until: post.owner_action.until_local.slice(11), machine: post.owner_action.machine.name })}</strong>
      {post.owner_action.machine.remote_url && <p><a href={post.owner_action.machine.remote_url}>{l(hub.machines.remote)}</a></p>}
    </div>}
    <dl className="hub-facts">
      <div><dt>{l(hub.post.route)}</dt><dd>
        <RouterLink to={`${base}/channels/${encodeURIComponent(post.channel.id)}`}><ChannelName provider={post.channel.provider} handle={post.channel.handle} label={post.channel.label} /></RouterLink>
        {' · '}{post.machine ? <><RouterLink to={`${base}/machines/${encodeURIComponent(post.machine.id)}`}>{post.machine.name}</RouterLink> <OnlineBadge online={post.machine.online} /></> : l(hub.common.manual)}
        {' · '}<ModeBadge mode={post.mode} />
      </dd></div>
      <div><dt>{l(hub.post.approval)}</dt><dd>{tr(l, approvalText, detail.approval.status)}
        {detail.approval.status === 'awaiting_owner' && post.approval_deadline_local && <> · {fill(l(hub.post.approveBy), { at: localLabel(post.approval_deadline_local, today, lang) })}</>}
        {/* WV-10: decided_at is an instant; shown in the post's zone like every other time on this page. */}
        {['approved', 'rejected'].includes(detail.approval.status) && detail.approval.decided_at && <small className="muted"> · {localLabel(isoLocal(detail.approval.decided_at, post.timezone), today, lang)}</small>}
      </dd></div>
      {!compact && <div><dt>{l(hub.nav.calendar)}</dt><dd><RouterLink to={detail.links.calendar.replace(/^https?:\/\/[^/]+/, '')}>{l(hub.post.calendar)}</RouterLink></dd></div>}
    </dl>
    <section className="hub-block" aria-label={l(hub.post.content)}><h3>{l(hub.post.content)}</h3>
      {detail.content.caption ? <p className="hub-caption">{detail.content.caption}</p> : <p className="muted">{l(hub.common.noCaption)}</p>}
      {detail.media.length ? <div className="hub-media-list">{detail.media.map(item => <MediaPreview key={item.media_id || item.filename} media={item} />)}</div>
        : <p className="muted">{l(hub.post.noMedia)}</p>}
    </section>
    {detail.result && <section className="hub-block" aria-label={l(hub.post.result)}><h3>{l(hub.post.result)}</h3>
      <dl className="hub-facts">
        {detail.result.url && <div><dt>{l(hub.common.platformPost)}</dt><dd><a href={detail.result.url} target="_blank" rel="noreferrer noopener" className="hub-ext">{detail.result.url}<ExternalLink size={13} aria-hidden="true" /></a></dd></div>}
        {detail.result.external_post_id && <div><dt>{l(hub.post.externalId)}</dt><dd><code>{detail.result.external_post_id}</code></dd></div>}
        {detail.result.published_at && <div><dt>{l(hub.post.publishedAt)}</dt><dd>{localLabel(new Intl.DateTimeFormat('sv-SE', { timeZone: post.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(detail.result.published_at)), today, lang)}
          {detail.result.late_by_sec > 0 && <small className="muted"> · {fill(l(hub.post.lateBy), { n: detail.result.late_by_sec })}</small>}
          <small className="muted"> · {l(hub.post[`verification_${detail.result.verification}`])}</small></dd></div>}
      </dl>
      {detail.result.evidence.length > 0 && <div className="hub-shots" aria-label={l(hub.post.evidence)}>{detail.result.evidence.map(item => <Evidence key={item.file_id} item={item} />)}</div>}
    </section>}
    {/* WV-8: the actions' own state (panel, 改到… time, notices) belongs to one post; another post starts fresh. */}
    <section className="hub-block" aria-label={l(hub.post.actions)}><h3>{l(hub.post.actions)}</h3><PostActions key={post.post_id} detail={detail} compact={compact} /></section>
    {task && <section className="hub-block" aria-label={l(hub.post.timeline)}><h3>{l(hub.post.timeline)}</h3>
      {!compact && <p className="muted hub-small">{l(hub.post.attempts)} {task.attempts}{task.go_source && <> · {l(hub.post.goSource)} {l(task.go_source === 'offline' ? hub.post.goOffline : hub.post.goHub)}</>}</p>}
      {task.timeline.length ? <ol className="hub-timeline">{(compact ? task.timeline.slice(-6) : task.timeline).map((row, index) => <li key={`${row.at}-${index}`} className={`actor-${row.actor}`}>
        <time dateTime={row.at}>{localLabel(row.at_local, today, lang)}</time><span>{lang === 'en' ? eventTextEn[row.event] ?? row.event : row.text}</span>
      </li>)}</ol> : <p className="muted">{l(hub.post.noTimeline)}</p>}
    </section>}
  </div>;
}

/**
 * <PostDetail postId compact? />: the post page and the calendar drawer render the same view (§9.5). WV-8: while another post
 * loads, the previous post (kept as placeholder data) is not shown under the new id, so no button acts on the wrong post.
 */
export function PostDetail({ postId, compact = false }: { postId: string; compact?: boolean }) {
  const { l } = useText();
  const read = useView<PostDetailView>(`/views/posts/${encodeURIComponent(postId)}`);
  return <Loaded read={read}>{detail => detail.post.post_id === postId ? <PostDetailBody detail={detail} compact={compact} />
    : <Busy label={l(hub.post.previewing)} />}</Loaded>;
}
