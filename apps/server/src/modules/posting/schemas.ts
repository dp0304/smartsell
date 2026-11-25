import { Problem, type Data } from '@smartsell/contracts';
import { z } from 'zod';

/**
 * phase1-design §7.2: the strict schemas of the 11 hub MCP tools. MCP, REST and tests share them. Every object is strict
 * (additionalProperties:false), every shared fragment is a fresh instance (no $ref/$defs), and patterns use ASCII classes only;
 * Unicode rules (hashtags) are checked on the server after parsing.
 */

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MCP_PROVIDERS = ['x', 'tiktok', 'youtube', 'instagram', 'facebook'] as const;
export type McpProvider = typeof MCP_PROVIDERS[number];
/** Appendix A PostStatus, with E37's `rejected` (the owner rejected the post; only post_update or an explicit resubmit sends it again). */
export const POST_STATUSES = ['draft', 'blocked', 'awaiting_approval', 'rejected', 'scheduled', 'ready', 'publishing', 'confirming', 'published',
  'needs_owner', 'missed', 'failed', 'unknown', 'cancelling', 'cancelled'] as const;
export const DST_CHOICES = ['earlier_occurrence', 'later_occurrence', 'shift_forward'] as const;
/** Server-side hashtag rule (§7.2): letters, digits and underscore in any script. */
export const TAG_PATTERN = /^[\p{L}\p{N}_]{1,50}$/u;

const uuid = (description?: string) => {
  const schema = z.string().regex(UUID_PATTERN, { error: 'must be a lowercase UUID read from a SmartSell tool result; never guess IDs' });
  return description ? schema.describe(description) : schema;
};
const when = () => z.string().regex(/^(now|\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/, { error: "must be 'YYYY-MM-DD HH:mm' or 'now'" })
  .describe("Local wall-clock time 'YYYY-MM-DD HH:mm' in `timezone`, or 'now'.");
const timezone = () => z.string().regex(/^(UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2})$/, { error: 'must be an IANA time zone such as Asia/Shanghai' })
  .describe('IANA zone, e.g. Asia/Shanghai. Default: the workspace time zone.');
