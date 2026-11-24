import assert from 'node:assert/strict';
import test from 'node:test';
import { Problem, type Context, type Data, type Role, type Row } from '@smartsell/contracts';
import { assessTarget } from '../../../../../packages/domain/src/publishing/index.js';
import { applyChannelDefaults, channelPlatformOptions, operations } from './index.js';

function memory(role: Role = 'owner', extra: Data = {}) {
  const rows = new Map<string, Row[]>();
  let serial = 0;
  const ctx: Context = {
    actorId: 'owner', role, tenantId: 'tenant', workspaceId: 'workspace', now: '2026-11-24T10:00:00.000Z',
    list: (kind: string) => rows.get(kind) ?? [],
    get(kind: string, id: string) {
      const row = ctx.list(kind).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', `${kind}: ${id}`);
      return row;
    },
    create(kind: string, data: Data) {
      const row = { ...structuredClone(data), id: `${kind}-${++serial}`, version: 1, created_at: ctx.now, updated_at: ctx.now } as Row;
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind: string, id: string, data: Data) {
      const row = ctx.get(kind, id);
      const updated = { ...row, ...structuredClone(data), id, version: row.version + 1, updated_at: ctx.now } as Row;
      rows.set(kind, ctx.list(kind).map(item => item.id === id ? updated : item));
      return updated;
    },
    remove(kind: string, id: string) { rows.set(kind, ctx.list(kind).filter(row => row.id !== id)); },
    emit() {},
  };
  Object.assign(ctx, extra);
  const run = async (name: string, body: Data, as: Context = ctx) => {
    const operation = operations.find(op => op.name === name) ?? assert.fail(`missing ${name}`);
    return operation.run(as, { body, params: {}, query: {} }) as Promise<Data>;
  };
  const media = (fields: Data = {}) => {
    const file = ctx.create('file_object', { purpose: 'asset', sha256: 'c'.repeat(64), scan_status: 'skipped', mime_type: 'video/mp4' });
    const asset = ctx.create('asset', { kind: 'video', brand_id: null, ownership: 'owned', status: 'ready', ...fields });
    const version = ctx.create('asset_version', { asset_id: asset.id, file_object_id: file.id, sha256: 'c'.repeat(64), mime_type: 'video/mp4' });
    return { asset, version };
  };
  return { ctx, run, media };
}

type Loose = Row & Record<string, any>;
const tiktokDefaults = { privacy_level: 'MUTUAL_FOLLOW_FRIENDS', allow_comment: true, allow_duet: true, allow_stitch: true, commercial_disclosure: 'your_brand', ai_generated: true } as const;

test('channel defaults become a channel_defaults revision with ai_generated, and a person\'s later choice survives a re-apply', async () => {
  const { ctx, run, media } = memory('owner', { agentCredentialId: 'credential-a' });
  const account = ctx.create('social_account', { provider: 'tiktok', status: 'active', brand_id: 'brand' });
  const { asset, version } = media();
  const created = await run('content_create_draft', { brand_id: 'brand', title: 'Clip', variants: [{ platform: 'tiktok', format: 'short_video', social_account_id: account.id,
    body: '', media: [{ asset_id: asset.id, asset_version_id: version.id, role: 'primary' }] }] }) as { variants: Loose[]; revisions: Loose[] };
  const variant = created.variants[0];
  assert.equal(created.revisions[0].origin, 'agent');
  assert.equal(created.revisions[0].settings.platform_options.tiktok.privacy_level, undefined, 'an Agent never picks options');
  const applied = await applyChannelDefaults(ctx, variant.id, { tiktok: tiktokDefaults });
  const revision = ctx.get('content_revision', applied.revision_id) as Loose;
  assert.deepEqual(revision.settings.platform_options.tiktok, { ...tiktokDefaults });
  assert.deepEqual([revision.origin, revision.created_by_type, revision.ai_generated], ['channel_defaults', 'system', true]);
  assert.equal(ctx.get('content_variant', variant.id).current_revision_id, revision.id);
  assert.deepEqual(await applyChannelDefaults(ctx, variant.id, { tiktok: tiktokDefaults }), { revision_id: revision.id, changed: false });
  // A person turns comments off on the revision; the next defaults change keeps that choice and applies the rest.
  const human = ctx.create('content_revision', { ...revision, id: undefined, origin: 'human',
    settings: { ...revision.settings, platform_options: { tiktok: { ...tiktokDefaults, allow_comment: false } } } });
  ctx.update('content_variant', variant.id, { current_revision_id: human.id, draft_doc: { ...(ctx.get('content_variant', variant.id) as Loose).draft_doc, settings: human.settings } });
  const second = await applyChannelDefaults(ctx, variant.id, { tiktok: { ...tiktokDefaults, privacy_level: 'SELF_ONLY', commercial_disclosure: 'none' } });
  assert.deepEqual((ctx.get('content_revision', second.revision_id) as Loose).settings.platform_options.tiktok,
    { ...tiktokDefaults, allow_comment: false, privacy_level: 'SELF_ONLY', commercial_disclosure: 'none' });
  // The options reach the precheck payload that the Worker job is frozen from.
  const target = { brand_id: 'brand', content_item_id: variant.content_item_id, social_account_id: account.id, content_variant_id: variant.id,
    variant_revision_id: second.revision_id, scheduled_at: '2026-11-25T01:00:00.000Z', content_format: 'short', operation: 'publish' };
  assert.equal(((assessTarget(ctx, target, 'schedule').payload.options as Data).platform_options as Data & { tiktok: Data }).tiktok.ai_generated, true);
  assert.equal(channelPlatformOptions('youtube', { tiktok: tiktokDefaults }), null);
});

