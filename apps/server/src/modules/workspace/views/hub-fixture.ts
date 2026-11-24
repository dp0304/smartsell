// Shared world for the phase 1 read-model tests (not a test file itself): Mac-B with X (direct, risk acknowledged) and Win-C
// with TikTok (needs approval, no risk acknowledgement → assist), on top of the job engine's in-memory hub fixture.
import { AUTOMATION_NOTICE_VERSION, type Context, type Data, type Presence, type Row } from '@smartsell/contracts';
import { ensureChannelSettings } from '../../account/channel-settings.js';
import { hubFixture } from '../../worker/fixtures.js';
import { configureViewLinks } from './links.js';

export const NOW = '2026-11-24T12:00:00.000Z';
export const tiktokDefaults = { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: false, allow_stitch: false, commercial_disclosure: 'none', ai_generated: false };

export function viewWorld(now = NOW) {
  configureViewLinks({ publicOrigin: 'https://hub.example.ts.net' });
  const f = hubFixture({ provider: 'x', approval: 'direct', riskAck: true, now });
  const { ctx, run, other } = f;
  ctx.update('connector_device', f.device.id, { client_version: '0.2.0', protocol: 2 });
  ctx.update('connector_device', other.id, { client_version: '0.2.0', protocol: 2 });
  const tiktok = ctx.create('social_account', { provider: 'tiktok', status: 'active', brand_id: 'brand', default_timezone: 'UTC', display_name: 'Lure Lab TT',
    handle: 'lurelab_tt', external_account_id: '7000000002' });
  const binding = ctx.create('account_execution_binding', { social_account_id: tiktok.id, mode: 'connector', connector_channel: 'browser', device_id: other.id, connector_mode: 'assist', paused: false });
  ctx.create('browser_session', { binding_id: binding.id, device_id: other.id, social_account_id: tiktok.id, status: 'verified', checked_at: now });
  const settings = ensureChannelSettings(ctx, tiktok.id);
  ctx.update('channel_settings', settings.id, { approval_mode: 'needs_approval', approval_mode_confirmed_at: now,
    automation_notice_ack: { at: now, via: 'worker_app', by: `device:${other.id}`, version: AUTOMATION_NOTICE_VERSION }, platform_defaults: { tiktok: tiktokDefaults } });
  ctx.update('channel_settings', f.settings().id, { approval_mode_confirmed_at: now });

  /** One content item posted to X and TikTok (§9.2 「video.mp4 → X + TikTok」). Returns both targets, submitted. */
  async function scheduleBoth(at: string, text = 'New lure test') {
    const media = [{ asset_id: f.asset.id, asset_version_id: f.version.id, role: 'primary' }];
    const draft = await run('content_create_draft', { brand_id: 'brand', title: 'video.mp4', variants: [
      { platform: 'x', format: 'short_video', social_account_id: f.account.id, body: text, media },
      { platform: 'tiktok', format: 'short_video', social_account_id: tiktok.id, body: text, media },
    ] }) as { variants: Row[] };
    const { applyChannelDefaults } = await import('../../content/index.js');
    const tt = draft.variants.find(variant => variant.platform === 'tiktok')!;
    await applyChannelDefaults(ctx, tt.id, { tiktok: tiktokDefaults } as never);
    const make = (account: Row, variant: Row) => {
      const target = run('publishing_create_target', { social_account_id: account.id, content_variant_id: variant.id, scheduled_at: at, late_policy: 'skip', grace_minutes: 30 }) as Row;
      run('publishing_request_approval', {}, { id: target.id });
      return ctx.get('publish_target', target.id);
    };
    return { x: make(f.account, draft.variants.find(variant => variant.platform === 'x')!), tiktok: make(tiktok, tt) };
  }
  /** C14: inject in-memory presence for the machines (an empty map means: use the stored rows). */
  const presence = new Map<string, Partial<Presence>>();
  (ctx as Context & { presence?: (id: string) => Presence | undefined }).presence = (id: string) => presence.has(id) ? {
    last_seen_at: ctx.now, last_job_sync_at: null, protocol: 2, client_version: '0.2.0', drivers: [], clock_offset_ms: 0, outbox_depth: 0, posture: null,
    applied_sync_generation: 0, ...presence.get(id) } as Presence : undefined;
  const set = (kind: string, id: string, values: Data) => ctx.update(kind, id, values);
  return { ...f, tiktok, tiktokBinding: binding, scheduleBoth, presence, set };
}
export type ViewWorld = ReturnType<typeof viewWorld>;
