import { setTimeout as delay } from 'node:timers/promises';
import { Problem, type Context, type Data, type Input, type WorkerJobRecord } from '@smartsell/contracts';
import type { McpInvocation, McpPrincipal, McpToolDefinition } from '../extensions/mcp.js';
import { checkView } from '../modules/posting/check.js';
import { TARGET } from '../modules/posting/model.js';
import { listAgentPosts, postDetail } from '../modules/posting/posts.js';
import { HUB_TOOL_NAMES, parseToolArgs, toolInputSchema, type HubToolName } from '../modules/posting/schemas.js';
import { channelsList, machinesList, overview, taskDetail } from '../modules/posting/views.js';

/**
 * The 11 hub MCP tools (phase1-design §7.1–§7.3). Writes run through the shared Operation executor (host.execute); reads run
 * the posting read models in short read transactions; channel_check waits outside every transaction (§5.12).
 */

const descriptions: Record<HubToolName, string> = {
  // Real-model check (§10.3): models read needs_owner `channel_setup` reminders (e.g. "還沒試跑") as a threat to tomorrow's
  // post; the last sentence says what stops scheduling and where waiting-for-the-owner shows.
  smartsell_overview: 'Start here. Workspace time zone, machines, channels (with channel_id), upcoming posts and what waits for the owner. '
    + "Only a channel's blockers (can_schedule false) stop scheduling; other channel_setup items in needs_owner are setup reminders. "
    + 'Whether a post waits for the owner shows in its approval and owner_action.',
  machines_list: "List the owner's machines (Workers): online, paused, warnings, the channels on each machine, queue counts and the next job.",
  channels_list: 'List channels (social accounts) with channel_id, machine, login state, mode (auto/assist/owner), approval (direct/needs_approval), limits and the blockers that stop scheduling.',
  channel_check: "Check a channel's login on its machine. Creates or reuses one login check and waits up to wait_seconds. status: done, pending (read it later with task_get) or machine_offline (runs when the machine is back).",
  media_upload: 'Upload a local video or image by its absolute path and get a media_id for post_schedule. Handled by the SmartSell relay on this computer, which streams the file with SHA-256 checks; the hub never receives the file through this call. "uploading" and "processing" can be scheduled.',
  post_schedule: "Schedule one post to one or more channels in ONE call. Times are local wall-clock in `timezone` (default: the workspace time zone). Each channel gets its own post_id. Captions are optional; never invent one. The owner's channel settings decide approval and which machine posts.",
  post_update: 'Change one post: action "reschedule" (when, timezone), "cancel" (reason) or "edit_caption" (caption). Published or cancelled posts are final; a post whose result is unknown must be confirmed by the owner first. A post the owner rejected is submitted again only when you reschedule or edit it.',
  posts_list: 'List posts by local date (default: today to 7 days ahead, workspace time zone), status, channel or machine.',
  post_get: 'Read one post: status, local time, machine, approval and deadline, owner action, media upload state, caption, task timeline and result URL.',
  task_get: 'Read one task (a publish job or a login check) by task_id: status, machine, time window, blocker, result and timeline.',
  publishing_pause: 'Stop publishing for all channels, one channel or one machine. Stop only: the owner resumes in the web app.',
};

const readOnly = new Set<HubToolName>(['smartsell_overview', 'machines_list', 'channels_list', 'posts_list', 'post_get', 'task_get']);
/** The Operation behind each write tool (§7.1). */
export const HUB_TOOL_OPERATIONS: Partial<Record<HubToolName, string>> = {
  channel_check: 'hub_channels_check', post_schedule: 'hub_posts_schedule', post_update: 'hub_posts_update', publishing_pause: 'hub_publishing_pause',
};

function definition(name: HubToolName): McpToolDefinition {
  const operation = HUB_TOOL_OPERATIONS[name];
  return Object.freeze({
    name, module: 'posting', action: name, description: descriptions[name],
    inputSchema: toolInputSchema(name), outputSchema: { type: 'object' },
    annotations: Object.freeze({ readOnlyHint: readOnly.has(name), destructiveHint: false, idempotentHint: readOnly.has(name) || name === 'channel_check', openWorldHint: false }),
    sideEffect: false, needsOutputPolicy: false, result: 'hub', ...(operation && { operation }),
    // Throws Problem(422, INVALID_ARGUMENTS) with issue paths; mcp-streamable returns it as a detailed tool error (§7.3).
    parse: (args: Data) => ({ body: parseToolArgs(name, args) as Data, params: {}, query: {} }),
  } satisfies McpToolDefinition);
}

export const HUB_TOOLS: readonly McpToolDefinition[] = Object.freeze(HUB_TOOL_NAMES.map(definition));
export const HUB_TOOL_SET: ReadonlySet<string> = new Set(HUB_TOOL_NAMES);
export const isHubTool = (tool: Pick<McpToolDefinition, 'result'> | undefined) => tool?.result === 'hub';

