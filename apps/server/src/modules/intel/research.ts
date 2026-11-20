import { DomainError, readers, required, text, writers } from '../types.ts';
import type { Context, Entity, Fields } from '../types.ts';
import { mergeCreativeStructure } from './intel-research.js';
import { authorizeUses, requireReadable, sourceIds } from './observations.ts';
import { active, assertVersion, choice, command, conflict, create, fail, get, list, number, object, optional, selected, strings, timestamp, update, url } from './validation.ts';

const itemTypes = ['link', 'observation', 'note', 'creative_reference', 'mention', 'candidate'] as const;
const stances = ['evidence', 'counter_example', 'question', 'demand', 'hypothesis'] as const;
const referenceKinds: Record<string, string> = {
  observation: 'observation', creative_reference: 'creative_reference', mention: 'mention', candidate: 'product_candidate',
};
const boardFields = ['brand_id', 'campaign_id', 'kind', 'title', 'description'];
const itemFields = ['item_type', 'ref_id', 'url', 'title', 'body', 'stance', 'labels', 'lane', 'position', 'authorship', 'evidence_refs'];
const creativeFields = ['url', 'platform', 'external_id', 'watch_target_id', 'structure', 'structure_source', 'agent_job_id', 'model_ref', 'observation_id', 'tags'];
const structureText = ['hook', 'topic', 'format', 'presentation', 'cta', 'interaction_question'];

const agentClient = (ctx: Context) => (ctx as Context & { agentClientId?: string }).agentClientId;

async function available<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); }
  catch (error) {
    if (error instanceof DomainError && ['not_found', 'forbidden', 'EGRESS_BLOCKED', 'invalid_state'].includes(error.code)) return undefined;
    throw error;
  }
}

async function requireResearchReadable(ctx: Context, rows: Entity[], use?: 'team_share' | 'export') {
  await requireReadable(ctx, rows, use);
  if (agentClient(ctx)) await authorizeUses(ctx, sourceIds(rows), 'model_processing');
}

async function sourceRows(ctx: Context, row: Entity): Promise<Entity[]> {
  return row.kind === 'creative_reference' && row.data.observation_id
    ? [row, await get(ctx, 'observation', row.data.observation_id)] : [row];
}

