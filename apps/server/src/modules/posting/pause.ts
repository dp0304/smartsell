import { Problem, type Context, type Operation, type Row } from '@smartsell/contracts';
import { locate } from '../../../../../packages/domain/src/publishing/index.js';
import { machineOperations } from '../account/machine-ops.js';
import { operations as planningOperations } from '../planning/index.js';
import { TARGET, channelMachine, isHubProvider, webUrl } from './model.js';
import { parseOperationBody } from './schemas.js';

/**
 * hub_publishing_pause (phase1-design §7.2.11): stop only. `all` and `channel` reuse the existing pause_switch
 * (publishing_pause); `machine` reuses hub_machines_pause. Resuming stays a person's decision in the web app.
 */

const FINAL = ['cancelled', 'superseded', 'closed', 'cancel_requested'];
const RESUME = 'Only the owner can resume in the web app.';

function operation(list: readonly Operation[], name: string) {
  const found = list.find(op => op.name === name);
  if (!found) throw new Problem(503, 'UNAVAILABLE', `${name} is not available on this server`);
  return found;
}

const upcoming = (ctx: Context, match: (target: Row) => boolean) =>
  ctx.list(TARGET).filter(target => !FINAL.includes(String(target.plan_status)) && match(target)).length;

export async function pausePublishing(ctx: Context, body: unknown) {
  const args = parseOperationBody('hub_publishing_pause', body);
  if (args.scope === 'machine') {
    const device = locate(ctx, 'connector_device', args.id);
    if (!device || device.status !== 'active') {
      throw new Problem(404, 'MACHINE_NOT_FOUND', `Unknown machine_id ${args.id}. Call machines_list.`, { hint: 'call machines_list' });
    }
    await operation(machineOperations, 'hub_machines_pause').run(ctx, { params: { id: device.id }, query: {}, body: { reason: args.reason } });
    return { pause_id: device.id, scope: 'machine' as const, affected_posts: upcoming(ctx, target => channelMachine(ctx, String(target.social_account_id)).device?.id === device.id),
      resume: RESUME, web_url: webUrl(ctx, 'machine', device.id) };
  }
  if (args.scope === 'channel') {
    const account = locate(ctx, 'social_account', args.id);
    if (!account || !isHubProvider(account.provider)) {
      throw new Problem(422, 'CHANNEL_NOT_FOUND', `Unknown channel_id ${args.id}. Call channels_list.`, { channel_ids: [args.id], hint: 'call channels_list' });
    }
    const pause = await operation(planningOperations, 'publishing_pause').run(ctx, { params: {}, query: {}, body: { scope_type: 'social_account', scope_id: account.id, reason: args.reason } }) as Row;
    return { pause_id: pause.id, scope: 'channel' as const, affected_posts: upcoming(ctx, target => target.social_account_id === account.id),
      resume: RESUME, web_url: webUrl(ctx, 'channel', account.id) };
  }
  const pause = await operation(planningOperations, 'publishing_pause').run(ctx, { params: {}, query: {}, body: { scope_type: 'workspace', reason: args.reason } }) as Row;
  return { pause_id: pause.id, scope: 'all' as const, affected_posts: upcoming(ctx, () => true), resume: RESUME, web_url: webUrl(ctx, 'today') };
}
