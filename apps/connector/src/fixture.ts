import { createHash } from 'node:crypto';
import { frozenRevisionHash, type ConnectorClaim, type ConnectorTask, type FrozenRevision, type MediaRef, type PublishTask } from '../../../packages/connector-tasks/src/index.ts';
import type { ConsumePermitRequest, SubmitPermitClient, SubmitPermitRequest } from './permit.ts';
import { preflight, type LocalBinding, type LocalPhone, type LocalState } from './preflight.ts';
import type { AssistObservation, EvidenceKind, IdentityObservation, LocalDriver, MediaTask, PostResult } from './workflow.ts';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const mediaBytes = Buffer.from('SmartSell synthetic fixture media');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
type CaptureContext = { captured_at: string; workspace_id: string; connector_device_id: string; account_id: string;
  attempt_id: string; channel: 'browser' | 'mobile'; mobile_device_id?: string; platform_post_id: string };
export type FixtureEvidence = { kind: EvidenceKind; sha256: string; object_id: string; content: Buffer; capture_context: CaptureContext };
const endpoint = (task: ConnectorTask) => task.target.channel === 'browser' ? task.target.profile_id : task.target.mobile_device_id;
const scope = (task: ConnectorTask) => JSON.stringify([task.workspace_id, task.connector_device_id, task.binding_id, task.account_id, task.platform_identity, task.target.channel, endpoint(task), task.target.app]);

