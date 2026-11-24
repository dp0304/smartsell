// X driver (x@2026.11.2, §8.8). Media is attached before text, text is typed
// line by line and read back, the account's "Who can reply" default is set and
// read back (E40), the Post button is clicked at most once and only after
// onBeforeClick() returned true. Blockers stop the flow.
import { existsSync } from 'node:fs';
import type { ClaimedJob, PublishPostPayload, XDefaults } from '../runtime/contracts.ts';
import { NodeNotClickable } from './cdp-page.ts';
import { detectX, observeUntilCleared, toBlocker, type Detection } from './detect.ts';
import { findStep, pathOf, patternOf } from './selectors.ts';
import { checkAbort, enabled, insertLines, normalize, parseJson, pollUntil, READBACK_CLICK_SKEW_MS, record, waitStep } from './steps.ts';
import type { DriverBlocker, DriverContext, LoginState, NodeRef, PrepareResult, PublishDriver, PublishOptions, PublishOutcome, ReadBackHint, ReadBackResult, ResponseWatcher } from './types.ts';

export const X_DRIVER_VERSION = 'x@2026.11.2';
const READY_TIMEOUT_MS = 30_000;
const POST_WAIT_MS = 20_000;
const OWNER_POLL_MS = 2_000;

const canonical = (handle: string, id: string) => `https://x.com/${handle}/status/${id}`;
const payloadOf = (job: ClaimedJob) => job.payload as PublishPostPayload;
const handleOf = (job: ClaimedJob) => (job.payload.channel.handle ?? job.payload.channel.expected_identity).replace(/^@/, '');

type Ready = { ok: true } | { ok: false; blocker: DriverBlocker };
/** CreateTweet answered with errors[] and no rest_id: the click reached X, which refused it (no screenshot yet). */
type Refused = { kind: 'refused'; risky: boolean; message?: string };

export class XDriver implements PublishDriver {
  readonly provider = 'x' as const;
  readonly version = X_DRIVER_VERSION;