const dstChoice = () => z.enum(DST_CHOICES);
/** The caption fragment; only the first copy in a schema carries the field descriptions (keeps each schema under 4 KB). */
const caption = (described = false) => z.object({
  text: z.string().min(1).max(5000),
  title: described ? z.string().min(1).max(100).describe('Used by YouTube only; ignored with a warning elsewhere.').optional() : z.string().min(1).max(100).optional(),
  tags: described
    ? z.array(z.string().regex(/^[^\s#]{1,50}$/, { error: "must be a tag without '#' or spaces" })).max(30).describe("Without '#'. Letters, digits and _. Appended as hashtags.").optional()
    : z.array(z.string().regex(/^[^\s#]{1,50}$/, { error: "must be a tag without '#' or spaces" })).max(30).optional(),
}).strict();
const provider = () => z.enum(MCP_PROVIDERS);
const postStatus = () => z.enum(POST_STATUSES);
const date = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "must be 'YYYY-MM-DD'" });

export const toolSchemas = {
  smartsell_overview: z.object({}).strict(),
  machines_list: z.object({ include_offline: z.boolean().default(true) }).strict(),
  channels_list: z.object({ provider: provider().optional(), machine_id: uuid().optional() }).strict(),
  channel_check: z.object({ channel_id: uuid(), wait_seconds: z.number().int().min(0).max(40).default(30) }).strict(),
  // Two forms (E47): {path} when the SmartSell relay runs this client (the relay uploads), or {filename, bytes, sha256} for a
  // client that reaches the hub directly: the result's upload.command is one curl PUT that the agent runs on its computer.
  media_upload: z.object({
    path: z.string().min(2).max(4096).describe('Relay form: absolute path (or ~/…) of the file on THIS computer. The relay reads and uploads it; never read or base64 the file yourself.').optional(),
    filename: z.string().min(1).max(255).describe('Direct form: the file name, e.g. video.mp4.').optional(),
    bytes: z.number().int().min(1).describe('Direct form: file size in bytes.').optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, { error: 'must be 64 lowercase hex characters' }).describe('Direct form: SHA-256 of the file (shasum -a 256, or certutil -hashfile <file> SHA256).').optional(),
    mime: z.enum(['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']).describe('Direct form: optional; from the extension by default.').optional(),
    title: z.string().min(1).max(200).optional(),
    wait_seconds: z.number().int().min(0).max(50).default(45),
  }).strict(),
  post_schedule: z.object({
    media_ids: z.array(uuid()).min(1).max(10),
    channel_ids: z.array(uuid()).min(1).max(10).meta({ uniqueItems: true }),
    when: when(),
    timezone: timezone().optional(),
    dst_choice: dstChoice().optional(),
    captions: z.object({ default: caption(true), x: caption(), tiktok: caption(), youtube: caption(), instagram: caption(), facebook: caption() })
      .partial().strict().meta({ minProperties: 1 }).describe('Only text the owner gave. Without captions, no_caption must be true.').optional(),
    no_caption: z.literal(true).describe('Post without text. Only after the owner said so; not with captions.').optional(),
    plan_tag: z.string().min(1).max(60).optional(),
    request_id: z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/, { error: 'must be 8-100 characters of A-Z a-z 0-9 . _ : -' })
      .describe('Optional. Reuse to retry the same request safely.').optional(),
  }).strict(),
  post_update: z.object({
    post_id: uuid(),
    action: z.enum(['reschedule', 'cancel', 'edit_caption']),
    when: when().optional(),
    timezone: timezone().optional(),
    dst_choice: dstChoice().optional(),
    caption: caption(true).optional(),
    reason: z.string().min(1).max(500).optional(),
  }).strict(),
  posts_list: z.object({
    from: date().optional(), to: date().optional(),
    status: z.array(postStatus()).max(POST_STATUSES.length).optional(),
    channel_id: uuid().optional(), machine_id: uuid().optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }).strict(),
  post_get: z.object({ post_id: uuid() }).strict(),
  task_get: z.object({ task_id: uuid() }).strict(),
  publishing_pause: z.object({
    scope: z.enum(['all', 'channel', 'machine']),
    id: uuid("channel_id or machine_id; omit when scope is 'all'").optional(),
    reason: z.string().min(1).max(500),
  }).strict(),
};
export type HubToolName = keyof typeof toolSchemas;
export const HUB_TOOL_NAMES = Object.keys(toolSchemas) as HubToolName[];
export type ToolArgs<N extends HubToolName> = z.output<typeof toolSchemas[N]>;

/** The REST bodies: the path parameter moves out of the body. */
export const operationBodySchemas = {
  hub_posts_schedule: toolSchemas.post_schedule,
  hub_posts_update: toolSchemas.post_update.omit({ post_id: true }),
  // E21: 「重新登入」 from the web. The MCP channel_check tool has no such field; an Agent credential that sends it gets 403 HUMAN_REQUIRED.
  hub_channels_check: z.object({
    open_login_window: z.boolean()
      .describe("Person only. true brings this channel's sign-in window to the front on its machine so the owner signs in there.").optional(),
  }).strict(),
  hub_publishing_pause: toolSchemas.publishing_pause,
};

/** Calls copied from §7.2 (every ID is a real lowercase UUID; models copy examples). Tests parse each one. */
export const TOOL_EXAMPLES: Record<HubToolName, Data> = {
  smartsell_overview: {},
  machines_list: { include_offline: false },
  channels_list: { provider: 'tiktok' },
  channel_check: { channel_id: '7c2f3a4b-5d6e-4f70-9a8b-0c1d2e3f4a5b', wait_seconds: 30 },
  media_upload: { path: '/Users/me/Movies/video.mp4' },
  post_schedule: {
    media_ids: ['0b8e6c2a-1f7d-4c39-9a51-6f0c2d7e8a11'],
    channel_ids: ['5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e', '7c2f3a4b-5d6e-4f70-9a8b-0c1d2e3f4a5b'],
    when: '2026-11-25 09:00', timezone: 'Asia/Shanghai',
    captions: { default: { text: 'New lure test 🎣', tags: ['fishing', 'lure'] } },
    plan_tag: 'lure-launch',
  },
  post_update: { post_id: 'a1d4f6b8-3c2e-4a59-8b7d-6e5f4c3b2a10', action: 'reschedule', when: '2026-11-25 10:30', timezone: 'Asia/Shanghai' },
  posts_list: { from: '2026-11-25', to: '2026-11-25', status: ['published', 'needs_owner'] },
  post_get: { post_id: 'a1d4f6b8-3c2e-4a59-8b7d-6e5f4c3b2a10' },
  task_get: { task_id: '3f6c1d2e-8a4b-4c7d-9e1f-2a3b4c5d6e7f' },
  publishing_pause: { scope: 'machine', id: '2c9a7e14-5b3d-4f6a-8e21-7d0c4b9a3f55', reason: 'Mac-B is being repaired' },
};

/** §7.2: draft-07, every fragment inlined, without the $schema header. */
export function toolInputSchema(name: HubToolName): Data {
  const { $schema: _schema, ...schema } = z.toJSONSchema(toolSchemas[name], { target: 'draft-7', reused: 'inline', io: 'input' }) as Data;
  return schema;
}

// ---------- Errors (§7.3) ----------

export interface ArgumentIssue { path: string; code: string; message: string; allowed?: string[] }

type AnyZod = z.ZodType & { _zod: { def: Record<string, unknown> } };
function unwrap(schema: AnyZod): AnyZod {
  let current = schema;
  for (let depth = 0; depth < 10; depth++) {
    const def = current._zod.def;
    if (['optional', 'default', 'nullable', 'readonly', 'prefault', 'nonoptional'].includes(String(def.type))) current = def.innerType as AnyZod;
    else if (def.type === 'pipe') current = def.in as AnyZod;
    else break;
  }
  return current;
}
/** The field names an object accepts at `path` (for the "Allowed:" list of an unknown field). */
function allowedAt(schema: z.ZodType, path: readonly PropertyKey[]): string[] | undefined {
  let current = unwrap(schema as AnyZod);
  for (const key of path) {
    const def = current._zod.def;
    if (def.type === 'object' && typeof key === 'string') current = unwrap((def.shape as Record<string, AnyZod>)[key]!);
    else if (def.type === 'array') current = unwrap(def.element as AnyZod);
    else return undefined;
    if (!current) return undefined;
  }
  return current._zod.def.type === 'object' ? Object.keys(current._zod.def.shape as Record<string, unknown>) : undefined;
}

export function issuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, key) => typeof key === 'number' ? `${text}[${key}]` : text ? `${text}.${String(key)}` : String(key), '');
}