export class FixtureDriver implements LocalDriver {
  readonly evidence = new Map<string, FixtureEvidence>();
  readonly media = new Map<string, Buffer>();
  readonly approvals = new Map<string, { workspace_id: string; account_id: string; resource_hash: string }>();
  readonly #posts = new Map<string, { scope: string; post_id: string; visible: boolean }>();
  readonly #staged = new Map<string, { scope: string; hash: string }>();
  readonly #assist = new Map<string, { observation: AssistObservation; expiresAt: number }>();
  readonly #album = new Map<string, Set<string>>();
  readonly #verified = new Set<string>();
  readonly #drafts = new Map<string, string[]>();
  identityObservation: IdentityObservation = { kind: 'signed_in', platform_identity: 'fixture-identity' };
  confirmAlbum = true;
  captureAvailable = true;
  failAfterSubmit = false;
  submissions = 0;
  constructor(readonly localState: LocalState, private readonly now: () => number = Date.now) {}
  state() { return this.localState; }
  identity(task: ConnectorTask): IdentityObservation {
    this.#assertFixture(task);
    return this.identityObservation;
  }
  #assertFixture(task: ConnectorTask) {
    if (![task.workspace_id, task.attempt_id, task.account_id, task.connector_device_id, task.binding_id, task.platform_identity, endpoint(task)]
      .every(id => id.startsWith('fixture-'))) throw new Error('Fixture driver accepts synthetic IDs only');
  }
  approvalValid(task: MediaTask) {
    const approval = this.approvals.get(task.payload.approval.id);
    return !!approval && approval.workspace_id === task.workspace_id && approval.account_id === task.account_id
      && approval.resource_hash === task.payload.frozen_hash;
  }
  mediaAvailable(media: readonly MediaRef[]) {
    return media.every(item => {
      const content = this.media.get(item.id);
      return content && hash(content) === item.sha256;
    });
  }
  #albumKey(task: ConnectorTask, attempt: string) { return JSON.stringify([scope(task), attempt]); }
  #assetKey(item: MediaRef) { return `${item.id}:${item.sha256}`; }
  pushMedia(task: MediaTask) {
    if (!this.confirmAlbum || !this.mediaAvailable(task.payload.revision.media)) return false;
    this.#album.set(this.#albumKey(task, task.attempt_id), new Set(task.payload.revision.media.map(item => this.#assetKey(item))));
    return true;
  }
  registerDrafts(task: PublishTask, ids: string[]) { this.#drafts.set(scope(task), [...ids]); }
  draftMatches(task: PublishTask, id: string) {
    const drafts = this.#drafts.get(scope(task));
    return drafts?.length === 1 && drafts[0] === id;
  }
  stage(task: PublishTask, revision: FrozenRevision) {
    if (revision.media.length && task.target.channel === 'mobile' && !this.#album.has(this.#albumKey(task, task.attempt_id))) throw new Error('Fixture media missing');
    this.#staged.set(task.attempt_id, { scope: scope(task), hash: frozenRevisionHash(revision) });
  }
  openAssist(task: PublishTask, expiresAt: number) {
    this.#assist.set(task.attempt_id, { observation: 'waiting', expiresAt });
  }
  observeAssist(task: PublishTask): AssistObservation { return this.#assist.get(task.attempt_id)?.observation ?? 'closed'; }
  closeAssist(task: PublishTask): AssistObservation {
    const assist = this.#assist.get(task.attempt_id);
    if (!assist) return 'closed';
    if (assist.observation === 'waiting') assist.observation = 'closed';
    return assist.observation;
  }
  simulateHumanClick(task: PublishTask) {
    const assist = this.#assist.get(task.attempt_id);
    if (assist?.observation !== 'waiting') throw new Error('Fixture is not waiting for a local click');
    const now = this.now();
    if (now >= assist.expiresAt || preflight(task, this.localState, now)) throw new Error('Fixture local submit preconditions changed');
    const identity = this.identity(task);
    if (identity.kind !== 'signed_in' || identity.platform_identity !== task.platform_identity || !this.approvalValid(task)
      || (task.payload.revision.draft && !this.draftMatches(task, task.payload.revision.draft.publish_id))) {
      throw new Error('Fixture local submit preconditions changed');
    }
    try {
      this.#submit(task);
      assist.observation = 'submitted';
    } catch {
      assist.observation = 'unknown';
    }
  }
  submitAuto(task: PublishTask) { this.#submit(task); }
  #submit(task: PublishTask) {
    const staged = this.#staged.get(task.attempt_id);
    if (staged?.scope !== scope(task) || staged.hash !== task.payload.frozen_hash || this.#posts.has(task.attempt_id)) throw new Error('Invalid or repeated fixture submit');
    const post_id = `fixture-post-${hash(task.attempt_id).slice(0, 16)}`;
    this.#posts.set(task.attempt_id, { scope: scope(task), post_id, visible: task.payload.revision.visibility === 'public' });
    this.submissions++;
    if (this.failAfterSubmit) throw new Error('Synthetic disconnect after submit');
  }
  capture(task: ConnectorTask, sourceAttempt: string, expectedPost?: string): PostResult | undefined {
    const post = this.#posts.get(sourceAttempt);
    if (!this.captureAvailable || !post || post.scope !== scope(task) || (expectedPost && post.post_id !== expectedPost)) return;
    const context: CaptureContext = {
      captured_at: new Date(this.now()).toISOString(), workspace_id: task.workspace_id, connector_device_id: task.connector_device_id,
      account_id: task.account_id, attempt_id: sourceAttempt, channel: task.target.channel, platform_post_id: post.post_id,
      ...(task.target.channel === 'mobile' && { mobile_device_id: task.target.mobile_device_id }),
    };
    const objects: [EvidenceKind, Buffer][] = [['masked_screenshot', Buffer.from(png)]];
    if (task.target.channel === 'mobile') objects.push(['masked_ui_hierarchy', Buffer.from('<fixture-screen><result status="accepted"/></fixture-screen>')]);
    const evidence = objects.map(([kind, content]) => {
      const sha256 = hash(content);
      const object_id = `fixture-evidence-${hash(`${sourceAttempt}:${kind}:${sha256}`).slice(0, 24)}`;
      if (!this.evidence.has(object_id)) this.evidence.set(object_id, { kind, sha256, object_id, content, capture_context: context });
      return { kind, sha256, object_id };
    });
    return { platform_post_id: post.post_id, result_url: `https://connector-fixture.invalid/${task.target.app}/${post.post_id}`, evidence };
  }
  verify(task: ConnectorTask, sourceAttempt: string, expectedPost: string) {
    const post = this.#posts.get(sourceAttempt);
    if (!post || post.scope !== scope(task) || post.post_id !== expectedPost || !post.visible) return false;
    this.#verified.add(this.#albumKey(task, sourceAttempt));
    return true;
  }
  cleanup(task: Extract<ConnectorTask, { kind: 'mobile.cleanup_media' }>) {
    const { source_attempt_id, platform_post_id, media } = task.payload;
    const albumKey = this.#albumKey(task, source_attempt_id);
    const post = this.#posts.get(source_attempt_id);
    const album = this.#album.get(albumKey);
    const keys = media.map(item => this.#assetKey(item));
    if (!this.#verified.has(albumKey) || !post || post.post_id !== platform_post_id || !album || !keys.every(key => album.has(key))) return false;
    keys.forEach(key => album.delete(key));
    return true;
  }
}

export function createFixture(app: 'browser' | 'android' | 'ios' | 'tiktok', mode: 'assist' | 'auto', now: () => number = Date.now, host: string = process.platform) {
  const selection = app === 'browser' ? 'douyin' : app === 'tiktok' ? 'tiktok' : 'xhs';
  const common = { workspace_id: 'fixture-workspace', connector_device_id: 'fixture-desktop', account_id: 'fixture-account', platform_identity: 'fixture-identity' };
  const binding: LocalBinding = app === 'browser'
    ? { ...common, id: 'fixture-binding', owned: true, verified: true, consent_confirmed: true, channel: 'browser', app: 'douyin', profile_id: 'fixture-browser', dedicated: true }
    : { ...common, id: 'fixture-binding', owned: true, verified: true, consent_confirmed: true, channel: 'mobile', app: selection, mobile_device_id: 'fixture-phone', expected_hardware_id: 'fixture-hardware' };
  const phone: LocalPhone = {
    id: 'fixture-phone', hardware_id: 'fixture-hardware', owner_workspace_id: common.workspace_id, os: app === 'ios' ? 'ios' : 'android',
    major: app === 'ios' ? 18 : 11, transport: 'usb', same_lan_confirmed: false, owned: true, physical: true, emulator: false, cloud: false, modified: false,
    paired: true, authorized: true, online: true, unlocked: true, developer_mode: true, ui_automation: true, compatible_apps: [selection],
    ...(app === 'ios' && { apple: { customer_signed: true, developer_account_confirmed: true, trusted: true, expires_at: new Date(now() + 3600_000).toISOString() } }),
  };
  const state: LocalState = { host, phase: app === 'ios' ? 'P1' : 'P0b', pairing: { device_id: common.connector_device_id, workspace_id: common.workspace_id, owned: true, revoked: false }, bindings: [binding], phones: app === 'browser' ? [] : [phone] };
  const driver = new FixtureDriver(state, now);
  const revision: FrozenRevision = {
    id: 'fixture-revision', title: 'Fixture title', body: 'Synthetic content', tags: ['fixture'], visibility: 'public',
    media: app === 'tiktok' ? [] : [{ id: 'fixture-media', sha256: hash(mediaBytes) }],
    ...(app === 'tiktok' && { draft: { publish_id: 'fixture-draft', allow_comments: false, allow_duet: false, allow_stitch: false, commercial_disclosure: false } }),
  };
  const approval = { id: 'fixture-approval', resource_hash: frozenRevisionHash(revision) };
  const task: PublishTask = {
    ...common, schema_version: 1, binding_id: binding.id, attempt_id: 'fixture-attempt',
    ...(binding.channel === 'browser' ? { kind: 'douyin.video.publish' as const, target: { channel: 'browser' as const, app: binding.app, profile_id: binding.profile_id } }
      : { kind: app === 'tiktok' ? 'tiktok.app.publish' as const : 'xhs.app.publish' as const, target: { channel: 'mobile' as const, app: binding.app, mobile_device_id: binding.mobile_device_id } }),
    payload: { approval, revision, frozen_hash: approval.resource_hash },
  };
  driver.approvals.set(approval.id, { ...common, resource_hash: approval.resource_hash });
  driver.media.set('fixture-media', Buffer.from(mediaBytes));
  if (revision.draft) driver.registerDrafts(task, [revision.draft.publish_id]);
  const claim: ConnectorClaim = { task, effective_mode: mode, lease_expires_at: new Date(now() + 3600_000).toISOString(), fencing_token: 1, write_slot_token: 1 };
  return { driver, claim, task, phone, binding };
}

export class FixturePermitClient implements SubmitPermitClient {
  #issued?: { input: SubmitPermitRequest; id: string; expires: number };
  requestCount = 0;
  consumeCount = 0;
  constructor(private readonly now: () => number = Date.now) {}
  async request(input: SubmitPermitRequest) {
    if (!input.attempt_id.startsWith('fixture-') || this.#issued || this.consumeCount) throw new Error('Invalid fixture permit request');
    const expires = this.now() + 10_000;
    this.#issued = { input: { ...input }, id: 'fixture-permit', expires };
    this.requestCount++;
    return { decision: 'granted' as const, permit_id: this.#issued.id, expires_at: new Date(expires).toISOString() };
  }
  async consume(input: ConsumePermitRequest) {
    const issued = this.#issued;
    if (!issued || issued.id !== input.permit_id || issued.expires <= this.now() || issued.input.attempt_id !== input.attempt_id
      || issued.input.fencing_token !== input.fencing_token || issued.input.write_slot_token !== input.write_slot_token || issued.input.request_hash !== input.request_hash) throw new Error('Invalid fixture permit consumption');
    this.#issued = undefined;
    this.consumeCount++;
    return { decision: 'granted' as const };
  }
}
