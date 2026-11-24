import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEnrollment } from '../data/types';
import { agentCheckPrompt, agentEnrollmentPrompt, agentRepairCommand } from './setup-agent-prompt';

// W-specs #4: phase-1 connections (tool profile hub_v1) list only the 11 hub tools (§7.1, §7.4), so the prompt enrollment's
// preflight and both check prompts name smartsell_overview, which every connection lists; any successful tool call verifies.
const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
const enrollment: AgentEnrollment = {
  id, client: 'codex', expires_days: 90, mcp_url: 'https://hub.example.test/mcp', code: 'c'.repeat(120), expires_at: '2026-11-24T12:10:00Z',
  redeem_url: `https://hub.example.test/api/v1/workspaces/${id}/agent-connections/redeem`,
};

test('the prompt preflight requires smartsell_overview in tools/list and tells the owner to call it', () => {
  for (const block of [agentEnrollmentPrompt(enrollment), agentRepairCommand(id, enrollment.mcp_url)]) {
    assert.match(block, /tool\.get\("name"\) == "smartsell_overview" for tool in tools/);
    assert.match(block, /從此註冊呼叫 smartsell_overview，再回 Web 重新檢查狀態/);
    assert.doesNotMatch(block, /smartsell_operations_describe/);
  }
});

test('both check prompts (Codex and Claude Code, zh-Hant and English) call smartsell_overview', () => {
  for (const english of [false, true]) {
    for (const connection of [id, undefined]) {
      const prompt = agentCheckPrompt(english, connection);
      assert.match(prompt, english ? /call smartsell_overview with empty arguments/ : /用空參數呼叫 smartsell_overview/);
      assert.doesNotMatch(prompt, /smartsell_operations_describe/);
    }
  }
  assert.match(agentCheckPrompt(true, id), /smartsell-0f8fad5bd9cb469fa16570867728950e MCP tools/);
});