export interface HubToolDeps {
  /** Runs a registered Operation through the shared executor (records, audit, activity) as this principal. */
  operation(principal: McpPrincipal, name: string, input: Input): Promise<{ body: { data: unknown } }>;
  /** Runs fn in one short read-only workspace transaction as this principal. */
  read<T>(principal: McpPrincipal, fn: (ctx: Context) => T): Promise<T>;
  /** The hub origin shown in the RELAY_REQUIRED install steps. */
  origin: string;
  pollMs?: number;
}

export function relayRequired(origin: string) {
  const hub = origin.replace(/\/+$/, '');
  return new Problem(422, 'RELAY_REQUIRED',
    'media_upload runs in the SmartSell relay on the computer that has the file; this client reached the hub directly. Ask the owner to connect this client through the relay (details.install), restart the client, then call media_upload again. Do not read, encode or upload the file yourself.', {
      owner_message: 'media_upload 要經由你電腦上的 SmartSell relay 執行（relay 在本機讀檔並分段上傳）。請在筆電的 SmartSell App 按「連接 Codex／Claude Code」，或依 install 的步驟安裝 relay，重新啟動用戶端後再試一次。',
      install: {
        download: `curl -fsSL ${hub}/agent/relay.mjs -o ~/.smartsell/relay.mjs`,
        codex: `codex mcp add smartsell -- node ~/.smartsell/relay.mjs --hub ${hub} --token-file ~/.smartsell/token`,
        claude_code: `claude mcp add --scope user smartsell -- node ~/.smartsell/relay.mjs --hub ${hub} --token-file ~/.smartsell/token`,
        token: 'Create the token in the web app (Agent → 建立連線) and save it to ~/.smartsell/token with mode 0600.',
      },
    });
}

const record = (value: unknown): Data => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Problem(500, 'RESULT_UNAVAILABLE', 'The operation returned no result');
  return value as Data;
};
const data = (outcome: { body: { data: unknown } }) => record(outcome.body.data);

export function createHubTools(deps: HubToolDeps) {
  const pollMs = deps.pollMs ?? 1000;

  async function waitForCheck(principal: McpPrincipal, first: Data, seconds: number, signal?: AbortSignal) {
    let current = first;
    const deadline = Date.now() + seconds * 1000;
    // Each poll is its own short read transaction; nothing is held while waiting (§5.12, §0 rule 8).
    while (current.status === 'pending' && Date.now() < deadline && !signal?.aborted) {
      try { await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())), undefined, signal ? { signal } : undefined); } catch { break; }
      current = await deps.read(principal, ctx => {
        const job = (ctx.list('worker_job') as unknown as WorkerJobRecord[]).find(row => row.id === first.task_id);
        return job ? checkView(ctx, ctx.get('social_account', String(first.channel_id)), job) as Data : current;
      });
    }
    return current;
  }

  return {
    tools: HUB_TOOLS,
    async dispatch(invocation: McpInvocation & { signal?: AbortSignal }): Promise<Data> {
      const { principal, tool } = invocation;
      const args = invocation.input.body;
      const name = tool.name as HubToolName;
      switch (name) {
        case 'smartsell_overview': return deps.read(principal, ctx => overview(ctx));
        case 'machines_list': return deps.read(principal, ctx => machinesList(ctx, args.include_offline !== false));
        case 'channels_list': return deps.read(principal, ctx => channelsList(ctx, { provider: args.provider as string | undefined, machine_id: args.machine_id as string | undefined }));
        case 'posts_list': return deps.read(principal, ctx => listAgentPosts(ctx, args as unknown as Parameters<typeof listAgentPosts>[1]));
        case 'post_get': return deps.read(principal, ctx => {
          const target = ctx.list(TARGET).find(row => row.id === args.post_id);
          if (!target) throw new Problem(404, 'POST_NOT_FOUND', `Unknown post_id ${String(args.post_id)}. Read post_id from post_schedule or posts_list.`);
          return postDetail(ctx, target);
        });
        case 'task_get': return deps.read(principal, ctx => taskDetail(ctx, String(args.task_id)));
        case 'media_upload': throw relayRequired(deps.origin);
        case 'post_schedule': return data(await deps.operation(principal, 'hub_posts_schedule', { body: args, params: {}, query: {} }));
        case 'post_update': {
          const { post_id, ...body } = args;
          return data(await deps.operation(principal, 'hub_posts_update', { body, params: { id: String(post_id) }, query: {} }));
        }
        case 'publishing_pause': return data(await deps.operation(principal, 'hub_publishing_pause', { body: args, params: {}, query: {} }));
        case 'channel_check': {
          const first = data(await deps.operation(principal, 'hub_channels_check', { body: {}, params: { id: String(args.channel_id) }, query: {} }));
          const seconds = typeof args.wait_seconds === 'number' ? args.wait_seconds : 30;
          return seconds > 0 ? waitForCheck(principal, first, seconds, invocation.signal) : first;
        }
      }
      throw new Problem(404, 'TOOL_UNAVAILABLE', `Unknown hub tool ${String(name)}`);
    },
  };
}
export type HubTools = ReturnType<typeof createHubTools>;