export function invalidArguments(issues: ArgumentIssue[]): Problem {
  const [first] = issues;
  const more = issues.length > 1 ? ` (${issues.length - 1} more issue${issues.length > 2 ? 's' : ''})` : '';
  return new Problem(422, 'INVALID_ARGUMENTS', `${first ? first.message : 'Invalid arguments'}${more}`, { issues });
}

function zodIssues(schema: z.ZodType, error: z.ZodError): ArgumentIssue[] {
  return error.issues.flatMap((issue): ArgumentIssue[] => {
    if (issue.code === 'unrecognized_keys') {
      const allowed = allowedAt(schema, issue.path) ?? [];
      const parent = issuePath(issue.path);
      return issue.keys.map(key => ({
        path: issuePath([...issue.path, key]), code: 'unrecognized_keys', allowed,
        message: `${parent || 'arguments'} has an unknown field '${key}'. Allowed: ${allowed.join(', ') || '(none)'}.`,
      }));
    }
    const path = issuePath(issue.path);
    const text = issue.message.replace(/^Invalid input: /, '');
    return [{ path, code: issue.code, message: `${path || 'arguments'}: ${text.charAt(0).toLowerCase()}${text.slice(1)}` }];
  });
}

/** Strictly parses a tool's arguments, then applies the cross-field rules the JSON Schema cannot express. */
export function parseToolArgs<N extends HubToolName>(name: N, args: unknown): ToolArgs<N> {
  return parseWith(toolSchemas[name], args, name) as ToolArgs<N>;
}

