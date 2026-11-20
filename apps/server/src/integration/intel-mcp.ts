import { randomUUID } from 'node:crypto';
import { Problem } from '@smartsell/contracts';
import type { Config } from '../config.js';
import type { McpToolDefinition } from '../extensions/mcp.js';
import { isRecord } from '../extensions/mcp-tools.js';
import type { McpOutputDecision } from '../extensions/mcp-streamable.js';
import type { AgentContext } from '../modules/agent/agent-jobs.js';
import { DomainError, readers, type Commands } from '../modules/types.js';
import { runScopedOperation, type Registered } from '../operations.js';
import { operationRecords } from './operation-records.js';
import { workspaceServices } from './workspace-services.js';

type IntelApi = { operations: readonly Registered[]; config: Config };

/** Adapt only allowlisted REST operations, using the command transaction's workspace records. */
export function intelMcpCommands(tools: readonly McpToolDefinition[], api?: IntelApi): Commands {
  if (!api) return {};
  const enrich = workspaceServices(api.operations);
  return Object.fromEntries(tools.filter(tool => tool.module === 'intel').flatMap(tool => {
    const op = api.operations.find(op => op.module === 'intel' && op.name === tool.action && !op.external &&
      op.mcp !== false && (op.method === 'GET') === tool.annotations.readOnlyHint);
    if (!op) return [];
    return [[tool.action, {
      roles: readers.filter(role => op.roles.includes(role)),
      async run(context, payload) {
        const grantId = (context as AgentContext).agentClientId;
        if (!grantId) throw new DomainError('forbidden', 'Agent credential required', 403);
        const input = tool.parse({ ...payload, workspace_id: context.workspaceId });
        if (!input) throw new DomainError('invalid_input', 'Invalid tool input');
        if (tool.action === 'creative_reference_annotate' && !Object.keys(input.body.structure as object).length) {
          throw new DomainError('invalid_input', 'At least one structure field is required');
        }
        const readOnly = op.method === 'GET';
        const { records, flush } = await operationRecords(context, readOnly);
        try {
          const { body } = await runScopedOperation(records, context, { actorId: context.actorId, grantId },
            context.role, randomUUID(), op, input, 'mcp', api.config, enrich);
          if (!readOnly) await flush();
          return body.data;
        } catch (error) {
          if (!(error instanceof Problem)) throw error;
          const code = error.code === 'VALIDATION_ERROR' ? 'INVALID_INPUT' : error.code;
          throw new DomainError(code, 'Intel operation was unsuccessful', error.status);
        }
      },
    } satisfies Commands[string]]];
  }));
}

type JsonRecord = Record<string, unknown>;
type SourceContent = NonNullable<McpOutputDecision['untrustedContent']>[number];
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;
const kinds = ['research_item', 'observation', 'creative_reference', 'mention', 'product_candidate'] as const;
type Kind = typeof kinds[number];
const stances = ['evidence', 'counter_example', 'question', 'demand', 'hypothesis'] as const;
const structureSources = ['human', 'agent', 'mixed'] as const;
const itemTypes = ['link', 'note', 'observation', 'creative_reference', 'mention', 'candidate'] as const;
const isId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const allowedValue = <T extends string>(value: unknown, values: readonly T[]): T | undefined => values.find(item => item === value);
const pick = (row: JsonRecord, fields: readonly string[]) => Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));

function projectRow(kind: Kind, row: unknown): JsonRecord | undefined {
  if (!isRecord(row) || !isId(row.id) || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1) return;
  const result: JsonRecord = { kind, id: row.id, version: row.version };
  if (kind === 'research_item') {
    if (isId(row.board_id)) result.board_id = row.board_id;
    if (isId(row.ref_id)) result.ref_id = row.ref_id;
    if (Array.isArray(row.evidence_refs) && row.evidence_refs.every(isId)) result.evidence_refs = row.evidence_refs;
    result.item_type = allowedValue(row.item_type, itemTypes);
    result.stance = allowedValue(row.stance, stances);
    if (typeof row.ai_generated === 'boolean') result.ai_generated = row.ai_generated;
  }
  if (kind === 'creative_reference') result.structure_source = allowedValue(row.structure_source, structureSources);
  if (isTime(row.observed_at)) result.observed_at = row.observed_at;
  return result;
}

const contentFields: Record<Kind, readonly string[]> = {
  observation: ['url', 'note', 'attributes', 'metrics'],
  research_item: ['title', 'body', 'url', 'labels'],
  creative_reference: ['url', 'structure', 'tags'],
  mention: ['url', 'text_excerpt'],
  product_candidate: ['title', 'name', 'url', 'hypothesis'],
};

function sourceContent(kind: Kind, row: JsonRecord, content: JsonRecord): SourceContent | undefined {
  const capturedAt = row.observed_at ?? row.created_at;
  if (!isTime(capturedAt)) return;
  return { source: `${kind}:${row.id}`, capturedAt, content };
}

/** Only emit domain-authorized protocol metadata and explicitly selected untrusted fields. */
export function intelMcpOutput(action: string, raw: unknown): McpOutputDecision | null {
  if (!isRecord(raw)) return null;
  if (action === 'creative_reference_annotate' || action === 'research_create_note') {
    const data = projectRow(action === 'research_create_note' ? 'research_item' : 'creative_reference', raw);
    return data ? { data } : null;
  }
  if (action === 'research_search') {
    const data: JsonRecord = {};
    const untrustedContent: SourceContent[] = [];
    for (const [group, kind] of [['observations', 'observation'], ['research_items', 'research_item'],
      ['creative_references', 'creative_reference'], ['mentions', 'mention']] as const) {
      const rows = raw[group];
      if (group === 'mentions' && rows === undefined) continue;
      if (!Array.isArray(rows)) return null;
      const items: JsonRecord[] = [];
      for (const row of rows.slice(0, 8)) {
        const metadata = projectRow(kind, row);
        if (!metadata || !isRecord(row) || !isRecord(row.untrusted_content)) return null;
        const entry = sourceContent(kind, row, pick({ ...row.untrusted_content, metrics: row.metrics }, contentFields[kind]));
        if (!entry) return null;
        items.push(metadata);
        untrustedContent.push(entry);
      }
      data[group] = items;
      if (rows.length > items.length) data.truncated = true;
    }
    return { data, untrustedContent };
  }
  if (action === 'research_item_evidence' && isRecord(raw.item) && Array.isArray(raw.evidence)) {
    const item = projectRow('research_item', raw.item);
    const root = sourceContent('research_item', raw.item, pick(raw.item, contentFields.research_item));
    if (!item || !root) return null;
    const evidence: JsonRecord[] = [];
    const untrustedContent = [root];
    for (const row of raw.evidence) {
      const kind = isRecord(row) && allowedValue(row.kind, kinds);
      if (!kind || !isRecord(row)) return null;
      const metadata = projectRow(kind, row);
      if (!metadata) return null;
      evidence.push(metadata);
      if (untrustedContent.length < 25) {
        const entry = sourceContent(kind, row, pick(row, contentFields[kind]));
        if (!entry) return null;
        untrustedContent.push(entry);
      }
    }
    return { data: { item, evidence, ...(evidence.length >= 25 && { content_truncated: true }) }, untrustedContent };
  }
  return null;
}
