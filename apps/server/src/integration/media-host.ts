import { createHmac, randomUUID } from 'node:crypto';
import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { makeContext } from '../context.js';
import { createMediaFiles, mediaStorageFromConfig, registerMediaFiles, requireMediaFile } from '../extensions/media-files.js';
import { expireAgentUploads } from './agent-uploads.js';
import { originGuard } from '../identity.js';
import { getRetentionPolicy, scheduledAssetReference } from '../modules/ops/retention.js';
import { tenantScope, type OpsContext } from '../modules/ops/support.js';
import { getRetentionPolicy as commandRetention } from '../modules/ops/retention-policy.js';
import type { Context as CommandContext, Entity } from '../modules/types.js';
import type { Registered, Schedule, Subscriber } from '../operations.js';
import type { Unit } from '../store.js';
import { operationRecords, operationRow } from './operation-records.js';

type Media = ReturnType<typeof createMediaFiles>;
const boundMedia = new WeakMap<Context, Media>();
const commandRetentionState = new WeakMap<Context, Awaited<ReturnType<typeof compatibleMediaPolicies>>>();
const mediaClasses = ['asset_file', 'evidence', 'export_file'];

export async function compatibleMediaPolicies(ctx: CommandContext) {
  const entries = await Promise.all(mediaClasses.map(async kind => [kind, await commandRetention(ctx, kind)] as const));
  const references = new Set<string>();
  const rows = new Map<string, Row[]>();
  await Promise.all(Object.entries({ asset: ['asset_version', 'asset_rendition', 'submission'],
    content: ['content_reference', 'content_revision', 'content_variant'], planning: ['publish_target', 'publish_target_ref'] })
    .flatMap(([module, kinds]) => kinds.map(async kind => {
      const entities = await ctx.list(module, kind);
      rows.set(kind, entities.map(({ data, id, version, created_at, updated_at }) => ({ ...data, id, version, created_at, updated_at })));
      if (module !== 'asset') return;
      for (const { data } of entities) {
        for (const id of [data.file_object_id, data.thumbnail_file_id, data.thumbnail_file_object_id]) {
          if (typeof id === 'string') references.add(id);
        }
      }
    })));
  return { policies: new Map(entries), references, native: { list: (kind: string) => rows.get(kind) ?? [] } };
}

export async function compatibleMediaFile(context: CommandContext, id: string, purposes: readonly string[]): Promise<Entity | undefined> {
  const row = await operationRow<Row>(context, 'file_object', id);
  if (!row) return;
  const ctx = { ...context, list: () => [row] };
  try { requireMediaFile(ctx, id, purposes); }
  catch (error) {
    if (error instanceof Problem && error.status === 404) return;
    throw error;
  }
  const { id: _id, version, tenant_id, workspace_id, created_at, updated_at, storage_key: _key, bucket: _bucket, ...data } = row;
  return { id, module: 'core', kind: 'file_object', version, tenant_id: String(tenant_id), workspace_id: String(workspace_id), created_at, updated_at, data };
}

export function mediaFor(ctx: Context): Media {
  const media = boundMedia.get(ctx);
  if (!media) throw new Problem(503, 'MEDIA_UNAVAILABLE', 'Workspace media host is unavailable');
  return media;
}

export function createMediaHost(config: Config) {
  const media = createMediaFiles({
    // The media directory follows the data file (§6.7) and the upload ceiling follows the mode (§6.5).
    storage: mediaStorageFromConfig(config),
    maxBytes: config.maxUploadBytes,
    signingKey: createHmac('sha256', config.secret).update('smartsell/workspace-media/v1').digest(),
    policies: {
      retention(ctx, dataClass) {
        if (!mediaClasses.includes(dataClass)) return;
        const compatible = commandRetentionState.get(ctx)?.policies.get(dataClass);
        if (compatible) return compatible;
        const effective = getRetentionPolicy(ctx, dataClass);
        const held = tenantScope(ctx)?.list('retention_policy').some(row => row.data_class === dataClass && row.legal_hold === true);
        return held ? { ...effective, legal_hold: true } : effective;
      },
      references(ctx, row) {
        const compatible = commandRetentionState.get(ctx);
        const reasons = compatible?.references.has(row.id) ? ['asset'] : [];
        if (row.purpose === 'asset' && (scheduledAssetReference(ctx, row) ||
          (compatible && scheduledAssetReference(compatible.native, row)))) reasons.push('scheduled_target');
        return reasons;
      },
      evidenceResourceExists(ctx, kind, id) {
        return ctx.list(kind).some(row => row.id === id && !row.deleted_at);
      },
    },
  });
  const assetFileRetention: OpsContext['assetFileRetention'] = {
    candidates: ctx => media.retentionCandidates(ctx, 'asset_file'),
    purge: (ctx, files) => media.purgeReviewed(ctx, files, 'asset_file'),
  };
  const bind = (op: Registered, retention?: Awaited<ReturnType<typeof compatibleMediaPolicies>>): Registered => ({ ...op, run(ctx, input) {
    boundMedia.set(ctx, media);
    if (op.module === 'ops') (ctx as OpsContext).assetFileRetention = assetFileRetention;
    if (retention) commandRetentionState.set(ctx, retention);
    return op.run(ctx, input);
  } });
  const bindSubscriber = (subscriber: Subscriber): Subscriber => ({ ...subscriber, run(ctx, event) {
    boundMedia.set(ctx, media);
    return subscriber.run(ctx, event);
  } });
  // Agents upload the media they attach to content; deleting files and retention stay with people and operators.
  const agentFileOperations = new Set(['file_begin_upload', 'file_complete_upload', 'file_get']);
  const operations = media.operations.map(op => ({ ...op, module: 'files', ...(!agentFileOperations.has(op.name) && { mcp: false }) }));
  // Physical deletion runs in a separate transaction after a tombstone commits. The same schedule fails agent upload
  // sessions that passed their 24 h deadline (§6.4 step 4); it gates itself to once an hour per workspace and removes
  // staging directories only after the transaction (no file IO inside it).
  const expiredAt = new Map<string, number>();
  const schedule: Schedule = { id: 'files.cleanup', async run(ctx) {
    const result = await media.cleanup(ctx);
    const last = expiredAt.get(ctx.workspaceId) ?? 0;
    if (Date.parse(ctx.now) - last >= 3_600_000) {
      expiredAt.set(ctx.workspaceId, Date.parse(ctx.now));
      expireAgentUploads(ctx, { mediaDirectory: config.mediaDirectory });
    }
    return result;
  } };
  return { media, operations, bind, bindSubscriber, schedule };
}

type Workspace = <T>(request: FastifyRequest, wid: string, run: (unit: Unit) => Promise<T>) => Promise<T>;

export function mountCompatibleMedia(app: FastifyInstance, config: Config, host: ReturnType<typeof createMediaHost>,
  workspace: Workspace, csrf: (request: FastifyRequest) => void) {
  registerMediaFiles(app, host.media, {
    async workspace<T>(request: FastifyRequest, wid: string, write: boolean, run: (ctx: Context) => Promise<T>) {
      originGuard(request, config);
      return workspace(request, wid, async unit => {
        const execute = async () => {
          const { records, flush } = await operationRecords(unit.context, !write);
          const result = await run(makeContext(records, unit.context, unit.context.role, request.id));
          if (write) await flush();
          return result;
        };
        if (!write) return execute();
        csrf(request);
        return await unit.command({ module: 'files', action: 'file_stage_upload', key: `media/${randomUUID()}`, fingerprint: '' }, execute) as T;
      });
    },
  });
}
