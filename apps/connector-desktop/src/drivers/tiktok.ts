// TikTok Studio driver (tiktok@2026.11.2, §8.9). Popups are dismissed only
// with options that change no account setting; privacy is always set
// explicitly; code 7 / "Something went wrong" after Post is a hard stop: the
// video is uploaded and the owner clicks Post. The driver never retries Post.
import { existsSync } from 'node:fs';
import type { ClaimedJob, PublishPostPayload, TikTokDefaults } from '../runtime/contracts.ts';
import { detectTikTok, observeUntilCleared, toBlocker } from './detect.ts';
import { findEvery, findStep, pathOf, patternOf, type Found } from './selectors.ts';
import { checkAbort, enabled, normalize, parseJson, pollUntil, READBACK_CLICK_SKEW_MS, record, selectAllModifier, waitStep } from './steps.ts';
import { DriverAbort, type DriverBlocker, type DriverContext, type LoginState, type PrepareResult, type PublishDriver, type PublishOptions, type PublishOutcome,
  type PublishHint, type ReadBackHint, type ReadBackResult, type ResponseWatcher } from './types.ts';

export const TIKTOK_DRIVER_VERSION = 'tiktok@2026.11.2';
const READY_TIMEOUT_MS = 30_000;
const POST_WAIT_MS = 60_000;
// How long an error on the page waits for the response watcher to read TikTok's own answer (§8.9).
const PAGE_REFUSAL_WAIT_MS = 2_000;
const OWNER_POLL_MS = 2_000;
const CONTENT_SNAPSHOT_MS = 10_000;
const TIKTOK_ORIGIN = 'https://www.tiktok.com';

/** Used only when a job carries no TikTok options (dry runs): the most private explicit setting. */
const SAFE_DEFAULTS: TikTokDefaults = { privacy_level: 'SELF_ONLY', allow_comment: false, allow_duet: false, allow_stitch: false, commercial_disclosure: 'none', ai_generated: false };

type Ready = { ok: true } | { ok: false; blocker: DriverBlocker };

export class TikTokDriver implements PublishDriver {
  readonly provider = 'tiktok' as const;
  readonly version = TIKTOK_DRIVER_VERSION;