export async function evidence(ctx: Context, ids: string[], use?: 'team_share' | 'export'): Promise<Entity[]> {
  const visited = new Map<string, Entity>();
  async function walk(id: string) {
    if (visited.has(`research_item:${id}`)) return;
    if (visited.size >= 400) fail('Too many nested evidence references');
    const item = await get(ctx, 'research_item', id);
    if (item.data.status !== 'active') conflict('Archived items cannot be used as evidence');
    visited.set(`research_item:${id}`, item);
    if (item.data.ref_id && (item.data.item_type !== 'candidate' || use === 'export')) {
      const ref = await get(ctx, referenceKinds[item.data.item_type], item.data.ref_id);
      for (const row of await sourceRows(ctx, ref)) visited.set(`${row.kind}:${row.id}`, row);
      if (ref.kind === 'product_candidate') {
        const scores = (await list(ctx, 'candidate_score')).filter(row => row.data.candidate_id === ref.id);
        for (const score of scores) for (const upstream of score.data.evidence_item_ids ?? []) await walk(upstream);
      }
    }
    for (const upstream of item.data.evidence_refs ?? []) await walk(upstream);
  }
  for (const id of ids) await walk(id);
  const rows = [...visited.values()];
  await requireResearchReadable(ctx, rows, use);
  return rows;
}
export function isEvidence(item: Entity) {
  return item.data.status === 'active' && item.data.item_type !== 'candidate' &&
    ['evidence', 'counter_example', 'demand'].includes(item.data.stance) &&
    (!item.data.ai_generated || item.data.evidence_refs?.length > 0);
}
function itemPatch(input: Fields): Fields {
  return {
    ...selected(input, ['ref_id', 'title', 'body', 'lane']),
    ...(input.url !== undefined ? { url: url(input) } : {}),
    ...(input.stance !== undefined ? { stance: choice(input, 'stance', stances) } : {}),
    ...(input.labels !== undefined ? { labels: strings(input, 'labels') } : {}),
    ...(input.position !== undefined ? { position: number(input, 'position', 0, Number.MAX_SAFE_INTEGER) } : {}),
    ...(input.item_type !== undefined ? { item_type: choice(input, 'item_type', itemTypes) } : {}),
    ...(input.authorship !== undefined ? { ai_generated: choice(input, 'authorship', ['human', 'agent']) === 'agent' } : {}),
    ...(input.evidence_refs !== undefined ? { evidence_refs: strings(input, 'evidence_refs', 30) } : {}),
  };
}
async function validateItem(ctx: Context, data: Fields, id?: string) {
  if (data.item_type === 'note' && !data.body) fail('Notes require a body');
  if (data.item_type === 'link' && !data.url) fail('Links require a URL');
  const kind = referenceKinds[data.item_type];
  if (kind) {
    const ref = await get(ctx, kind, text(data, 'ref_id'));
    await requireResearchReadable(ctx, await sourceRows(ctx, ref), 'team_share');
  } else if (data.ref_id) fail('This item type does not take a reference');
  const linked = await evidence(ctx, data.evidence_refs, 'team_share');
  if (id && linked.some(item => item.id === id && item.kind === 'research_item')) fail('Research evidence cannot contain cycles');
  if (data.ai_generated && data.item_type === 'note' && !linked.some(row => row.kind === 'research_item' && !row.data.ai_generated && isEvidence(row))) data.stance = 'hypothesis';
  data.authorship = data.ai_generated ? 'agent' : 'human';
  return data;
}
async function creativePatch(ctx: Context, input: Fields): Promise<Fields> {
  const patch = { ...selected(input, ['platform', 'external_id', 'watch_target_id', 'observation_id']) };
  if (input.url !== undefined) patch.url = url(input);
  if (input.structure !== undefined) {
    const fields = object(input.structure, [...structureText, 'duration_s'], 'structure');
    patch.structure = { ...selected(fields, structureText),
      ...(fields.duration_s !== undefined ? { duration_s: number(fields, 'duration_s', 0, 604800, true) } : {}) };
  }
  if (input.structure_source !== undefined) patch.structure_source = choice(input, 'structure_source', ['human', 'agent', 'mixed']);
  if (input.tags !== undefined) patch.tags = strings(input, 'tags');
  if (patch.watch_target_id) await get(ctx, 'watch_target', patch.watch_target_id);
  if (patch.observation_id) {
    const ref = await get(ctx, 'observation', patch.observation_id);
    await requireResearchReadable(ctx, [ref], 'team_share');
  }
  return patch;
}
function creativeAnnotation(ctx: Context, input: Fields, patch: Fields, previous?: Fields): Fields {
  const actor = agentClient(ctx) ? 'agent' : 'human';
  const structure = mergeCreativeStructure(previous, patch.structure ?? {}, actor, ctx.actorId);
  const metadata = selected(input, ['agent_job_id', 'model_ref']);
  if (Object.keys(metadata).length && (actor !== 'agent' || !Object.keys(patch.structure ?? {}).length)) {
    fail('Job and model metadata require an agent annotation');
  }
  if (actor === 'agent' && Object.keys(patch.structure ?? {}).length) {
    return { ...structure, agent_job_id: metadata.agent_job_id ?? null, model_ref: metadata.model_ref ?? null };
  }
  if (structure.structure_source === 'human') return { ...structure, agent_job_id: null, model_ref: null };
  return structure;
}

async function validateCreative(ctx: Context, data: Fields) {
  if (data.observation_id) {
    const obs = await get(ctx, 'observation', data.observation_id);
    if (obs.data.url !== data.url || (data.watch_target_id && obs.data.watch_target_id !== data.watch_target_id)) {
      fail('Creative observation must match this reference');
    }
    await requireResearchReadable(ctx, [obs], 'team_share');
  }
}

