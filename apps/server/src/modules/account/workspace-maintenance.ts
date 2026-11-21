import { Problem } from '@smartsell/contracts';
import type { Schedule } from '../../operations.js';
import { recheckTerms, type Terms } from './auto-control.js';
import { invalidateConnectionCapabilities, refreshConnection, type AccountServices } from './oauth.js';

export function accountWorkspaceSchedule(services: AccountServices, currentTerms: () => Terms | undefined): Schedule {
  return {
    id: 'account.workspace-health',
    async run(ctx) {
      const terms = currentTerms();
      if (terms) recheckTerms(ctx, terms);
      const now = Date.parse(ctx.now);
      for (const connection of ctx.list('connection')) {
        if (connection.status !== 'active' || typeof connection.expires_at !== 'string' ||
          !(Date.parse(connection.expires_at) <= now)) continue;
        if (connection.sealed_token) {
          try {
            await refreshConnection(ctx, connection.id, services);
            continue;
          } catch (error) {
            // Retry transient or unavailable provider configuration on the next cycle.
            if (!(error instanceof Problem) || error.code !== 'REAUTHORIZATION_REQUIRED') continue;
          }
        }
        ctx.update('connection', connection.id, { status: 'reauthorization_required', sealed_token: null });
        invalidateConnectionCapabilities(ctx, connection.id, 'needs_authorization');
        ctx.emit('account.connection.expired', { connection_id: connection.id });
      }
    },
  };
}
