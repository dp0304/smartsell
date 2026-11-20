import type { Context, Row } from '@smartsell/contracts';
import { frozenRevisionHash, parseFrozenRevision, type Target } from '../../../../packages/connector-tasks/src/tasks.js';
import { entries, object } from '../../../../packages/domain/src/publishing/index.js';
import { sessionFor } from '../modules/account/device-control.js';
import { expireConnectorTasks, type ConnectorServices } from '../modules/account/connector-service.js';
import type { ConnectorDispatch } from '../modules/execution/connector.js';
import { createExecutionWorker, scanWorkspaceExecution, type ExecutionAdapter } from '../modules/execution/worker.js';
import type { BackgroundDrain } from '../runtime.js';

export function publishConnector(services: Omit<ConnectorServices, 'authorizeTask'>): ConnectorDispatch {
  return { services, encode(ctx, task, binding) {
    const account = ctx.get('social_account', String(task.social_account_id));
    const session = sessionFor(ctx, binding);
    if (!session || typeof account.external_account_id !== 'string' || typeof binding.device_id !== 'string') return;
    const { target, kind } = location(account, binding, session) ?? {};
    if (!target || !kind) return;
    const frozen = object(task.frozen);
    const rendered = object(frozen.rendered);
    const renditions = new Map(entries(frozen.refs).filter(ref => ref.ref_type === 'asset_rendition').map(ref => [ref.ref_id, ref.binding]));
    const versions = new Map(entries(frozen.media_bindings).map(ref => [ref.asset_version_id, ref.sha256]));
    const media = entries(frozen.media).filter(item => !item.role || ['primary', 'slide'].includes(String(item.role))).map(item => ({
      id: item.rendition_id ?? item.asset_version_id,
      sha256: item.rendition_id ? renditions.get(item.rendition_id) : versions.get(item.asset_version_id),
    }));
    // The wire schema cannot represent all target options. Do not silently discard them.
    if (Object.keys(object(frozen.options)).length || entries(frozen.link_refs).length || entries(frozen.product_refs).length) return;
    try {
      const revision = parseFrozenRevision({ id: task.variant_revision_id, title: rendered.title ?? '', body: rendered.text ?? '',
        tags: rendered.tags ?? [], visibility: frozen.visibility ?? 'public', media });
      const hash = frozenRevisionHash(revision);
      return { schema_version: 1, kind, target, workspace_id: ctx.workspaceId, account_id: account.id,
        connector_device_id: binding.device_id, binding_id: binding.id, platform_identity: account.external_account_id,
        payload: { revision, frozen_hash: hash, approval: { id: String(task.approval_request_id), resource_hash: hash } } };
    } catch { return; }
  } };
}

function location(account: Row, binding: Row, session: Row): { target: Target; kind: `${Target['app']}.app.publish` | 'xhs.note.publish' | 'douyin.video.publish' } | undefined {
  switch (account.provider) {
    case 'xiaohongshu':
    case 'douyin': {
      const app = account.provider === 'xiaohongshu' ? 'xhs' : 'douyin';
      if (binding.connector_channel === 'browser') return { target: { channel: 'browser', app, profile_id: session.id }, kind: app === 'xhs' ? 'xhs.note.publish' : 'douyin.video.publish' };
      if (binding.connector_channel === 'mobile' && binding.mobile_app === app && typeof binding.mobile_device_id === 'string') {
        return { target: { channel: 'mobile', app, mobile_device_id: binding.mobile_device_id }, kind: `${app}.app.publish` };
      }
      return;
    }
  }
}

/** Replace the legacy execution.due scheduler when this drain is wired. */
export function publishDrain(connector: ConnectorDispatch, adapters: readonly ExecutionAdapter[] = []): BackgroundDrain {
  return async transact => {
    await transact(expireConnectorTasks);
    const result = await createExecutionWorker(transact, adapters, connector).tick();
    await transact(ctx => scanWorkspaceExecution(ctx, { manualDatesOnly: true }));
    if (result.failures.length) throw new Error(`Publishing work failed: ${result.failures.map(row => `${row.action}:${row.task_id}`).join(', ')}`);
  };
}
