// WA-4 (§8.13): evidence screenshots stay at most 1600 image pixels wide on a Retina (2×) screen, and a capture over the
// hub's size budget is taken again smaller, so the outbox never meets a screenshot the hub cannot store.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CdpEvent, CdpPipe } from '../../apps/connector-desktop/src/chrome.ts';
import { ChromeCdpPage, SCREENSHOT_BUDGET_BYTES } from '../../apps/connector-desktop/src/drivers/cdp-page.ts';

function fakePipe(options: { ratio: number; sizes: number[] }) {
  const captures: { quality: number; scale: number }[] = [];
  const pipe: CdpPipe = {
    closed: false,
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const reply = (value: unknown) => value as T;
      switch (method) {
        case 'Target.createTarget': return reply({ targetId: 'target-1' });
        case 'Target.attachToTarget': return reply({ sessionId: 'session-1' });
        case 'Page.getLayoutMetrics': return reply({ cssLayoutViewport: { clientWidth: 1600, clientHeight: 1000 } });
        case 'Page.getFrameTree': return reply({ frameTree: { frame: { id: 'frame-1', url: 'http://127.0.0.1/x', loaderId: 'loader-1' } } });
        case 'Page.createIsolatedWorld': return reply({ executionContextId: 7 });
        case 'Runtime.evaluate': return reply(params.expression === 'window.devicePixelRatio' ? { result: { value: options.ratio } } : { result: {} });
        case 'Page.captureScreenshot': {
          const clip = params.clip as { scale: number };
          captures.push({ quality: Number(params.quality), scale: clip.scale });
          const size = options.sizes[Math.min(captures.length - 1, options.sizes.length - 1)];
          return reply({ data: Buffer.alloc(size, 1).toString('base64') });
        }
        default: return reply({});
      }
    },
    onEvent(_listener: (event: CdpEvent) => void) { return () => {}; },
  };
  return { pipe, captures };
}

test('WA-4: on a 2× screen the capture scale is divided by devicePixelRatio (1600 image pixels, not 3200)', async () => {
  const { pipe, captures } = fakePipe({ ratio: 2, sizes: [200_000] });
  const page = await ChromeCdpPage.open(pipe, { allowUrl: () => true, sleep: async () => {} });
  const shot = await page.screenshot({ quality: 70, maxWidth: 1600 });
  assert.equal(shot.length, 200_000);
  assert.deepEqual(captures, [{ quality: 70, scale: 0.5 }]);
});

test('WA-4: a capture above the size budget is taken again smaller until it fits', async () => {
  const { pipe, captures } = fakePipe({ ratio: 1, sizes: [SCREENSHOT_BUDGET_BYTES + 10, SCREENSHOT_BUDGET_BYTES - 10] });
  const page = await ChromeCdpPage.open(pipe, { allowUrl: () => true, sleep: async () => {} });
  const shot = await page.screenshot({ quality: 70, maxWidth: 1600 });
  assert.ok(shot.length <= SCREENSHOT_BUDGET_BYTES);
  assert.equal(captures.length, 2);
  assert.ok(captures[1].quality < captures[0].quality && captures[1].scale < captures[0].scale);
});