test('X variants accept a person\'s reply setting; Agents cannot set reply_settings or ai_generated directly', async () => {
  const { ctx, run, media } = memory();
  const account = ctx.create('social_account', { provider: 'x', status: 'active', brand_id: 'brand' });
  const { asset, version } = media();
  const item = { brand_id: 'brand', title: 'Clip' };
  const variant = { platform: 'x', format: 'short_video', social_account_id: account.id, body: 'New lure', media: [{ asset_id: asset.id, asset_version_id: version.id }] };
  const agent = { ...ctx, role: 'agent' as Role };
  await assert.rejects(run('content_create_draft', { ...item, variants: [{ ...variant, settings: { platform_options: { x: { reply_settings: 'following' } } } }] }, agent),
    (error: Problem) => error.code === 'human_selection_required');
  const tiktokAccount = ctx.create('social_account', { provider: 'tiktok', status: 'active', brand_id: 'brand' });
  await assert.rejects(run('content_create_draft', { ...item, variants: [{ ...variant, platform: 'tiktok', social_account_id: tiktokAccount.id,
    settings: { platform_options: { tiktok: { ai_generated: true } } } }] }, agent), (error: Problem) => error.code === 'human_selection_required');
  const human = await run('content_create_item', { ...item, variants: [{ ...variant, settings: { platform_options: { x: { reply_settings: 'following' } } } }] }) as { variants: Loose[] };
  assert.deepEqual(human.variants[0].draft_doc.settings.platform_options.x, { reply_settings: 'following' });
  await assert.rejects(run('content_create_item', { ...item, variants: [{ ...variant, settings: { platform_options: { x: { reply_settings: 'nobody' } } } }] }), (error: Problem) => error.code === 'invalid_input');
});

test('content validation counts X weighted length against caption_limit and lets owned media pass without a rights grant', async () => {
  const { ctx, run, media } = memory();
  const account = ctx.create('social_account', { provider: 'x', status: 'active', brand_id: 'brand' });
  const { asset, version } = media();
  const validate = async (body: string, mediaRef: Data = { asset_id: asset.id, asset_version_id: version.id }) => {
    const created = await run('content_create_item', { brand_id: 'brand', title: 'Clip', variants: [{ platform: 'x', format: 'short_video', social_account_id: account.id, body, media: [mediaRef] }] }) as { variants: Loose[] };
    const validateOp = operations.find(op => op.name === 'content_validate_variant')!;
    const result = await validateOp.run(ctx, { body: {}, params: { id: created.variants[0].id }, query: {} }) as { issues: { code: string }[] };
    return result.issues.map(issue => issue.code);
  };
  assert.deepEqual((await validate('中'.repeat(140))).filter(code => code === 'max_characters'), []);
  assert.ok((await validate('中'.repeat(141))).includes('max_characters'));
  ctx.create('channel_settings', { social_account_id: account.id, caption_limit: 25_000 });
  assert.ok(!(await validate('中'.repeat(141))).includes('max_characters'), 'X Premium caption_limit applies');
  assert.ok(!(await validate('owned clip')).includes('asset_rights_denied'), 'owned media need no rights grant');
  const branded = media({ brand_id: 'brand', ownership: undefined });
  assert.ok((await validate('brand clip', { asset_id: branded.asset.id, asset_version_id: branded.version.id })).includes('asset_rights_denied'),
    'brand media still need a grant in validation');
  // The Phase 1 scheduling path (create draft, commit, apply defaults) never consults rights: it commits either way.
  const created = await run('content_create_draft', { brand_id: 'brand', title: 'Clip', variants: [{ platform: 'x', format: 'short_video', social_account_id: account.id,
    body: '', media: [{ asset_id: branded.asset.id, asset_version_id: branded.version.id }] }] }) as { revisions: Row[] };
  assert.equal(created.revisions.length, 1);
});
