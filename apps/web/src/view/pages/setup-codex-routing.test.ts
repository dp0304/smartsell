import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { agentRepairCommand } from './setup-agent-prompt';
import { codexRouting, previousCodexRouting, previousCodexRoutings } from './setup-codex-routing';

// COH-2 / wave 6: the Codex routing block installed by the prompt enrollment (「進階：舊的接入方式」) routes social-status
// questions to the hub tools that every phase-1 connection lists (§7.1, §7.4), and still upgrades the block shipped before it.
const HUB_TOOLS = ['smartsell_overview', 'machines_list', 'channels_list', 'channel_check', 'media_upload', 'post_schedule', 'post_update',
  'posts_list', 'post_get', 'task_get', 'publishing_pause'];
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** The blocks shipped so far, newest first. The installer finds an installed block by its exact bytes, so these never change. */
const SHIPPED = [
  '0c57479f876df850e173cb4932be363822cb091a3dbaab0ebbfcc1caeb7c65ff', // v2: fresh idempotency keys, historical receipts (until wave 6)
  '296f504cd98c6daa99fb305efc00b2d9a64542abd8b331af08e2c864e6366953', // v1: first release
];

test('the routing block sends social-status and post questions to the hub tools, never to tools hub_v1 does not list', () => {
  for (const tool of ['smartsell_overview', 'channels_list', 'channel_check', 'task_get', 'posts_list', 'post_get']) assert.ok(codexRouting.includes(`\`${tool}\``), tool);
  assert.doesNotMatch(codexRouting, /worker_social_status|smartsell_operation|publishing_(create|request|get)|posts_get|recent_posts|idempotency_key/);
  // Every backticked snake_case name that is a tool (it ends in a tool verb or noun) is one of the 11 hub tools.
  const named = [...codexRouting.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(match => match[1])
    .filter(name => /_(overview|list|check|get|request|call|upload|schedule|update|pause|describe)$/.test(name));
  assert.deepEqual(named.filter(name => !HUB_TOOLS.includes(name)), []);
  assert.ok(Buffer.byteLength(codexRouting) < 4096, 'stays a short routing hint');
});

test('the previously shipped blocks keep their exact bytes, and every block shares the managed markers', () => {
  assert.deepEqual(previousCodexRoutings.map(sha256), SHIPPED);
  assert.equal(previousCodexRouting, previousCodexRoutings[0], 'the installer upgrades the block shipped right before this one');
  const markers = (block: string) => [block.split('\n')[0], block.split('\n').at(-1)];
  assert.deepEqual(markers(codexRouting), ['<!-- BEGIN SmartSell managed social routing -->', '<!-- END SmartSell managed social routing -->']);
  for (const block of previousCodexRoutings) assert.deepEqual(markers(block), markers(codexRouting));
  assert.ok(!previousCodexRoutings.includes(codexRouting));
});

/**
 * Runs the installer's own `install_codex_routing()` from the shipped repair command, with the block bytes the command
 * carries, against a temporary CODEX_HOME. Only RelayError and the stdlib imports it uses are defined around it.
 */
function installer(t: TestContext) {
  const prompt = agentRepairCommand('0f8fad5b-d9cb-469f-a165-70867728950e', 'https://hub.example.test/mcp');
  const lines = prompt.split('\n');
  const current = lines.find(text => text.startsWith('codex_routing = '))!;
  // `previous_codex_routing = "<one block>"` today; `previous_codex_routings = [<every block>]` once the installer takes the history.
  const previous = lines.find(text => /^previous_codex_routings? = /.test(text))!;
  const carried = [JSON.parse(previous.slice(previous.indexOf('=') + 1)) as string | string[]].flat();
  const start = prompt.indexOf('def install_codex_routing():');
  const end = prompt.indexOf('\n\n\ndef ', start);
  assert.ok(start > 0 && end > start, 'the command carries install_codex_routing()');
  assert.equal(JSON.parse(current.slice(current.indexOf('=') + 1)), codexRouting);
  const script = ['# -*- coding: utf-8 -*-', 'import os, re, stat, sys', 'from pathlib import Path', 'class RelayError(Exception):\n    pass',
    current, previous, prompt.slice(start, end),
    'try:\n    install_codex_routing()\nexcept RelayError as error:\n    sys.exit(str(error))'].join('\n\n');
  const home = mkdtempSync(join(tmpdir(), 'smartsell-codex-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const rules = join(home, 'AGENTS.md');
  const run = () => spawnSync('python3', ['-I', '-c', script], { env: { CODEX_HOME: home, HOME: home, PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
  return { rules, run, carried };
}

const python = spawnSync('python3', ['--version']).status === 0;
const userBefore = '# My Codex rules\n\nKeep answers short.';
const userAfter = '\n\n# Other instructions\r\nLeave this intact.\n';

test('installer: a fresh AGENTS.md gets the current block; running again changes nothing', { skip: !python && 'python3 is not installed' }, t => {
  const { rules, run } = installer(t);
  writeFileSync(rules, userBefore);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(rules, 'utf8'), `${userBefore}\n\n${codexRouting}\n`);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(rules, 'utf8'), `${userBefore}\n\n${codexRouting}\n`);
});

test('installer: the block shipped before is upgraded in place, byte for byte around it; an edited block is kept', { skip: !python && 'python3 is not installed' }, t => {
  const { rules, run, carried } = installer(t);
  assert.ok(carried.includes(previousCodexRouting), 'the command recognises the block shipped right before this one');
  assert.ok(carried.every(block => previousCodexRoutings.includes(block)), 'it recognises only blocks SmartSell shipped');
  // G6 handoff (wave 6): every shipped block is upgraded, not only the latest, so a v1 install moves to the current block too.
  assert.deepEqual(carried, [...previousCodexRoutings], 'the command carries every block SmartSell shipped');
  for (const block of carried) {
    writeFileSync(rules, `${userBefore}\n\n${block}${userAfter}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(rules, 'utf8'), `${userBefore}\n\n${codexRouting}${userAfter}`);
    }
  }
  const edited = `${userBefore}\n\n${previousCodexRouting.replace('其他工作照常。', '使用者修改了這段。')}${userAfter}`;
  writeFileSync(rules, edited);
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /SmartSell 路由標記已被編輯或重複，已保留原文。/);
  assert.equal(readFileSync(rules, 'utf8'), edited);
});
