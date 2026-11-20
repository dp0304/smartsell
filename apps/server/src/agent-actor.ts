import { Problem, type Context } from '@smartsell/contracts';

/**
 * An Agent connection runs with its person's role, so role checks stay on that person; the credential, not the role,
 * marks the caller as an Agent. The legacy 'agent' role still counts.
 */
export const fromAgent = (ctx: Context) => ctx.role === 'agent' || Boolean((ctx as Context & { agentCredentialId?: string }).agentCredentialId);

export const humanRequired = (what: string) => new Problem(403, 'HUMAN_REQUIRED', `${what} is a decision for a person in the SmartSell web app`);

/** Refuses a decision carried inside an otherwise Agent-callable write (design 4.3). */
export function requireHuman(ctx: Context, what: string) {
  if (fromAgent(ctx)) throw humanRequired(what);
}