export function parseOperationBody<N extends keyof typeof operationBodySchemas>(name: N, body: unknown): z.output<typeof operationBodySchemas[N]> {
  const tool = ({ hub_posts_schedule: 'post_schedule', hub_posts_update: 'post_update', hub_channels_check: 'channel_check',
    hub_publishing_pause: 'publishing_pause' } as const)[name];
  return parseWith(operationBodySchemas[name], body ?? {}, tool) as z.output<typeof operationBodySchemas[N]>;
}

function parseWith(schema: z.ZodType, args: unknown, tool: HubToolName): unknown {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw invalidArguments(zodIssues(schema, parsed.error));
  const value = parsed.data as Data;
  const issues = crossFieldIssues(tool, value);
  if (issues.length) throw invalidArguments(issues);
  return value;
}

function tagIssues(prefix: string, value: unknown): ArgumentIssue[] {
  const tags = (value as { tags?: unknown[] } | undefined)?.tags ?? [];
  return tags.flatMap((tag, index) => typeof tag === 'string' && TAG_PATTERN.test(tag) ? []
    : [{ path: `${prefix}.tags[${index}]`, code: 'invalid_format', message: `${prefix}.tags[${index}] may contain only letters, digits and _` }]);
}

function crossFieldIssues(tool: HubToolName, value: Data): ArgumentIssue[] {
  const issues: ArgumentIssue[] = [];
  const forbid = (field: string, reason: string) => {
    if (value[field] !== undefined) issues.push({ path: field, code: 'not_allowed', message: `${field} is not allowed ${reason}` });
  };
  const need = (field: string, reason: string) => {
    if (value[field] === undefined) issues.push({ path: field, code: 'required', message: `${field} is required ${reason}` });
  };
  if (tool === 'post_schedule') {
    const channels = value.channel_ids as string[];
    channels.forEach((id, index) => {
      if (channels.indexOf(id) !== index) issues.push({ path: `channel_ids[${index}]`, code: 'not_unique', message: `channel_ids[${index}] repeats ${id}` });
    });
    const captions = value.captions as Record<string, unknown> | undefined;
    if (captions !== undefined && !Object.keys(captions).length) {
      issues.push({ path: 'captions', code: 'too_small', message: 'captions needs at least one of default, x, tiktok, youtube, instagram, facebook; to post without text omit it and send no_caption: true' });
    }
    for (const [key, entry] of Object.entries(captions ?? {})) issues.push(...tagIssues(`captions.${key}`, entry));
    if (captions !== undefined) forbid('no_caption', 'together with captions');
    if (value.dst_choice !== undefined && value.when === 'now') forbid('dst_choice', "when 'when' is 'now'");
  }
  if (tool === 'post_update') {
    const action = value.action;
    if (action === 'reschedule') { need('when', 'for action reschedule'); forbid('caption', 'for action reschedule'); }
    if (action === 'cancel') { forbid('when', 'for action cancel'); forbid('caption', 'for action cancel'); forbid('timezone', 'for action cancel'); forbid('dst_choice', 'for action cancel'); }
    if (action === 'edit_caption') { need('caption', 'for action edit_caption'); forbid('when', 'for action edit_caption'); forbid('timezone', 'for action edit_caption'); forbid('dst_choice', 'for action edit_caption'); }
    if (value.caption !== undefined) issues.push(...tagIssues('caption', value.caption));
  }
  if (tool === 'media_upload') {
    const direct = ['filename', 'bytes', 'sha256', 'mime'].filter(field => value[field] !== undefined);
    if (value.path !== undefined) {
      for (const field of direct) forbid(field, 'with path (the relay form); send either path or filename, bytes and sha256');
    } else {
      need('filename', 'for the direct form (or send path through the SmartSell relay)');
      need('bytes', 'for the direct form');
      need('sha256', 'for the direct form');
    }
  }
  if (tool === 'publishing_pause') {
    if (value.scope === 'all') forbid('id', "when scope is 'all'");
    else need('id', `when scope is '${String(value.scope)}'`);
  }
  if (tool === 'posts_list' && typeof value.from === 'string' && typeof value.to === 'string' && value.from > value.to) {
    issues.push({ path: 'to', code: 'too_small', message: 'to must be on or after from' });
  }
  return issues;
}
