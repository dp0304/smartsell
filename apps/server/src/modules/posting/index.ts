import { WRITE, type Operation } from '@smartsell/contracts';
import { checkChannel } from './check.js';
import { pausePublishing } from './pause.js';
import { schedulePosts } from './schedule.js';
import { operationBodySchemas } from './schemas.js';
import { unblockSubscriber } from './unblock.js';
import { updatePost } from './update.js';
import { z } from 'zod';

/**
 * Phase 1 posting module (phase1-design §7, S4). Names are the full hub_* names (§4.6): never prefixed, so HUMAN_ONLY and
 * the Agent catalog see exactly these. All four are Agent-callable writes; nothing here approves, resumes or confirms.
 */

const body = (name: keyof typeof operationBodySchemas) => {
  const { $schema: _schema, ...schema } = z.toJSONSchema(operationBodySchemas[name], { target: 'draft-7', reused: 'inline', io: 'input' }) as Record<string, unknown>;
  return schema;
};

export const operations: Operation[] = [
  {
    method: 'POST', path: '/hub/posts/schedule', name: 'hub_posts_schedule', roles: WRITE,
    summary: 'Schedule one post to one or more channels in one call (captions optional, never invented)',
    contract: { body: body('hub_posts_schedule'), bodyRequired: true },
    run: (ctx, input) => schedulePosts(ctx, input.body),
  },
  {
    method: 'POST', path: '/hub/posts/:id/update', name: 'hub_posts_update', roles: WRITE,
    summary: 'Reschedule, cancel or edit the caption of a scheduled post',
    contract: { body: body('hub_posts_update'), bodyRequired: true },
    run: (ctx, input) => updatePost(ctx, input.params.id!, input.body),
  },
  {
    method: 'POST', path: '/hub/channels/:id/check', name: 'hub_channels_check', roles: WRITE,
    summary: 'Queue (or reuse) a login check for a channel on its machine; returns at once',
    contract: { body: body('hub_channels_check') },
    run: (ctx, input) => checkChannel(ctx, input.params.id!, input.body),
  },
  {
    method: 'POST', path: '/hub/pause', name: 'hub_publishing_pause', roles: WRITE,
    summary: 'Pause publishing for everything, one channel or one machine (only a person resumes)',
    contract: { body: body('hub_publishing_pause'), bodyRequired: true },
    run: (ctx, input) => pausePublishing(ctx, input.body),
  },
];

export const subscribers = [unblockSubscriber];

export { configurePosting, webUrl as postingWebUrl } from './model.js';
export { agentPost, listAgentPosts, postDetail } from './posts.js';
export { overview, machinesList, channelsList, taskDetail } from './views.js';
export { checkView, checkStatus } from './check.js';
export { applyUnblock } from './unblock.js';
