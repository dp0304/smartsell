import { READ, type Context, type Operation } from '@smartsell/contracts';
import { agentPresence } from './activity.js';
import { viewPeriod } from './calendar.js';

// Read-model for the shell's Agent indicator, which every page shows. Contract: docs/agent-first-design.md 3.1.
// It reads only connections and Agent activity, so lighting the indicator never costs a whole home view.
export function presence(ctx: Context) {
  return { ...agentPresence(ctx), timezone: viewPeriod(ctx, {}, 1).tz, as_of: ctx.now };
}

export const presenceViewOperations: Operation[] = [
  { method: 'GET', path: '/views/agent-presence', name: 'views_agent_presence', roles: READ, summary: 'Read whether an Agent is connected and when one was last active',
    contract: { query: [] }, run: ctx => presence(ctx) },
];
