// Driver interface (§8.6). A driver may click the Post button at most once per
// publish() call, and only after onBeforeClick() resolved true (§5.11 rule 4).
import type { BlockerCode, ClaimedJob, DriverTraceStep, LoginState as HubLoginState } from '../runtime/contracts.ts';
import type { SelectorTable } from './selectors.ts';

export type DriverProvider = 'x' | 'tiktok';

/** Handle to a DOM node, by its CDP backend id. */
export interface NodeRef { backendNodeId: number; name?: string; disabled?: boolean; checked?: boolean | 'mixed'; expanded?: boolean }
export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';
export interface WatchedResponse { url: string; status: number; body: string | null; at: number }
export interface ResponseWatcher {
  responses(): WatchedResponse[];
  /** Resolves with the first response (already seen or future) accepted by `match`, or null on timeout. */
  next(match: (response: WatchedResponse) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<WatchedResponse | null>;
  stop(): void;
}

/** CDP page helper over the Chrome pipe (§8.7). No Playwright, no extra debug port. */
export interface CdpPage {
  goto(url: string, options?: { timeoutMs?: number }): Promise<string>;
  url(): Promise<string>;
  queryRole(role: string, name: RegExp, options?: { within?: NodeRef }): Promise<NodeRef[]>;
  queryCss(selector: string, options?: { within?: NodeRef; visible?: boolean; text?: RegExp }): Promise<NodeRef[]>;
  click(node: NodeRef): Promise<void>;
  /** Same checks as click() without dispatching any input. */
  clickable(node: NodeRef): Promise<boolean>;
  focus(node: NodeRef): Promise<void>;
  insertText(text: string): Promise<void>;
  press(key: string, modifiers?: Modifier[]): Promise<void>;
  typeChars(text: string, perCharDelayMs: number): Promise<void>;
  setFiles(node: NodeRef, paths: string[]): Promise<void>;
  innerText(node: NodeRef): Promise<string>;
  attribute(node: NodeRef, name: string): Promise<string | null>;
  /** Visible text of the whole document (blocker detection). */
  bodyText(): Promise<string>;
  /** `src` attributes of every iframe (captcha detection, §8.10). */
  frameSources(): Promise<string[]>;
  screenshot(options?: { quality?: number; maxWidth?: number }): Promise<Buffer>;
  watchResponses(pattern: RegExp): ResponseWatcher;
  axSnapshotHash(): Promise<string>;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
}

export interface DriverContext {
  page: CdpPage;
  /** Production: https://x.com + path; test mode: the fixture origin (§8.14). */
  platformUrl(path: string): string;
  expectedIdentity: string;
  signal: AbortSignal;
  evidence(label: string): Promise<string>;
  log(step: string, detail?: object): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  selectors: SelectorTable;
  /** Local cache paths of the job's media, in payload order. */
  mediaPaths: string[];
  /** Interval of read-only blocker observation (BLOCKER_POLL_MS unless shortened in test mode). */
  blockerPollMs: number;
  /** Step timings and which selector matched (§8.11 driver_trace). */
  trace: DriverTraceStep[];
  /** Wait for the first page state (30 s in production; tests may shorten it). */
  readyTimeoutMs?: number;
  /** zh-Hant message context (§8.10): machine name, channel label and deadline. */
  messages: { machine: string; channel: string; deadline: string };
}

export type LoginState = Exclude<HubLoginState, 'unknown' | 'checking'>;
export type PrepareResult = { ok: true; identity: string; handle: string | null } | { ok: false; blocker: DriverBlocker };
export interface DriverBlocker {
  code: BlockerCode; phase: 'prepare' | 'before_submit' | 'after_submit'; message: string; step?: string; url?: string; evidence_sha256?: string[];
  /** Diagnostics for driver_outdated (§8.11). */
  ax_hash?: string;
}
/**
 * What publish() learned for read-back. `known_ids` (WA-1, TikTok): the Studio content list's video ids read before the
 * click; none of them can be this post. Absent when that list could not be read.
 */
export interface PublishHint { url?: string; external_post_id?: string; known_ids?: string[] }
/** Read-back input: `submittedAt` is the click time (local `submitting_at`), the lower bound for the post's creation time. */
export type ReadBackHint = PublishHint & { submittedAt: number; captionPrefix: string };
export type PublishOutcome =
  | { kind: 'dry_run_done'; evidence_sha256: string[] }
  | { kind: 'aborted' }
  | { kind: 'submitted'; hint: PublishHint; submitted_by: 'auto' | 'owner'; evidence_sha256: string[] }
  | { kind: 'blocked'; blocker: DriverBlocker }
  | { kind: 'failed'; code: 'upload_rejected' | 'caption_rejected' | 'media_hash_mismatch'; message: string; evidence_sha256: string[] };
export type ReadBackResult =
  | { kind: 'found'; url: string; external_post_id: string; published_at: string | null }
  | { kind: 'not_yet' }
  | { kind: 'blocked'; blocker: DriverBlocker };

export interface PublishOptions {
  dryRun: boolean; mode: 'auto' | 'assist';
  /** Runner checks revocation, writes `submitting` and fsyncs; true means click now. */
  onBeforeClick(): Promise<boolean>;
  /** Polled every 2 s while the owner is expected to click (assist, caption_rejected). */
  revoked(): boolean;
  ownerWaitUntil: number;
  /**
   * Called once when the page is filled and the owner must click Post (assist mode,
   * or caption_rejected handed to the owner). The runner reports blocked{before_submit},
   * releases the machine's publish lock (the profile stays leased and pinned, WA-2)
   * and keeps the observation loop running inside publish() (§8.8 step 7).
   */
  onOwnerWait?(blocker: DriverBlocker): Promise<void>;
}

export interface PublishDriver {
  readonly provider: DriverProvider;
  readonly version: string;
  checkLogin(ctx: DriverContext): Promise<{ state: LoginState; identity: string | null; handle: string | null; evidence_sha256: string[] }>;
  prepare(ctx: DriverContext, job: ClaimedJob): Promise<PrepareResult>;
  publish(ctx: DriverContext, job: ClaimedJob, opts: PublishOptions): Promise<PublishOutcome>;
  readBack(ctx: DriverContext, job: ClaimedJob, hint: ReadBackHint): Promise<ReadBackResult>;
  detectBlocker(ctx: DriverContext, phase?: DriverBlocker['phase']): Promise<DriverBlocker | null>;
  awaitBlockerCleared(ctx: DriverContext, blocker: DriverBlocker, until: number): Promise<boolean>;
  /** Observes the identity on the platform's signed-in home page (add-channel, §8.16). */
  observeIdentity?(ctx: DriverContext): Promise<{ identity: string; handle: string | null; display_name: string | null } | null>;
  /** Read-only identity probe of the page as it is (no navigation), polled while the owner signs in (§8.16 step 4). */
  probeIdentity?(ctx: DriverContext): Promise<{ identity: string; handle: string | null } | null>;
  /** Where enrollment opens the profile: X home, TikTok Studio settings. */
  readonly enrollPath?: string;
}

export class DriverAbort extends Error {
  constructor() { super('Driver aborted'); this.name = 'DriverAbort'; }
}