  async #goto(ctx: DriverContext, path: string) {
    checkAbort(ctx);
    await ctx.page.goto(ctx.platformUrl(path));
  }

  async #onPath(ctx: DriverContext, path: string) {
    try { return new URL(await ctx.page.url()).pathname.endsWith(path); } catch { return false; }
  }

  /** Step 1: compose dialog, or a blocker. Reloads once; then driver_outdated (§8.8, §8.11). */
  async #compose(ctx: DriverContext, phase: DriverBlocker['phase']): Promise<Ready> {
    const composePath = pathOf(ctx.selectors, 'x', 'compose_path');
    if (!await this.#onPath(ctx, composePath) || !(await findStep(ctx.page, ctx.selectors, 'x', 'x.ready')).length) await this.#goto(ctx, composePath);
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = ctx.now();
      const seen = await pollUntil(ctx, async () => {
        const blocked = await detectX(ctx);
        if (blocked) return { kind: 'blocked', blocked } as const;
        const ready = await findStep(ctx.page, ctx.selectors, 'x', 'x.ready');
        return ready.length ? { kind: 'ready', ready: ready[0] } as const : null;
      }, ctx.readyTimeoutMs ?? READY_TIMEOUT_MS);
      if (seen?.kind === 'blocked') {
        record(ctx, 'x.ready', started, 'none');
        return { ok: false, blocker: await toBlocker(ctx, seen.blocked.code, phase, { url: seen.blocked.url }) };
      }
      if (seen?.kind === 'ready') {
        record(ctx, 'x.ready', started, seen.ready.matched);
        await this.#clearOverlay(ctx, seen.ready.node);
        return { ok: true };
      }
      record(ctx, 'x.ready', started, 'none');
      if (attempt === 0) await this.#goto(ctx, composePath);
    }
    return { ok: false, blocker: await this.#outdated(ctx, 'x.ready', phase) };
  }

  /**
   * Step 2 (§8.8): the Grok side panel or another overlay can cover the compose dialog. Escape once (before any media
   * is attached, so it cannot open the discard sheet of a draft), then confirm x.ready again. Never clicks the overlay.
   */
  async #clearOverlay(ctx: DriverContext, ready: NodeRef) {
    if (await ctx.page.clickable(ready)) return;
    ctx.log('x.overlay', { action: 'escape' });
    await ctx.page.press('Escape');
    const again = await waitStep(ctx, 'x', 'x.ready', 5_000);
    ctx.log('x.overlay', { cleared: !!again.length && await ctx.page.clickable(again[0].node) });
  }

  async #outdated(ctx: DriverContext, step: string, phase: DriverBlocker['phase']) {
    const blocked = await detectX(ctx);
    if (blocked) return toBlocker(ctx, blocked.code, phase, { url: blocked.url });
    return toBlocker(ctx, 'driver_outdated', phase, { step, url: await ctx.page.url().catch(() => undefined), ax_hash: await ctx.page.axSnapshotHash() });
  }

  async #identity(ctx: DriverContext, timeoutMs = 5_000): Promise<string | null> {
    const found = await waitStep(ctx, 'x', 'x.identity', timeoutMs);
    return found[0]?.value?.toLowerCase() ?? null;
  }

  #expected(ctx: DriverContext) { return ctx.expectedIdentity.replace(/^@/, '').toLowerCase(); }

  async checkLogin(ctx: DriverContext): Promise<{ state: LoginState; identity: string | null; handle: string | null; evidence_sha256: string[] }> {
    await this.#goto(ctx, pathOf(ctx.selectors, 'x', 'home_path'));
    const seen = await pollUntil(ctx, async () => {
      const blocked = await detectX(ctx);
      if (blocked) return { kind: 'blocked', blocked } as const;
      const found = await findStep(ctx.page, ctx.selectors, 'x', 'x.identity');
      return found[0]?.value ? { kind: 'identity', identity: found[0].value.toLowerCase() } as const : null;
    }, ctx.readyTimeoutMs ?? READY_TIMEOUT_MS);
    const evidence = [await ctx.evidence('check_login')];
    if (seen?.kind === 'identity') {
      return { state: seen.identity === this.#expected(ctx) ? 'verified' : 'identity_mismatch', identity: seen.identity, handle: seen.identity, evidence_sha256: evidence };
    }
    const code = seen?.kind === 'blocked' ? seen.blocked.code : undefined;
    return { state: code === 'captcha' || code === 'two_factor' || code === 'risk_prompt' ? 'challenge' : 'login_required', identity: null, handle: null, evidence_sha256: evidence };
  }

  readonly enrollPath = '/home';

  async probeIdentity(ctx: DriverContext) {
    const found = await findStep(ctx.page, ctx.selectors, 'x', 'x.identity');
    const identity = found[0]?.value?.toLowerCase();
    return identity ? { identity, handle: identity } : null;
  }

  async observeIdentity(ctx: DriverContext) {
    await this.#goto(ctx, pathOf(ctx.selectors, 'x', 'home_path'));
    const identity = await this.#identity(ctx, ctx.readyTimeoutMs ?? READY_TIMEOUT_MS);
    return identity ? { identity, handle: identity, display_name: null } : null;
  }

  async prepare(ctx: DriverContext, job: ClaimedJob): Promise<PrepareResult> {
    const ready = await this.#compose(ctx, 'prepare');
    if (!ready.ok) return ready;
    const identity = await this.#identity(ctx);
    if (!identity) return { ok: false, blocker: await this.#outdated(ctx, 'x.identity', 'prepare') };
    if (identity !== this.#expected(ctx)) return { ok: false, blocker: await toBlocker(ctx, 'identity_mismatch', 'prepare') };
    if (!ctx.mediaPaths.length || ctx.mediaPaths.some(path => !existsSync(path))) return { ok: false, blocker: await toBlocker(ctx, 'media_unavailable', 'prepare') };
    if (normalize(payloadOf(job).caption.text).length > 25_000) return { ok: false, blocker: await toBlocker(ctx, 'caption_rejected', 'prepare') };
    return { ok: true, identity, handle: identity };
  }

  async detectBlocker(ctx: DriverContext, phase: DriverBlocker['phase'] = 'prepare') {
    const blocked = await detectX(ctx);
    return blocked ? toBlocker(ctx, blocked.code, phase, { url: blocked.url }) : null;
  }

  awaitBlockerCleared(ctx: DriverContext, blocker: DriverBlocker, until: number) {
    return observeUntilCleared(ctx, until, async () => {
      if (blocker.code === 'identity_mismatch') {
        const found = await findStep(ctx.page, ctx.selectors, 'x', 'x.identity');
        return found[0]?.value?.toLowerCase() !== this.#expected(ctx);
      }
      return (await detectX(ctx)) !== null;
    });
  }

  /**
   * Clicks the textbox; if an overlay that appeared after step 2 covers it, Escape once and retry. With media attached,
   * Escape may open X's "Discard post?" sheet instead: then nothing more is pressed or clicked and the step fails.
   */
  async #focusTextbox(ctx: DriverContext) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const box = await waitStep(ctx, 'x', 'x.textbox', 5_000);
      if (!box.length) return null;
      try { await ctx.page.click(box[0].node); return box[0]; }
      catch (error) {
        if (!(error instanceof NodeNotClickable) || attempt) return null;
        await ctx.page.press('Escape');
        if ((await findStep(ctx.page, ctx.selectors, 'x', 'x.discard')).length) return null;
      }
    }
    return null;
  }

  async #readText(ctx: DriverContext) {
    const box = await findStep(ctx.page, ctx.selectors, 'x', 'x.textbox');
    return box.length ? normalize(await ctx.page.innerText(box[0].node)) : null;
  }

  async #postButton(ctx: DriverContext, timeoutMs: number) {
    return (await waitStep(ctx, 'x', 'x.post_button', timeoutMs, { accept: async found => {
      const usable = [];
      for (const item of found) if (await enabled(ctx, item.node)) usable.push(item);
      return usable;
    } }))[0];
  }

  /** x.discard: Escape, then the confirmation sheet's Discard (§8.8). */
  async #discard(ctx: DriverContext) {
    await ctx.page.press('Escape').catch(() => {});
    const confirm = await waitStep(ctx, 'x', 'x.discard', 3_000);
    if (confirm.length) await ctx.page.click(confirm[0].node).catch(() => {});
  }

  async #toastIds(ctx: DriverContext) {
    return (await findStep(ctx.page, ctx.selectors, 'x', 'x.toast')).map(item => item.node.backendNodeId);
  }

  /**
   * Confirmation after a click (auto or owner): a CreateTweet response with a rest_id or a new toast (checked first, so a
   * later success is never hidden behind an earlier refusal, WA-10), then a CreateTweet refusal, then an after-submit blocker.
   */
  async #confirmation(ctx: DriverContext, creates: ResponseWatcher, known: number[], startedAt: number, blockers = true):
    Promise<{ kind: 'posted'; id?: string } | Refused | { kind: 'blocked'; blocker: DriverBlocker } | null> {
    let refused: Refused | null = null;
    for (const response of creates.responses().filter(item => item.at >= startedAt)) {
      const body = parseJson(response.body);
      const errors = Array.isArray(body?.errors) ? body!.errors as { code?: number; message?: string }[] : [];
      const restId = (body?.data as { create_tweet?: { tweet_results?: { result?: { rest_id?: string } } } } | undefined)?.create_tweet?.tweet_results?.result?.rest_id;
      if (restId) return { kind: 'posted', id: restId };
      if (errors.length && !refused) {
        refused = { kind: 'refused', risky: errors.some(error => patternOf(ctx.selectors, 'x', 'risk_codes').test(String(error.code ?? ''))), message: errors[0]?.message };
      }
    }
    const toasts = await findStep(ctx.page, ctx.selectors, 'x', 'x.toast');
    const fresh = toasts.filter(item => !known.includes(item.node.backendNodeId));
    if (fresh.length) {
      const id = fresh.find(item => item.matched === 'primary' && item.value)?.value ?? undefined;
      return { kind: 'posted', ...(id && { id }) };
    }
    if (refused) return refused;
    // A captcha, verification, sign-in wall, risk prompt or error page after the click: stop and hand it to the owner.
    // The post may exist, so the hub treats it as outcome_unknown; the driver never retries and never navigates away.
    // (Not while the owner is the one clicking: that loop only watches for the result, without screenshots.)
    if (!blockers) return null;
    const blocked = await detectX(ctx);
    if (blocked) return { kind: 'blocked', blocker: await toBlocker(ctx, blocked.code, 'after_submit', { url: blocked.url }) };
    return null;
  }

  /** The rest_id of a CreateTweet response seen since `since`, if any. */
  #restId(creates: ResponseWatcher, since: number) {
    for (const response of creates.responses().filter(item => item.at >= since)) {
      const body = parseJson(response.body);
      const restId = (body?.data as { create_tweet?: { tweet_results?: { result?: { rest_id?: string } } } } | undefined)?.create_tweet?.tweet_results?.result?.rest_id;
      if (restId) return restId;
    }
    return null;
  }

  /** A refused CreateTweet as an after-submit blocker (one screenshot): the hub records outcome_unknown, never a retry. */
  #refusedBlocker(ctx: DriverContext, refused: Refused) {
    return toBlocker(ctx, refused.risky ? 'risk_prompt' : 'platform_error', 'after_submit', { platform_message: refused.message });
  }

  /**
   * Owner clicks Post on this machine (assist, or caption handed over). Polls every 2 s (§8.8 step 7), screenshot-free.
   * The caller awaits it inside its try/finally: the response watchers must stay on for the whole wait (WA-10).
   * WA-10: once X answered a CreateTweet, the owner did click. A later success still counts; otherwise the wait ends
   * with an after_submit blocker (outcome unknown, the window is left as it is), never with discard and "not clicked".
   */
  async #ownerWait(ctx: DriverContext, opts: PublishOptions, blocker: DriverBlocker, creates: ResponseWatcher, handle: string): Promise<PublishOutcome> {
    const known = await this.#toastIds(ctx);
    const since = ctx.now();
    await opts.onOwnerWait?.(blocker);
    let clicked: Refused | null = null;
    while (ctx.now() < opts.ownerWaitUntil) {
      checkAbort(ctx);
      const seen = await this.#confirmation(ctx, creates, known, since, false);
      if (seen?.kind === 'posted') {
        const evidence = [await ctx.evidence('after_submit')];
        return { kind: 'submitted', submitted_by: 'owner', evidence_sha256: evidence,
          hint: seen.id ? { external_post_id: seen.id, url: canonical(handle, seen.id) } : {} };
      }
      if (seen?.kind === 'refused') clicked ??= seen;
      if (opts.revoked()) {
        if (clicked) return { kind: 'blocked', blocker: await this.#refusedBlocker(ctx, clicked) };
        await this.#discard(ctx);
        return { kind: 'aborted' };
      }
      try { await ctx.sleep(Math.min(OWNER_POLL_MS, Math.max(1, opts.ownerWaitUntil - ctx.now()))); } catch { break; }
    }
    checkAbort(ctx);
    if (clicked) return { kind: 'blocked', blocker: await this.#refusedBlocker(ctx, clicked) };
    await this.#discard(ctx);
    return { kind: 'blocked', blocker };
  }

  /** The reply control's visible label (or aria name), e.g. "Accounts you follow can reply". */
  async #replyLabel(ctx: DriverContext, node: NodeRef) {
    const text = await ctx.page.innerText(node).catch(() => '');
    const aria = await ctx.page.attribute(node, 'aria-label').catch(() => null);
    return normalize([text, aria ?? '', node.name ?? ''].join(' '));
  }

  /**
   * E40 (x.reply_settings): the account's "Who can reply" default, set in the composer and read back from the control's
   * label. 'everyone' is X's default and is skipped. Returns false when it cannot be set: driver_outdated (before_submit).
   */
  async #replySettings(ctx: DriverContext, want: XDefaults['reply_settings']): Promise<boolean> {
    if (want === 'everyone') return true;
    const state = patternOf(ctx.selectors, 'x', `reply_state_${want}`);
    const option = patternOf(ctx.selectors, 'x', `reply_option_${want}`);
    let control = await waitStep(ctx, 'x', 'x.reply_settings', 3_000);
    // X shows the control under a focused textbox; with no caption nothing has focused it yet.
    if (!control.length && await this.#focusTextbox(ctx)) control = await waitStep(ctx, 'x', 'x.reply_settings', 5_000);
    if (!control.length) return false;
    if (state.test(await this.#replyLabel(ctx, control[0].node))) return true;
    await ctx.page.click(control[0].node);
    const started = ctx.now();
    const item = await pollUntil(ctx, async () => {
      for (const found of await findStep(ctx.page, ctx.selectors, 'x', 'x.reply_menu_item')) {
        if (option.test(normalize(await ctx.page.innerText(found.node).catch(() => '') || found.node.name || ''))) return found;
      }
      return null;
    }, 5_000);
    record(ctx, 'x.reply_menu_item', started, item ? item.matched : 'none');
    if (!item) return false;
    await ctx.page.click(item.node);
    return !!await pollUntil(ctx, async () => {
      const again = await findStep(ctx.page, ctx.selectors, 'x', 'x.reply_settings');
      return again.length && state.test(await this.#replyLabel(ctx, again[0].node)) ? true : null;
    }, 3_000);
  }

  /** Waits for x.upload_done: network processing_info, or the enabled button plus attachment as fallback. */
  async #uploadDone(ctx: DriverContext, uploads: ResponseWatcher, bytes: number):
    Promise<{ ok: true } | { ok: false; message: string } | { ok: 'blocked'; blocked: Detection } | { ok: 'timeout'; processing: boolean }> {
    const timeoutMs = 60_000 + Math.ceil(bytes / (100 * 1024 * 1024)) * 30_000;
    const started = ctx.now();
    let processing = false;
    const result = await pollUntil(ctx, async () => {
      const blocked = await detectX(ctx);
      if (blocked) return { ok: 'blocked' as const, blocked };
      const responses = uploads.responses();
      const latest = [...responses].reverse().find(item => /FINALIZE|STATUS/i.test(item.url) || parseJson(item.body)?.processing_info !== undefined);
      const body = parseJson(latest?.body ?? null);
      if (latest && body) {
        const info = body.processing_info as { state?: string; error?: { message?: string } } | undefined;
        if (info?.state === 'failed') return { ok: false as const, message: info.error?.message ?? 'X 無法處理這支影片' };
        if (!info || info.state === 'succeeded') { record(ctx, 'x.upload_done', started, 'primary'); return { ok: true as const }; }
        processing = true;
        return null;
      }
      // No upload responses visible at all after 10 s: use the button state plus the attachment.
      if (!responses.length && ctx.now() - started > 10_000) {
        const attached = await findStep(ctx.page, ctx.selectors, 'x', 'x.attached');
        const button = await findStep(ctx.page, ctx.selectors, 'x', 'x.post_button');
        if (attached.length && button.length && await enabled(ctx, button[0].node)) { record(ctx, 'x.upload_done', started, 'fallback'); return { ok: true as const }; }
      }
      return null;
    }, timeoutMs);
    if (result?.ok === 'blocked') record(ctx, 'x.upload_done', started, 'none');
    if (result) return result;
    record(ctx, 'x.upload_done', started, 'none');
    return { ok: 'timeout' as const, processing };
  }

  async publish(ctx: DriverContext, job: ClaimedJob, opts: PublishOptions): Promise<PublishOutcome> {
    const payload = payloadOf(job);
    const handle = handleOf(job);
    const ready = await this.#compose(ctx, 'before_submit');
    if (!ready.ok) return { kind: 'blocked', blocker: ready.blocker };
    const identity = await this.#identity(ctx);
    if (identity && identity !== this.#expected(ctx)) return { kind: 'blocked', blocker: await toBlocker(ctx, 'identity_mismatch', 'before_submit') };
    const uploads = ctx.page.watchResponses(patternOf(ctx.selectors, 'x', 'upload_url'));
    const creates = ctx.page.watchResponses(patternOf(ctx.selectors, 'x', 'create_tweet_url'));
    try {
      // Step 3: media first, text after (OpenCLI #1180).
      const input = await waitStep(ctx, 'x', 'x.file_input', 10_000);
      if (!input.length) return { kind: 'blocked', blocker: await this.#outdated(ctx, 'x.file_input', 'before_submit') };
      await ctx.page.setFiles(input[0].node, ctx.mediaPaths);
      const attached = await waitStep(ctx, 'x', 'x.attached', 30_000);
      if (!attached.length) return { kind: 'blocked', blocker: await this.#outdated(ctx, 'x.attached', 'before_submit') };
      const done = await this.#uploadDone(ctx, uploads, payload.media.reduce((sum, item) => sum + item.bytes, 0));
      if (done.ok === 'blocked') return { kind: 'blocked', blocker: await toBlocker(ctx, done.blocked.code, 'before_submit', { url: done.blocked.url }) };
      if (done.ok === 'timeout') {
        // X reported processing but never finished: the platform did not take the video. No signal at all: §8.11 driver_outdated.
        if (done.processing) return { kind: 'failed', code: 'upload_rejected', message: 'X 在時限內沒有完成影片處理。', evidence_sha256: [await ctx.evidence('upload_timeout')] };
        return { kind: 'blocked', blocker: await this.#outdated(ctx, 'x.upload_done', 'before_submit') };
      }
      if (!done.ok) return { kind: 'failed', code: 'upload_rejected', message: done.message, evidence_sha256: [await ctx.evidence('upload_rejected')] };

      // Steps 4–5: type line by line, read back, one documented correction.
      const expected = normalize(payload.caption.text);
      let accepted = true;
      if (expected) {
        const box = await this.#focusTextbox(ctx);
        if (!box) return { kind: 'blocked', blocker: await this.#outdated(ctx, 'x.textbox', 'before_submit') };
        await insertLines(ctx, payload.caption.text);
        if (await this.#readText(ctx) !== expected) {
          await this.#focusTextbox(ctx);
          await ctx.page.press('End');
          await ctx.page.press(' ');
          await ctx.page.press('Backspace');
          accepted = await this.#readText(ctx) === expected;
        }
      }
      // E40: before the owner is handed the page (caption_rejected) and before any click, like every other option.
      if (!await this.#replySettings(ctx, payload.options.x?.reply_settings ?? 'everyone')) {
        return { kind: 'blocked', blocker: await this.#outdated(ctx, 'x.reply_settings', 'before_submit') };
      }
      const button = accepted ? await this.#postButton(ctx, 10_000) : undefined;
      if (!accepted || (expected && !button)) {
        // The page stays filled; the owner checks it and clicks Post (assist).
        const blocker = await toBlocker(ctx, 'caption_rejected', 'before_submit');
        if (opts.dryRun) { await this.#discard(ctx); return { kind: 'blocked', blocker }; }
        return await this.#ownerWait(ctx, opts, blocker, creates, handle);
      }
      if (!button) return { kind: 'blocked', blocker: await this.#outdated(ctx, 'x.post_button', 'before_submit') };

      const before = await ctx.evidence('before_submit');
      if (opts.dryRun) { await this.#discard(ctx); return { kind: 'dry_run_done', evidence_sha256: [before] }; }
      if (opts.mode === 'assist') {
        return await this.#ownerWait(ctx, opts, await toBlocker(ctx, 'owner_click_required', 'before_submit'), creates, handle);
      }

      // Auto: exactly one click, only after the runner confirmed and fsynced `submitting`.
      if (!await ctx.page.clickable(button.node)) return { kind: 'blocked', blocker: await this.#outdated(ctx, 'x.post_button', 'before_submit') };
      const known = await this.#toastIds(ctx);
      if (!await opts.onBeforeClick()) { await this.#discard(ctx); return { kind: 'aborted' }; }
      const clickedAt = ctx.now();
      try { await ctx.page.click(button.node); }
      catch {
        // After onBeforeClick the attempt counts as possibly sent; report it conservatively.
        return { kind: 'blocked', blocker: await toBlocker(ctx, 'platform_error', 'after_submit') };
      }
      const seen = await pollUntil(ctx, () => this.#confirmation(ctx, creates, known, clickedAt), POST_WAIT_MS);
      if (seen?.kind === 'blocked') return seen;
      if (seen?.kind === 'refused') return { kind: 'blocked', blocker: await this.#refusedBlocker(ctx, seen) };
      // A toast without a status link can come before CreateTweet's body is read: give the response a moment, so
      // read-back can open the post by its id instead of searching the profile.
      const id = seen?.id ?? (seen ? await pollUntil(ctx, async () => this.#restId(creates, clickedAt), 3_000) : null) ?? undefined;
      const evidence = [before, await ctx.evidence('after_submit')];
      return { kind: 'submitted', submitted_by: 'auto', evidence_sha256: evidence,
        hint: id ? { external_post_id: id, url: canonical(handle, id) } : {} };
    } finally {
      uploads.stop();
      creates.stop();
    }
  }

  async readBack(ctx: DriverContext, job: ClaimedJob, hint: ReadBackHint): Promise<ReadBackResult> {
    const handle = handleOf(job);
    const prefix = normalize(hint.captionPrefix);
    const textMatches = (text: string) => !prefix || normalize(text).startsWith(prefix);
    if (hint.external_post_id) {
      await this.#goto(ctx, `/${handle}/status/${hint.external_post_id}`);
      const article = await waitStep(ctx, 'x', 'x.tweet', 15_000);
      if (article.length) {
        const author = await findStep(ctx.page, ctx.selectors, 'x', 'x.tweet_author', article[0].node);
        const authorText = author.length ? await ctx.page.innerText(author[0].node) : '';
        const text = await findStep(ctx.page, ctx.selectors, 'x', 'x.tweet_text', article[0].node);
        const body = text.length ? await ctx.page.innerText(text[0].node) : '';
        if (new RegExp(`@${handle}(?![A-Za-z0-9_])`, 'i').test(authorText) && textMatches(body)) {
          const time = await findStep(ctx.page, ctx.selectors, 'x', 'x.tweet_time', article[0].node);
          return { kind: 'found', url: canonical(handle, hint.external_post_id), external_post_id: hint.external_post_id, published_at: time[0]?.value ?? null };
        }
      }
      const blocked = await detectX(ctx);
      if (blocked && blocked.code !== 'platform_error') return { kind: 'blocked', blocker: await toBlocker(ctx, blocked.code, 'after_submit', { url: blocked.url }) };
    }
    // Profile fallback: first non-pinned matching post created after the click (WA-1: minus a small skew) and within 10 minutes.
    await this.#goto(ctx, `/${handle}`);
    const articles = await waitStep(ctx, 'x', 'x.tweet', 15_000);
    for (const article of articles.slice(0, 10)) {
      if ((await findStep(ctx.page, ctx.selectors, 'x', 'x.tweet_pinned', article.node)).length) continue;
      const text = await findStep(ctx.page, ctx.selectors, 'x', 'x.tweet_text', article.node);
      const body = text.length ? await ctx.page.innerText(text[0].node) : '';
      const time = await findStep(ctx.page, ctx.selectors, 'x', 'x.tweet_time', article.node);
      const at = time[0]?.value ? Date.parse(time[0].value) : NaN;
      if (!textMatches(body) || !Number.isFinite(at) || at < hint.submittedAt - READBACK_CLICK_SKEW_MS || at > hint.submittedAt + 600_000) continue;
      const link = await findStep(ctx.page, ctx.selectors, 'x', 'x.tweet_link', article.node);
      const id = link[0]?.value;
      if (id) return { kind: 'found', url: canonical(handle, id), external_post_id: id, published_at: time[0].value };
    }
    const blocked = await detectX(ctx);
    if (blocked && blocked.code !== 'platform_error') return { kind: 'blocked', blocker: await toBlocker(ctx, blocked.code, 'after_submit', { url: blocked.url }) };
    return { kind: 'not_yet' };
  }
}
