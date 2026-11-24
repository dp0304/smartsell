// COH-2 (wave 6): the bundled Skills are installed into the owner's projects (smartsell-install-skills.mjs). A phase-1
// connection (tool profile hub_v1) lists only the 11 hub tools (§7.1, §7.4), so a Skill may name no other tool.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import catalog from './catalog.json' with { type: 'json' };

const HUB_TOOLS = ['smartsell_overview', 'machines_list', 'channels_list', 'channel_check', 'media_upload', 'post_schedule', 'post_update',
  'posts_list', 'post_get', 'task_get', 'publishing_pause'];
/** Output fields the Skills quote that happen to end like a tool name. */
const FIELDS = ['can_schedule'];
/** Tools a phase-1 connection does not list (legacy operations, Worker task tools, the describe/call pair). */
const LEGACY = /\b(smartsell_operations?_\w+|worker_\w+|publishing_(?!pause\b)\w+|posts_(?!list\b)\w+|content_\w+|commerce_\w+|catalog_\w+|account_\w+|desktop_\w+|zhihu_\w+|sync_\w+|data_source_\w+|analytics_\w+|agent_jobs_\w+|workspace_get\w*|import_\w+)\b/;

const skills = await Promise.all(catalog.map(async ({ id }) => ({ id, text: await readFile(new URL(`./${id}/SKILL.md`, import.meta.url), 'utf8') })));

test('every bundled Skill names only the 11 hub tools', () => {
  assert.deepEqual(catalog.map(({ id }) => id), ['smartsell-video-publish', 'smartsell-product-listing', 'smartsell-data-collection']);
  for (const { id, text } of skills) {
    assert.doesNotMatch(text, LEGACY, `${id} names a tool hub_v1 does not list`);
    const named = [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(match => match[1])
      .filter(name => /_(overview|list|check|get|request|call|upload|schedule|update|pause|describe|create)$/.test(name));
    assert.deepEqual(named.filter(name => !HUB_TOOLS.includes(name) && !FIELDS.includes(name)), [], id);
  }
});

test('the posting Skill carries the phase-1 rules: one post_schedule, no invented captions, unknown results are never re-posted', () => {
  const text = skills.find(({ id }) => id === 'smartsell-video-publish')!.text;
  for (const rule of ['`smartsell_overview`', '`media_upload`', '`post_schedule`', 'Never invent a caption', 'POST_RESULT_UNKNOWN', 'click_post', '`published`']) {
    assert.ok(text.includes(rule), rule);
  }
});
