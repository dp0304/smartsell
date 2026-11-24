// Shared steps for the E2E cases: what an Agent does over MCP (upload, schedule, update) and what the owner reads in
// the views. Assertions stay in the *.test.ts files.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixturePost } from '../fixtures/platforms/server.ts';
import type { JobDetailView, PostDetailView, PostStatus, WorkerJobStatus } from '../../packages/contracts/src/index.ts';
import { localWhen, until, type Data, type MachineName, type Provider, type Stack } from './stack.ts';

export interface ScheduledPost {
  post_id: string; channel_id: string; provider: string; handle: string; task_id: string | null; status: string;
  route: { kind: string; machine_id: string | null; machine_name: string | null; mode: string };
  approval: string; owner_action: Data | null; scheduled_at: string; local_time: string; web_url: string; blockers: Data[]; warnings: Data[];
}

const uploads = new WeakMap<Stack, Promise<string>>();
/** media_upload of the stack's 30 MB clip through the relay (once per stack; concurrent cases share the same call). */
export function uploadClip(stack: Stack): Promise<string> {
  let pending = uploads.get(stack);
  if (!pending) {
    pending = stack.mcp<Data>('media_upload', { path: stack.video!.path }).then(result => {
      assert.ok(result.ok, `media_upload: ${JSON.stringify(result.error)}`);
      return String(result.data.media_id);
    });
    uploads.set(stack, pending);
  }
  return pending;
}

/** post_schedule over MCP for one or more channels at `at` (local wall-clock in the workspace zone, minute precision). */
export async function schedule(stack: Stack, input: { providers: Provider[]; at: number; caption?: string; mediaId?: string }) {
  const mediaId = input.mediaId ?? await uploadClip(stack);
  const result = await stack.mcp<{ posts: ScheduledPost[]; content_id?: string }>('post_schedule', {
    media_ids: [mediaId], channel_ids: input.providers.map(provider => stack.channels[provider].id), when: localWhen(input.at),
    ...(input.caption !== undefined && { captions: { default: { text: input.caption } } }),
  });
  assert.ok(result.ok, `post_schedule: ${JSON.stringify(result.error)}`);
  const byProvider = {} as Record<Provider, ScheduledPost>;
  for (const provider of input.providers) {
    const post = result.data.posts.find(item => item.channel_id === stack.channels[provider].id);
    assert.ok(post, `post for ${provider}`);
    byProvider[provider] = post;
  }
  return { result, posts: byProvider };
}

export const postView = (stack: Stack, postId: string) => stack.view<PostDetailView>(`/views/posts/${postId}`);
export const jobView = (stack: Stack, jobId: string) => stack.view<JobDetailView>(`/views/jobs/${jobId}`);

/** The post's current job (task) id, waiting until one exists. */
export async function jobIdOf(stack: Stack, postId: string, timeoutMs = 30_000) {
  return until(async () => (await postView(stack, postId)).task?.task_id, timeoutMs, `job of post ${postId}`);
}

export async function waitPost(stack: Stack, postId: string, match: (view: PostDetailView) => boolean, timeoutMs: number, label: string) {
  return until(async () => { const view = await postView(stack, postId); return match(view) && view; }, timeoutMs, label, 1000);
}
export const waitPostStatus = (stack: Stack, postId: string, statuses: PostStatus[], timeoutMs: number) =>
  waitPost(stack, postId, view => statuses.includes(view.post.status), timeoutMs, `post ${postId} in ${statuses.join('|')}`);
export async function waitJobStatus(stack: Stack, jobId: string, statuses: WorkerJobStatus[], timeoutMs: number) {
  return until(async () => { const view = await jobView(stack, jobId); return statuses.includes(view.status) && view; }, timeoutMs, `job ${jobId} in ${statuses.join('|')}`, 1000);
}

export function fixturePosts(stack: Stack, platform: Provider, captionPrefix: string): FixturePost[] {
  return stack.fixtures.posts().filter(post => post.platform === platform && post.text.startsWith(captionPrefix));
}

/** The worker_job_event names of a job, oldest first, from its view timeline. */
export async function timelineEvents(stack: Stack, jobId: string) {
  return (await jobView(stack, jobId)).timeline.map(row => row.event);
}

/** The runner's own copy of a job (its local job store, §8.4): what it last synced from a heartbeat. */
export interface LocalJobFile {
  state: string; revoked: boolean; offline_go_disabled: boolean; fence: number;
  sync: { hold: boolean; hold_reason: string | null; mode: 'auto' | 'assist'; resume_token: number; machine_paused: boolean; pause_all: boolean; channel_paused: boolean; synced_at: string };
  blocker?: { code: string; phase: string };
}
export function localJob(stack: Stack, machine: MachineName, jobId: string): LocalJobFile | undefined {
  const path = join(stack.machines[machine].dataDir, 'jobs', `${jobId}.json`);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')) as LocalJobFile; } catch { return undefined; }
}
