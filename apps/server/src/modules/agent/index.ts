import type { Commands } from '../types.js';
import { auditCommands } from './agent-audit.js';
import { changeSetCommands } from './agent-changesets.js';
import { jobCommands } from './agent-jobs.js';
import { ruleCommands } from './agent-rules.js';
import { templateCommands } from './agent-templates.js';
import { modelCommands } from './model-routing.js';

export { recordAgentToolCall, type AgentToolAudit } from './agent-audit.js';
export { reapAgentJobLeases, type AgentContext } from './agent-jobs.js';
export { evaluateAgentRules, type RuleTrigger } from './agent-rules.js';
export { createModelClient } from './model-client.js';

export const commands: Commands = { ...jobCommands, ...changeSetCommands, ...ruleCommands, ...auditCommands,
  ...templateCommands, ...modelCommands };

export * from './operations.js';
