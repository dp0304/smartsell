import { useParams } from 'react-router-dom';
import { Busy } from '@smartsell/ui';
import type { PostDetailView } from '../data/hub-types';
import { useView } from '../data/use-view';
import { Loaded, PageHeader, useText } from '../parts';
import { hub } from '../hub-copy';
import { PostDetailBody } from './post-detail';

/**
 * /app/:ws/posts/:id — one post with its timeline, result and owner actions (§9.5). WV-8: the route mounts a new page per id
 * (routes.tsx keys it), and a previous post kept as placeholder data is never shown under another id.
 */
export function PostPage() {
  const { id = '' } = useParams();
  const { l } = useText();
  const read = useView<PostDetailView>(`/views/posts/${encodeURIComponent(id)}`);
  const value = read.value?.post.post_id === id ? read.value : undefined;
  const title = value ? `${value.post.channel.label}${value.post.caption_excerpt ? ` · ${value.post.caption_excerpt}` : ''}` : l(hub.post.title);
  return <>
    <PageHeader title={title} subtitle={l(hub.post.title)} asOf={read.asOf} timeZone={value?.post.timezone} />
    <Loaded read={read}>{detail => detail.post.post_id === id ? <section className="vs-card"><PostDetailBody detail={detail} /></section> : <Busy label={l(hub.post.previewing)} />}</Loaded>
  </>;
}