  async #goto(ctx: DriverContext, path: string) {
    checkAbort(ctx);
    await ctx.page.goto(ctx.platformUrl(path));
  }

  async #onPath(ctx: DriverContext, path: string) {
    try { return new URL(await ctx.page.url()).pathname.endsWith(path.split('?')[0]); } catch { return false; }
  }

  async #outdated(ctx: DriverContext, step: string, phase: DriverBlocker['phase']) {
    const blocked = await detectTikTok(ctx);
    if (blocked) return toBlocker(ctx, blocked.code, phase, { url: blocked.url });
    return toBlocker(ctx, 'driver_outdated', phase, { step, url: await ctx.page.url().catch(() => undefined), ax_hash: await ctx.page.axSnapshotHash() });
  }

  /** Reads the numeric User ID on the Studio settings page (same rule as channels.ts), plus the visible @handle. */
  async #identity(ctx: DriverContext, timeoutMs = ctx.readyTimeoutMs ?? READY_TIMEOUT_MS): Promise<{ blocked?: DriverBlocker; id?: string; handle?: string | null }> {
    await this.#goto(ctx, pathOf(ctx.selectors, 'tiktok', 'settings_path'));
    const started = ctx.now();
    const seen = await pollUntil(ctx, async () => {
      const blocked = await detectTikTok(ctx);
      if (blocked) return { kind: 'blocked', blocked } as const;
      const match = patternOf(ctx.selectors, 'tiktok', 'user_id').exec(await ctx.page.bodyText());
      return match ? { kind: 'id', id: match[1] } as const : null;
    }, timeoutMs);
    record(ctx, 'tt.identity', started, seen?.kind === 'id' ? 'primary' : 'none');
    if (!seen) return {};
    if (seen.kind === 'blocked') return { blocked: await toBlocker(ctx, seen.blocked.code, 'prepare', { url: seen.blocked.url }) };
    const handle = (await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.handle'))[0]?.value ?? null;
    return { id: seen.id, handle };
  }

  async checkLogin(ctx: DriverContext): Promise<{ state: LoginState; identity: string | null; handle: string | null; evidence_sha256: string[] }> {
    const seen = await this.#identity(ctx);
    const evidence = [await ctx.evidence('check_login')];
    if (seen.id) return { state: seen.id === ctx.expectedIdentity ? 'verified' : 'identity_mismatch', identity: seen.id, handle: seen.handle ?? null, evidence_sha256: evidence };
    const code = seen.blocked?.code;
    return { state: code === 'captcha' || code === 'two_factor' || code === 'risk_prompt' ? 'challenge' : 'login_required', identity: null, handle: null, evidence_sha256: evidence };
  }

  readonly enrollPath = '/tiktokstudio/settings';

  async probeIdentity(ctx: DriverContext) {
    const match = patternOf(ctx.selectors, 'tiktok', 'user_id').exec(await ctx.page.bodyText());
    if (!match) return null;
    const handle = (await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.handle'))[0]?.value ?? null;
    return { identity: match[1], handle };
  }

  async observeIdentity(ctx: DriverContext) {
    const seen = await this.#identity(ctx);
    return seen.id ? { identity: seen.id, handle: seen.handle ?? null, display_name: null } : null;
  }

  /** Dismisses known first-run dialogs with non-committal buttons only (Cancel / Got it / Not now). */
  async #popups(ctx: DriverContext) {
    for (let round = 0; round < 5; round++) {
      const buttons = await findEvery(ctx.page, ctx.selectors, 'tiktok', 'tt.popup_buttons');
      if (!buttons.length) return;
      // Stacked dialogs: only the top one is clickable; click() refuses covered buttons, so retry next round.
      for (const button of buttons) await ctx.page.click(button.node).catch(() => {});
      await ctx.sleep(300);
    }
  }

  async #upload(ctx: DriverContext, phase: DriverBlocker['phase']): Promise<Ready> {
    const path = pathOf(ctx.selectors, 'tiktok', 'upload_path');
    if (!await this.#onPath(ctx, path)) await this.#goto(ctx, path);
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = ctx.now();
      const seen = await pollUntil(ctx, async () => {
        const blocked = await detectTikTok(ctx);
        if (blocked) return { kind: 'blocked', blocked } as const;
        await this.#popups(ctx);
        const ready = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.ready');
        if (ready.length) return { kind: 'ready', ready: ready[0] } as const;
        return (await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.legacy_frame')).length ? { kind: 'legacy' } as const : null;
      }, ctx.readyTimeoutMs ?? READY_TIMEOUT_MS);
      if (seen?.kind === 'blocked') { record(ctx, 'tt.ready', started, 'none'); return { ok: false, blocker: await toBlocker(ctx, seen.blocked.code, phase, { url: seen.blocked.url }) }; }
      if (seen?.kind === 'legacy') {
        // The older layout loads the form inside iframe[data-tt="Upload_index_iframe"] (§8.9 tt.ready fallback). The rest of
        // the form (upload state, caption, privacy, Post) cannot be read or set inside that frame, so stop before any video is
        // uploaded there: driver_outdated, nothing posted, and the trace shows the fallback layout for calibration.
        record(ctx, 'tt.ready', started, 'fallback');
        ctx.log('tt.ready', { layout: 'legacy_iframe' });
        return { ok: false, blocker: await this.#outdated(ctx, 'tt.ready', phase) };
      }
      if (seen?.kind === 'ready') { record(ctx, 'tt.ready', started, seen.ready.matched); return { ok: true }; }
      record(ctx, 'tt.ready', started, 'none');
      if (attempt === 0) await this.#goto(ctx, path);
    }
    // The upload area never appeared: TikTok shows this when logged out (§8.10).
    return { ok: false, blocker: await this.#outdated(ctx, 'tt.ready', phase) };
  }

  async prepare(ctx: DriverContext, job: ClaimedJob): Promise<PrepareResult> {
    const seen = await this.#identity(ctx);
    if (seen.blocked) return { ok: false, blocker: seen.blocked };
    if (!seen.id) return { ok: false, blocker: await this.#outdated(ctx, 'tt.identity', 'prepare') };
    if (seen.id !== ctx.expectedIdentity) return { ok: false, blocker: await toBlocker(ctx, 'identity_mismatch', 'prepare') };
    const ready = await this.#upload(ctx, 'prepare');
    if (!ready.ok) return ready;
    if (!ctx.mediaPaths.length || ctx.mediaPaths.some(path => !existsSync(path))) return { ok: false, blocker: await toBlocker(ctx, 'media_unavailable', 'prepare') };
    if ((job.payload as PublishPostPayload).caption.text.length > 2200) return { ok: false, blocker: await toBlocker(ctx, 'caption_rejected', 'prepare') };
    return { ok: true, identity: seen.id, handle: seen.handle ?? null };
  }

  async detectBlocker(ctx: DriverContext, phase: DriverBlocker['phase'] = 'prepare') {
    const blocked = await detectTikTok(ctx);
    return blocked ? toBlocker(ctx, blocked.code, phase, { url: blocked.url }) : null;
  }

  awaitBlockerCleared(ctx: DriverContext, blocker: DriverBlocker, until: number) {
    return observeUntilCleared(ctx, until, async () => {
      if (blocker.code === 'identity_mismatch') {
        const match = patternOf(ctx.selectors, 'tiktok', 'user_id').exec(await ctx.page.bodyText());
        return match?.[1] !== ctx.expectedIdentity;
      }
      return (await detectTikTok(ctx)) !== null;
    });
  }

  async #discard(ctx: DriverContext) {
    const discard = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.discard');
    if (!discard.length) return;
    await ctx.page.click(discard[0].node).catch(() => {});
    const confirm = await waitStep(ctx, 'tiktok', 'tt.discard_confirm', 3_000);
    if (confirm.length) await ctx.page.click(confirm[0].node).catch(() => {});
  }

  /** Caption: clear the prefilled file name, insert body text, type hashtags slowly and pick the suggestion (§8.9 step 4). */
  async #caption(ctx: DriverContext, text: string): Promise<boolean> {
    const box = await waitStep(ctx, 'tiktok', 'tt.caption', 10_000);
    if (!box.length) return false;
    await ctx.page.click(box[0].node);
    await ctx.page.press('a', [selectAllModifier()]);
    await ctx.page.press('Backspace');
    const cleared = await pollUntil(ctx, async () => normalize(await ctx.page.innerText(box[0].node)) === '' ? true : null, 3_000);
    if (!cleared) return false;
    await ctx.sleep(600);
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (index > 0) await ctx.page.press('Enter');
      let skipSpace = false;
      for (const part of lines[index].split(/(#[\p{L}\p{N}_]+)/u)) {
        if (!part) continue;
        if (part.startsWith('#') && /^#[\p{L}\p{N}_]+$/u.test(part)) {
          await ctx.page.typeChars(part, 60);
          await waitStep(ctx, 'tiktok', 'tt.mention_popover', 1_500);
          await ctx.page.press(' ');
          skipSpace = true;
          continue;
        }
        const plain = skipSpace && part.startsWith(' ') ? part.slice(1) : part;
        skipSpace = false;
        if (plain) await ctx.page.insertText(plain);
      }
    }
    const current = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.caption');
    return !!current.length && normalize(await ctx.page.innerText(current[0].node)) === normalize(text);
  }

  async #checked(ctx: DriverContext, item: Found) {
    const own = await ctx.page.attribute(item.node, 'aria-checked');
    if (own !== null) return own === 'true';
    if (item.node.checked !== undefined) return item.node.checked === true;
    const inputs = await ctx.page.queryCss('input[type="checkbox"]', { within: item.node, visible: false });
    if (inputs.length) return (await ctx.page.attribute(inputs[0], 'aria-checked')) === 'true' || (await ctx.page.attribute(inputs[0], 'checked')) !== null;
    return false;
  }

  /** Sets a checkbox or switch and reads it back. Returns 'disabled' when the platform disabled the control. */
  async #setToggle(ctx: DriverContext, step: string, want: boolean): Promise<'ok' | 'missing' | 'disabled' | 'mismatch'> {
    const started = ctx.now();
    const found = await findStep(ctx.page, ctx.selectors, 'tiktok', step);
    record(ctx, step, started, found[0]?.matched ?? 'none');
    if (!found.length) return 'missing';
    if ((await ctx.page.attribute(found[0].node, 'aria-disabled')) === 'true') return 'disabled';
    if (await this.#checked(ctx, found[0]) !== want) await ctx.page.click(found[0].node);
    const after = await pollUntil(ctx, async () => {
      const again = await findStep(ctx.page, ctx.selectors, 'tiktok', step);
      return again.length && await this.#checked(ctx, again[0]) === want ? true : null;
    }, 3_000);
    return after ? 'ok' : 'mismatch';
  }

  async #visibility(ctx: DriverContext, privacy: TikTokDefaults['privacy_level']): Promise<boolean> {
    const combo = await waitStep(ctx, 'tiktok', 'tt.visibility', 10_000);
    if (!combo.length) return false;
    const option = patternOf(ctx.selectors, 'tiktok', `privacy_${privacy}`);
    if (option.test(normalize(await ctx.page.innerText(combo[0].node)))) return true;
    await ctx.page.click(combo[0].node);
    const choice = await pollUntil(ctx, async () => (await ctx.page.queryRole('option', option))[0] ?? null, 5_000);
    if (!choice) return false;
    await ctx.page.click(choice);
    return !!await pollUntil(ctx, async () => {
      const again = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.visibility');
      return again.length && option.test(normalize(await ctx.page.innerText(again[0].node))) ? true : null;
    }, 3_000);
  }

  async #options(ctx: DriverContext, options: TikTokDefaults, durationMs: number | null): Promise<DriverBlocker | null> {
    if (!await this.#visibility(ctx, options.privacy_level)) return this.#outdated(ctx, 'tt.visibility', 'before_submit');
    const comment = await this.#setToggle(ctx, 'tt.allow_comment', options.allow_comment);
    if (comment !== 'ok' && comment !== 'disabled') return this.#outdated(ctx, 'tt.allow_comment', 'before_submit');
    const reuse = await this.#setToggle(ctx, 'tt.allow_reuse', options.allow_duet && options.allow_stitch);
    // Over 60 s TikTok disables "Reuse of content"; that is expected and only logged.
    if (reuse === 'disabled' || (reuse !== 'ok' && (durationMs ?? 0) > 60_000)) ctx.log('tt.allow_reuse', { skipped: true, reason: reuse });
    else if (reuse !== 'ok') return this.#outdated(ctx, 'tt.allow_reuse', 'before_submit');
    if (options.commercial_disclosure !== 'none' || options.ai_generated) {
      const more = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.show_more');
      if (more.length) await ctx.page.click(more[0].node).catch(() => {});
    }
    if (options.commercial_disclosure !== 'none') {
      if (await this.#setToggle(ctx, 'tt.disclosure', true) !== 'ok') return this.#outdated(ctx, 'tt.disclosure', 'before_submit');
      const brand = ['your_brand', 'both'].includes(options.commercial_disclosure);
      const branded = ['branded_content', 'both'].includes(options.commercial_disclosure);
      if (await this.#setToggle(ctx, 'tt.disclosure_your_brand', brand) !== 'ok') return this.#outdated(ctx, 'tt.disclosure', 'before_submit');
      if (await this.#setToggle(ctx, 'tt.disclosure_branded', branded) !== 'ok') return this.#outdated(ctx, 'tt.disclosure', 'before_submit');
    }
    if (options.ai_generated) {
      const ai = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.ai_label');
      if (!ai.length) return this.#outdated(ctx, 'tt.ai_label', 'before_submit');
      if (!await this.#checked(ctx, ai[0])) {
        await ctx.page.click(ai[0].node);
        const confirm = await waitStep(ctx, 'tiktok', 'tt.ai_confirm', 3_000);
        if (confirm.length) await ctx.page.click(confirm[0].node);
      }
      const on = await pollUntil(ctx, async () => {
        const again = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.ai_label');
        return again.length && await this.#checked(ctx, again[0]) ? true : null;
      }, 3_000);
      if (!on) return this.#outdated(ctx, 'tt.ai_label', 'before_submit');
    }
    return null;
  }

  async #successSeen(ctx: DriverContext, posts: ResponseWatcher, since: number, blockers = true): Promise<{ kind: 'posted' } | { kind: 'blocked'; blocker: DriverBlocker } | null> {
    for (const response of posts.responses().filter(item => item.at >= since)) {
      const body = parseJson(response.body);
      const status = body?.status_code ?? body?.code;
      if (status === 0) return { kind: 'posted' };
      if (body && blockers) {
        const message = String(body.status_msg ?? body.message ?? '');
        const restricted = status === 3013046 || patternOf(ctx.selectors, 'tiktok', 'restricted_text').test(message);
        return { kind: 'blocked', blocker: await this.#postFailed(ctx, restricted ? 'risk_prompt' : 'platform_error', message || `code ${String(status)}`) };
      }
    }
    if (await this.#onPath(ctx, pathOf(ctx.selectors, 'tiktok', 'success_url'))) return { kind: 'posted' };
    const text = await ctx.page.bodyText();
    if (patternOf(ctx.selectors, 'tiktok', 'success_text').test(text)) return { kind: 'posted' };
    // While the owner is the one clicking, only the result is watched (no blocker screenshots every poll).
    if (!blockers) return null;
    if (patternOf(ctx.selectors, 'tiktok', 'restricted_text').test(text)) return { kind: 'blocked', blocker: await toBlocker(ctx, 'risk_prompt', 'after_submit') };
    if (patternOf(ctx.selectors, 'tiktok', 'error_text').test(text) || patternOf(ctx.selectors, 'tiktok', 'risk_text').test(text)) {
      return { kind: 'blocked', blocker: await this.#pageRefusal(ctx, posts, since) };
    }
    // A captcha, verification or sign-in after the click: stop and hand it to the owner (no navigation, no retry).
    const blocked = await detectTikTok(ctx);
    // detectTikTok reads the page again: an error that appeared after `text` was read is the same post failure.
    if (blocked?.code === 'platform_error') return { kind: 'blocked', blocker: await this.#pageRefusal(ctx, posts, since) };
    if (blocked) return { kind: 'blocked', blocker: await toBlocker(ctx, blocked.code, 'after_submit', { url: blocked.url }) };
    return null;
  }

  /**
   * The page shows TikTok's error as soon as its own request resolves; the response watcher reads that answer's body a
   * moment later (under load, after the page). Wait briefly for it so the owner sees TikTok's own message.
   */
  async #pageRefusal(ctx: DriverContext, posts: ResponseWatcher, since: number) {
    const refused = await pollUntil(ctx, async () => this.#refusedPost(ctx, posts, since), PAGE_REFUSAL_WAIT_MS);
    return this.#postFailed(ctx, refused?.restricted ? 'risk_prompt' : 'platform_error', refused?.message ?? null);
  }

  /**
   * §8.9: "Something went wrong", `{code: 7, Permission Denied}` or a non-zero status_code after Post. The video is uploaded
   * but not published; the driver never retries. The owner clicks Post in this window (kept open) or confirms nothing went out.
   */
  async #postFailed(ctx: DriverContext, code: 'platform_error' | 'risk_prompt', platformMessage: string | null) {
    const blocker = await toBlocker(ctx, code, 'after_submit', { ...(platformMessage && { platform_message: platformMessage }) });
    if (code !== 'platform_error') return blocker;
    const { machine, channel } = ctx.messages;
    return { ...blocker, message: `${channel} 在按下發布後回報錯誤${platformMessage ? `（${platformMessage}）` : ''}。影片已上傳，但可能沒有發布：請到 ${machine} 的 TikTok Studio 視窗自己按「發布」，或確認沒有發出；系統不會自動重發。` };
  }

  /** WA-10: a project/post answer that is not a success, seen since `since`: the click reached TikTok, which refused it. */
  #refusedPost(ctx: DriverContext, posts: ResponseWatcher, since: number) {
    for (const response of posts.responses().filter(item => item.at >= since)) {
      const body = parseJson(response.body);
      if (!body) continue;
      const status = body.status_code ?? body.code;
      if (status === 0) continue;
      const message = String(body.status_msg ?? body.message ?? '');
      return { restricted: status === 3013046 || patternOf(ctx.selectors, 'tiktok', 'restricted_text').test(message), message: message || `code ${String(status)}` };
    }
    return null;
  }

  /**
   * The owner clicks Post on this machine (assist, or a caption handed over); polled every 2 s without screenshots.
   * WA-10: once TikTok answered a project/post request the owner did click. A later success still counts; otherwise the
   * wait ends with an after_submit blocker (outcome unknown; the uploaded video stays in this window), never with
   * discard and "not clicked".
   */
  async #ownerWait(ctx: DriverContext, opts: PublishOptions, blocker: DriverBlocker, posts: ResponseWatcher, hint: PublishHint = {}): Promise<PublishOutcome> {
    const since = ctx.now();
    await opts.onOwnerWait?.(blocker);
    let clicked: { restricted: boolean; message: string } | null = null;
    const refused = async (seen: { restricted: boolean; message: string }) =>
      ({ kind: 'blocked' as const, blocker: await this.#postFailed(ctx, seen.restricted ? 'risk_prompt' : 'platform_error', seen.message) });
    while (ctx.now() < opts.ownerWaitUntil) {
      checkAbort(ctx);
      const seen = await this.#successSeen(ctx, posts, since, false);
      if (seen?.kind === 'posted') return { kind: 'submitted', submitted_by: 'owner', hint, evidence_sha256: [await ctx.evidence('after_submit')] };
      clicked ??= this.#refusedPost(ctx, posts, since);
      if (opts.revoked()) {
        if (clicked) return refused(clicked);
        await this.#discard(ctx);
        return { kind: 'aborted' };
      }
      try { await ctx.sleep(Math.min(OWNER_POLL_MS, Math.max(1, opts.ownerWaitUntil - ctx.now()))); } catch { break; }
    }
    checkAbort(ctx);
    clicked ??= this.#refusedPost(ctx, posts, since);
    if (clicked) return refused(clicked);
    await this.#discard(ctx);
    return { kind: 'blocked', blocker };
  }

  /**
   * WA-1: the video ids in the Studio content list before this post exists (read before the upload, so before any Post
   * click). Read-back never takes one of them for this post. undefined when the list could not be read: read-back then
   * accepts only a row whose time is readable and after the click, with a matching caption.
   */
  async #contentIds(ctx: DriverContext): Promise<string[] | undefined> {
    try { await this.#goto(ctx, pathOf(ctx.selectors, 'tiktok', 'content_path')); }
    catch (error) {
      if (error instanceof DriverAbort) throw error;
      ctx.log('tt.content_snapshot', { error: String(error) });
      return undefined;
    }
    const started = ctx.now();
    let count = -1;
    const seen = await pollUntil(ctx, async () => {
      const rows = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.content_row');
      if (rows.length) {
        // The list renders progressively: take it once two reads agree.
        if (rows.length !== count) { count = rows.length; return null; }
        return { rows };
      }
      return (await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.content_empty')).length ? { rows: [] as Found[] } : null;
    }, CONTENT_SNAPSHOT_MS, 500);
    record(ctx, 'tt.content_snapshot', started, seen ? 'primary' : 'none');
    if (!seen) return undefined;
    const ids: string[] = [];
    for (const row of seen.rows) {
      const id = (await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.row_link', row.node))[0]?.value;
      if (id) ids.push(id);
    }
    return ids;
  }

  async publish(ctx: DriverContext, job: ClaimedJob, opts: PublishOptions): Promise<PublishOutcome> {
    const payload = job.payload as PublishPostPayload;
    // WA-1: what the content list already shows, before this video exists (no read-back after a dry run).
    const knownIds = opts.dryRun ? undefined : await this.#contentIds(ctx);
    const hint: PublishHint = knownIds ? { known_ids: knownIds } : {};
    const ready = await this.#upload(ctx, 'before_submit');
    if (!ready.ok) return { kind: 'blocked', blocker: ready.blocker };
    const posts = ctx.page.watchResponses(patternOf(ctx.selectors, 'tiktok', 'post_api'));
    try {
      const input = await waitStep(ctx, 'tiktok', 'tt.file_input', 10_000);
      if (!input.length) return { kind: 'blocked', blocker: await this.#outdated(ctx, 'tt.file_input', 'before_submit') };
      await ctx.page.setFiles(input[0].node, ctx.mediaPaths.slice(0, 1));
      const bytes = payload.media[0]?.bytes ?? 0;
      const started = ctx.now();
      const uploaded = await pollUntil(ctx, async () => {
        if ((await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.upload_error')).length) return { kind: 'error' } as const;
        const blocked = await detectTikTok(ctx);
        if (blocked) return { kind: 'blocked', blocked } as const;
        const done = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.uploaded');
        return done.length ? { kind: 'done', done: done[0] } as const : null;
      }, 120_000 + Math.ceil(bytes / (100 * 1024 * 1024)) * 60_000);
      record(ctx, 'tt.uploaded', started, uploaded?.kind === 'done' ? uploaded.done.matched : 'none');
      // Neither "Uploaded" nor an upload error within the time limit, and no blocker: §8.11 driver_outdated (owner can resume).
      if (!uploaded) return { kind: 'blocked', blocker: await this.#outdated(ctx, 'tt.uploaded', 'before_submit') };
      if (uploaded.kind === 'blocked') return { kind: 'blocked', blocker: await toBlocker(ctx, uploaded.blocked.code, 'before_submit', { url: uploaded.blocked.url }) };
      if (uploaded.kind === 'error') return { kind: 'failed', code: 'upload_rejected', message: 'TikTok 顯示上傳失敗。', evidence_sha256: [await ctx.evidence('upload_rejected')] };
      await this.#popups(ctx);

      const captionOk = await this.#caption(ctx, payload.caption.text);
      // WA-5: privacy, comments, reuse, disclosure and the AI label are set and read back before anything is handed to the
      // owner, so a rejected caption never leaves TikTok's carried-over privacy on the page the owner is asked to post.
      const options = payload.options.tiktok ?? SAFE_DEFAULTS;
      if (!payload.options.tiktok) ctx.log('tt.options', { defaulted: 'SELF_ONLY' });
      const optionBlocker = await this.#options(ctx, options, payload.media[0]?.duration_ms ?? null);
      if (optionBlocker) return { kind: 'blocked', blocker: optionBlocker };
      if (!captionOk) {
        const blocker = await toBlocker(ctx, 'caption_rejected', 'before_submit');
        if (opts.dryRun) { await this.#discard(ctx); return { kind: 'blocked', blocker }; }
        return await this.#ownerWait(ctx, opts, blocker, posts, hint);
      }

      const button = (await waitStep(ctx, 'tiktok', 'tt.post_button', 15_000, { accept: async found => {
        const usable = [];
        for (const item of found) if (await enabled(ctx, item.node)) usable.push(item);
        return usable;
      } }))[0];
      if (!button) return { kind: 'blocked', blocker: await this.#outdated(ctx, 'tt.post_button', 'before_submit') };
      const before = await ctx.evidence('before_submit');
      if (opts.dryRun) { await this.#discard(ctx); return { kind: 'dry_run_done', evidence_sha256: [before] }; }
      if (opts.mode === 'assist') return await this.#ownerWait(ctx, opts, await toBlocker(ctx, 'owner_click_required', 'before_submit'), posts, hint);

      if (!await ctx.page.clickable(button.node)) return { kind: 'blocked', blocker: await this.#outdated(ctx, 'tt.post_button', 'before_submit') };
      if (!await opts.onBeforeClick()) { await this.#discard(ctx); return { kind: 'aborted' }; }
      const clickedAt = ctx.now();
      try { await ctx.page.click(button.node); }
      catch { return { kind: 'blocked', blocker: await toBlocker(ctx, 'platform_error', 'after_submit') }; }
      let confirmed = false;
      const seen = await pollUntil(ctx, async () => {
        // "Continue to post?" confirms the same publish; Post now is not a second Post click (§8.9).
        if (!confirmed) {
          const dialog = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.continue_dialog');
          if (dialog.length) {
            const now = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.post_now');
            if (now.length) { confirmed = true; await ctx.page.click(now[0].node).catch(() => {}); }
          }
        }
        return this.#successSeen(ctx, posts, clickedAt);
      }, POST_WAIT_MS);
      if (seen?.kind === 'blocked') return seen;
      return { kind: 'submitted', submitted_by: 'auto', hint, evidence_sha256: [before, await ctx.evidence('after_submit')] };
    } finally { posts.stop(); }
  }

  /**
   * §8.9 read-back, WA-1: a row is this post only if it was not in the content list before the click (hint.known_ids),
   * its time, when readable, is not before the click (minus a small skew), and its caption starts as expected. Without
   * the pre-click list, or below a row that existed before the click, only a readable time after the click counts; an
   * empty caption never matches on text alone. Anything else: not_yet, never an older video.
   */
  async readBack(ctx: DriverContext, _job: ClaimedJob, hint: ReadBackHint): Promise<ReadBackResult> {
    await this.#goto(ctx, pathOf(ctx.selectors, 'tiktok', 'content_path'));
    const prefix = normalize(hint.captionPrefix);
    const known = hint.known_ids;
    const rows = await waitStep(ctx, 'tiktok', 'tt.content_row', 15_000);
    let belowKnown = false;
    for (const row of rows.slice(0, 10)) {
      const link = await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.row_link', row.node);
      const id = link[0]?.value;
      if (!id) continue;
      if (known?.includes(id)) { belowKnown = true; continue; }
      const time = (await findStep(ctx.page, ctx.selectors, 'tiktok', 'tt.row_time', row.node))[0]?.value;
      const at = time ? Date.parse(time) : NaN;
      const timed = Number.isFinite(at);
      if (timed && at < hint.submittedAt - READBACK_CLICK_SKEW_MS) continue;
      if ((!known || belowKnown) && !timed) continue;
      const text = normalize(await ctx.page.innerText(row.node));
      if (prefix ? !text.includes(prefix) : !known) continue;
      const href = await ctx.page.attribute(link[0].node, 'href') ?? '';
      // The row's own link is authoritative; relative links are completed with the public origin.
      const url = /^https?:\/\//.test(href) ? href.replace(/^https?:\/\/[^/]+/, TIKTOK_ORIGIN) : `${TIKTOK_ORIGIN}${href.startsWith('/') ? '' : '/'}${href}`;
      return { kind: 'found', url, external_post_id: id, published_at: timed ? new Date(at).toISOString() : null };
    }
    const blocked = await detectTikTok(ctx);
    if (blocked && blocked.code !== 'platform_error') return { kind: 'blocked', blocker: await toBlocker(ctx, blocked.code, 'after_submit', { url: blocked.url }) };
    return { kind: 'not_yet' };
  }
}
