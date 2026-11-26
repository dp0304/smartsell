// E2E of own-Chrome mode (core-automation-proposal §8 step 3): the main loop of E2E-1 with each machine posting in the
// owner's own Chrome through the SmartSell extension. MCP → hub → Mac-B (X) and Win-C (TikTok) → fixture platforms →
// URL back; exactly one post per platform, the uploaded bytes intact, both views published and system-verified.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ownChromeUnavailable } from '../connector-desktop/own-chrome-browser.ts';
import { fixturePosts, schedule, waitPostStatus } from './cases.ts';
import { marker, slotAfter, stackUnavailable, startStack, until, type Data, type Stack } from './stack.ts';

describe('E2E own Chrome: the loop through the SmartSell extension', { skip: stackUnavailable ?? ownChromeUnavailable() ?? false, concurrency: false, timeout: 12 * 60_000 }, () => {
  let stack: Stack;
  before(async () => { stack = await startStack({ name: 'own-chrome', ownChrome: true }); });
  after(async () => { await stack?.close(); });

  test('add-channel found each account in the owner\'s Chrome; one post_schedule posts on both machines at T', async () => {
    const overview = await stack.mcp<{ channels: { channel_id: string; provider: string; machine: string; can_schedule: boolean }[] }>('smartsell_overview', {});
    assert.ok(overview.ok);
    for (const provider of ['x', 'tiktok'] as const) {
      const channel = overview.data.channels.find(item => item.channel_id === stack.channels[provider].id);
      assert.ok(channel?.can_schedule, `${provider} can be scheduled: ${JSON.stringify(overview.data.channels)}`);
    }
    const upload = await stack.mcp<Data>('media_upload', { path: stack.video!.path });
    assert.ok(upload.ok, JSON.stringify(upload.error));
    const caption = marker('own Chrome loop');
    const at = slotAfter(90_000);
    const { posts } = await schedule(stack, { providers: ['x', 'tiktok'], at, caption, mediaId: String(upload.data.media_id) });
    await until(() => fixturePosts(stack, 'x', caption).length >= 1 && fixturePosts(stack, 'tiktok', caption).length >= 1, Math.max(0, at - Date.now()) + 90_000,
      'both fixture posts', 500);
    for (const provider of ['x', 'tiktok'] as const) {
      const made = fixturePosts(stack, provider, caption);
      assert.equal(made.length, 1, `${provider}: exactly one post`);
      assert.equal(made[0].media_sha256, stack.video!.sha256, `${provider}: media bytes intact`);
      const view = await waitPostStatus(stack, posts[provider].post_id, ['published'], 90_000);
      assert.equal(view.result?.verification, 'system_verified');
      assert.ok(view.result?.url, `${provider}: URL back at the hub`);
    }
  });
});