export const researchCommands = {
  resolve_research_evidence: command(readers, async (ctx, input) => {
    object(input, ['id']);
    const [item, ...linked] = await evidence(ctx, [text(input, 'id')]);
    return { item, evidence: linked };
  }),
  research_board_detail: command(readers, async (ctx, input) => {
    object(input, ['id']);
    const board = await get(ctx, 'research_board', text(input, 'id'));
    const items: Entity[] = [];
    for (const item of await list(ctx, 'research_item')) {
      if (item.data.board_id !== board.id || item.data.status !== 'active') continue;
      if (await available(() => evidence(ctx, [item.id], 'team_share'))) items.push(item);
    }
    return { board, items: items.sort((a, b) => a.data.position - b.data.position || a.id.localeCompare(b.id)) };
  }),
  list_creative_references: command(readers, async (ctx, input) => {
    object(input, ['watch_target_id', 'tag']);
    const watch = optional(input, 'watch_target_id', text);
    const tag = optional(input, 'tag', text);
    if (watch) await get(ctx, 'watch_target', watch);
    const items = (await list(ctx, 'creative_reference')).filter(row => (!watch || row.data.watch_target_id === watch) &&
      (!tag || row.data.tags.includes(tag)));
    const visible = [];
    for (const row of items) {
      if (await available(async () => { await validateCreative(ctx, row.data); return true; })) visible.push(row);
    }
    return { items: visible };
  }),
  create_research_board: command(writers, async (ctx, input) => {
    object(input, boardFields);
    const fields = selected(input, ['brand_id', 'campaign_id', 'description']);
    if (fields.campaign_id) await required(ctx, 'campaign', 'campaign', fields.campaign_id);
    return create(ctx, 'research_board', { ...fields, title: text(input, 'title', 160),
      kind: choice(input, 'kind', ['research', 'creative', 'product_opportunity']), status: 'active' });
  }),
  update_research_board: command(writers, async (ctx, input) => {
    object(input, ['id', 'expected_version', 'title', 'description', 'status']);
    const row = await get(ctx, 'research_board', text(input, 'id'));
    active(row);
    const patch = selected(input, ['title', 'description']);
    if (input.status !== undefined) patch.status = choice(input, 'status', ['active', 'archived']);
    if (!Object.keys(patch).length) fail('No board changes supplied');
    return update(ctx, 'research_board', row, patch, input);
  }),
  add_research_item: command(writers, async (ctx, input) => {
    object(input, ['board_id', ...itemFields]);
    const board = await get(ctx, 'research_board', text(input, 'board_id'));
    active(board);
    const patch = await validateItem(ctx, { evidence_refs: [], ai_generated: false, labels: [], position: 0, lane: 'inbox',
      stance: 'evidence', ...itemPatch(input), ...(agentClient(ctx) ? { ai_generated: true } : {}),
      item_type: choice(input, 'item_type', itemTypes) });
    return create(ctx, 'research_item', { ...patch, board_id: board.id, status: 'active', converted_to: null });
  }),
  update_research_item: command(writers, async (ctx, input) => {
    object(input, ['id', 'expected_version', 'status', ...itemFields.filter(field => !['item_type', 'ref_id', 'authorship'].includes(field))]);
    const row = await get(ctx, 'research_item', text(input, 'id'));
    active(row);
    active(await get(ctx, 'research_board', row.data.board_id));
    const patch = itemPatch(input);
    if (input.status !== undefined) patch.status = choice(input, 'status', ['active', 'archived']);
    if (!Object.keys(patch).length) fail('No item changes supplied');
    if (patch.status === 'archived' && Object.keys(patch).length === 1) return update(ctx, 'research_item', row, patch, input);
    const next = await validateItem(ctx, { ...row.data, ...patch, ...(agentClient(ctx) && patch.body ? { ai_generated: true } : {}) }, row.id);
    patch.stance = next.stance;
    patch.authorship = next.authorship;
    patch.ai_generated = next.ai_generated;
    return update(ctx, 'research_item', row, patch, input);
  }),
  create_creative_reference: command(writers, async (ctx, input) => {
    object(input, creativeFields);
    const patch = await creativePatch(ctx, input);
    const data = { tags: [], ...patch, ...creativeAnnotation(ctx, input, patch), url: url(input), rights: 'reference_only' };
    await validateCreative(ctx, data);
    return create(ctx, 'creative_reference', data);
  }),
  annotate_creative_reference: command(writers, async (ctx, input) => {
    object(input, ['id', 'expected_version', ...creativeFields.filter(field => field !== 'url')]);
    const row = await get(ctx, 'creative_reference', text(input, 'id'));
    const patch = await creativePatch(ctx, input);
    if (!Object.keys(patch).length) fail('No annotation changes supplied');
    if (row.data.observation_id && patch.observation_id && row.data.observation_id !== patch.observation_id) fail('Creative observation cannot be changed');
    const next = { ...patch, ...creativeAnnotation(ctx, input, patch, row.data), rights: 'reference_only' };
    await validateCreative(ctx, { ...row.data, ...next });
    return update(ctx, 'creative_reference', row, next, input, 'creative_reference.annotated');
  }),
  convert_research_item: command(writers, async (ctx, input) => {
    object(input, ['id', 'expected_version', 'destination', 'target_id', 'summary']);
    const row = await get(ctx, 'research_item', text(input, 'id'));
    assertVersion(row, input);
    active(row);
    active(await get(ctx, 'research_board', row.data.board_id));
    if (row.data.converted_to) conflict('Item has already been converted');
    await evidence(ctx, [row.id], 'team_share');
    const destination = choice(input, 'destination', ['content.idea', 'campaign.brief']);
    const [target_module, target_kind] = destination.split('.');
    const targetId = optional(input, 'target_id', text);
    const target = targetId ? await required(ctx, target_module, target_kind, targetId) : undefined;
    const summary = text(input, 'summary');
    const handoff = await create(ctx, 'research_handoff', { research_item_id: row.id, target_module, target_kind,
      target_id: target?.id ?? null, summary, status: target ? 'linked' : 'pending' });
    await update(ctx, 'research_item', row, { converted_to: { module: target_module, resource_type: target_kind,
      id: target?.id ?? null, handoff_id: handoff.id } }, input, 'research_item.converted', {
      research_item_id: row.id, handoff_id: handoff.id, target_module, target_kind, target_id: target?.id ?? null,
    });
    return handoff;
  }),
  link_research_handoff: command(writers, async (ctx, input) => {
    object(input, ['id', 'expected_version', 'target_id']);
    const row = await get(ctx, 'research_handoff', text(input, 'id'));
    if (row.data.status !== 'pending') conflict('Handoff is not pending');
    const targets = ['content.idea', 'campaign.brief', 'inbox.case', 'workspace.work_item'];
    if (!targets.includes(`${row.data.target_module}.${row.data.target_kind}`)) conflict('Unsupported handoff destination');
    const target = await required(ctx, row.data.target_module, row.data.target_kind, text(input, 'target_id'));
    if (row.data.research_item_id) {
      const item = await get(ctx, 'research_item', row.data.research_item_id);
      await evidence(ctx, [item.id], 'team_share');
      await ctx.update('intel', 'research_item', item.id, { converted_to: { ...item.data.converted_to, id: target.id } }, item.version);
    } else if (row.data.mention_id) {
      await requireReadable(ctx, [await get(ctx, 'mention', row.data.mention_id)], 'team_share');
    }
    return update(ctx, 'research_handoff', row, { status: 'linked', target_id: target.id }, input, 'research_handoff.linked');
  }),
  search_research: command(readers, async (ctx, input) => {
    object(input, ['keyword', 'watch_target_id', 'from', 'to', 'id', 'kind']);
    const keyword = optional(input, 'keyword', (fields, key) => text(fields, key, 160).toLocaleLowerCase());
    const watchTargetId = optional(input, 'watch_target_id', text);
    const from = optional(input, 'from', timestamp);
    const to = optional(input, 'to', timestamp);
    if (from && to && from >= to) fail('Search period must be ordered');
    if (watchTargetId) await get(ctx, 'watch_target', watchTargetId);
    const kinds = ['observation', 'research_item', 'creative_reference', 'mention'] as const;
    const exact = optional(input, 'id', text);
    const kindFilter = optional(input, 'kind', (fields, key) => choice(fields, key, kinds));
    if (exact && !kindFilter) fail('An exact search ID requires a kind');
    const items = [];
    for (const kind of kindFilter ? [kindFilter] : kinds) {
      const rows = exact ? [await get(ctx, kind, exact)] : await list(ctx, kind);
      for (const row of rows) {
        const at = row.data.observed_at ?? row.created_at;
        if (row.data.status === 'archived' || (from && at < from) || (to && at >= to)) continue;
        const content = [row.data.title, row.data.body, row.data.note, row.data.attributes?.title, row.data.text_excerpt,
          ...Object.values(row.data.structure ?? {}), row.data.url].filter(value => typeof value === 'string').join('\n');
        if (keyword && !content.toLocaleLowerCase().includes(keyword)) continue;
        const resolve = async () => {
          if (kind === 'research_item') return evidence(ctx, [row.id]);
          const refs = await sourceRows(ctx, row);
          await requireResearchReadable(ctx, refs);
          return refs;
        };
        const linked = exact ? await resolve() : await available(resolve);
        if (!linked || (watchTargetId && !linked.some(ref => ref.data.watch_target_id === watchTargetId))) continue;
        if (items.length === 100) return { items, truncated: true };
        items.push({ id: row.id, kind, version: row.version, untrusted_content: content });
      }
    }
    return { items, truncated: false };
  }),
};
