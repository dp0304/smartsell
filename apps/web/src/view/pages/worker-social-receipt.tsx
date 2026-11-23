import { useState } from 'react';
import { ApiError } from '@smartsell/sdk';
import { Busy, formatDateTime, type Tuple } from '@smartsell/ui';
import { useView } from '../data/use-view';
import { useText } from '../parts';

const labels = {
  disclosure: ['Worker 任務與簽名回執', 'Worker task & signed receipt'],
  state: ['任務狀態', 'Task status'], device: ['Worker 裝置 ID', 'Worker device ID'],
  reported: ['回報時間', 'Reported at'], noReceipt: ['尚無 Worker 回執。', 'No Worker receipt yet.'],
  account: ['帳號狀態', 'Account status'], posts: ['近期貼文', 'Recent posts'],
  visible: ['本人可見貼文', 'Visible posts'], videoCount: ['有影片證據的貼文', 'Posts with video evidence'],
  video: ['有影片證據', 'Video observed'], post: ['X 貼文', 'X post'],
  loading: ['正在讀取 Worker 任務…', 'Loading Worker task…'], refresh: ['重新讀取', 'Refresh'],
  denied: ['您無權查看此任務的回執。', 'You do not have permission to view this task’s receipt.'],
  missing: ['找不到任務，或您無權查看其回執。', 'Task not found or you do not have permission to view its receipt.'],
  failed: ['無法讀取 Worker 任務。', 'Could not read the Worker task.'],
  unknown: ['狀態未知', 'Unknown status'],
} satisfies Record<string, Tuple>;

type WorkerSocialPost = { id: string; url: string; text: string; has_video: boolean };
type WorkerSocialChannel = { platform: string; status: string; identity?: string; posts?: WorkerSocialPost[] };
type WorkerSocialTask = {
  id: string; device_id: string; status: string; mode: string; platform?: string;
  result?: { channels: WorkerSocialChannel[] }; reported_at?: string;
};

const taskStates: Record<string, Tuple> = {
  queued: ['排隊中', 'Queued'], claimed: ['Worker 已領取', 'Claimed by Worker'],
  expired: ['已逾期', 'Expired'], completed: ['已完成', 'Completed'], blocked: ['受阻', 'Blocked'],
};
const channelStates: Record<string, Tuple> = {
  verified: ['已驗證本人帳號', 'Own account verified'],
  login_required: ['請在這台 Worker 電腦的 Chrome 登入', 'Sign in to this platform in Chrome on this Worker computer'],
  unverified: ['未觀測', 'Not observed'], identity_mismatch: ['身分不符', 'Account identity mismatch'],
  unsupported: ['不支援', 'Unsupported'],
};
const platforms: Record<string, Tuple> = {
  x: ['X', 'X'], facebook: ['Facebook', 'Facebook'], instagram: ['Instagram', 'Instagram'],
  youtube: ['YouTube', 'YouTube'], reddit: ['Reddit', 'Reddit'], douyin: ['抖音', 'Douyin'],
  xhs: ['小紅書', 'Xiaohongshu'], tiktok: ['TikTok', 'TikTok'],
};

function xPostLink(post: WorkerSocialPost, identity: string) {
  const match = /^https:\/\/(?:x\.com|twitter\.com)\/([a-z0-9_]{1,15})\/status\/([1-9][0-9]{0,19})$/.exec(post.url);
  if (match && match[0] === post.url && match[1] === identity && match[2] === post.id) {
    return `https://x.com/${match[1]}/status/${match[2]}`;
  }
}

function XPosts({ posts, identity }: { posts: WorkerSocialPost[]; identity: string }) {
  const { l, lang } = useText();
  return <>
    <p>{l(labels.visible)}{lang === 'en' ? ': ' : '：'}{posts.length} · {l(labels.videoCount)}{lang === 'en' ? ': ' : '：'}{posts.filter(post => post.has_video === true).length}</p>
    {!!posts.length && <ul>{posts.map(post => {
      const link = xPostLink(post, identity);
      return <li key={post.id}>
        {link ? <a href={link} target="_blank" rel="noopener noreferrer">{l(labels.post)} {post.id}</a> : <span>{l(labels.post)} {post.id}</span>}
        {post.has_video === true && <> · {l(labels.video)}</>}
        {post.text && <p>{post.text}</p>}
      </li>;
    })}</ul>}
  </>;
}

export function WorkerSocialReceipt({ taskId, deviceId }: { taskId: string; deviceId?: string }) {
  const { l } = useText();
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{l(labels.disclosure)}</summary>
    {open && <ReceiptRead taskId={taskId} deviceId={deviceId} />}
  </details>;
}

function ReceiptRead({ taskId, deviceId }: { taskId: string; deviceId?: string }) {
  const { l, lang } = useText();
  const read = useView<WorkerSocialTask>(`/worker-social-status/${encodeURIComponent(taskId)}`);
  const task = read.value;
  const refresh = <button className="vs-btn" type="button" disabled={read.isFetching} onClick={() => void read.refetch()}>{l(labels.refresh)}</button>;
  if (read.isPending) return <Busy label={l(labels.loading)} />;
  if (read.isError || task?.id !== taskId || !task.device_id || (deviceId && task.device_id !== deviceId)) {
    const status = read.error instanceof ApiError ? read.error.status : undefined;
    const denied = status === 401 || status === 403;
    const missing = status === 404;
    return <div className="vs-notice" role="status">{l(denied ? labels.denied : missing ? labels.missing : labels.failed)}
      {!denied && !missing && <> {refresh}</>}
    </div>;
  }
  const channels = task.result?.channels;
  const reportedAt = task.reported_at;
  const terminal = task.status === 'completed' || task.status === 'blocked';
  const hasReceipt = terminal && reportedAt && Number.isFinite(Date.parse(reportedAt)) && Array.isArray(channels) && channels.length > 0;
  const state = terminal && !hasReceipt ? labels.unknown : taskStates[task.status] ?? labels.unknown;
  return <div className="vs-notice" aria-busy={read.isFetching || undefined}>
    <dl>
      <div><dt>{l(labels.state)}</dt><dd>{l(state)}</dd></div>
      <div><dt>{l(labels.device)}</dt><dd><code>{task.device_id}</code></dd></div>
      <div><dt>{l(task.mode === 'recent_posts' ? labels.posts : labels.account)}</dt><dd>{task.platform ? l(platforms[task.platform]) : '—'}</dd></div>
      {hasReceipt && <div><dt>{l(labels.reported)}</dt><dd><time dateTime={reportedAt}>{formatDateTime(reportedAt, lang)}</time></dd></div>}
    </dl>
    {hasReceipt ? <ul>{channels.map(channel => <li key={channel.platform}>
      <strong>{l(platforms[channel.platform])}</strong> · <span>{l(channelStates[channel.status] ?? labels.unknown)}</span>
      {channel.status === 'verified' && channel.identity && <> · <code>{channel.identity}</code></>}
      {task.mode === 'recent_posts' && channel.platform === 'x' && channel.status === 'verified' && channel.identity && Array.isArray(channel.posts) &&
        <XPosts posts={channel.posts} identity={channel.identity} />}
    </li>)}</ul> : <><p>{l(labels.noReceipt)}</p>{task.status !== 'expired' && refresh}</>}
  </div>;
}
