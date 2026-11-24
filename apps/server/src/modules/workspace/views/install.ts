import type { Context, Row } from '@smartsell/contracts';
import { configureAlerts } from '../../alerts/model.js';
import { configurePosting } from '../../posting/model.js';
import { configureViewLinks, webUrl } from './links.js';
import { machineWarnings } from './machines.js';

/**
 * Bootstrap wiring for S7's link builder (phase1-design §9.6, C7): one call so MCP results (S4) and owner alerts (S10) use
 * the same routes as the dashboard, and S10's machine_setup alerts use the §3.2 warnings. The host (L-server) calls it once
 * with `config.origin` before the background starts. Safe to call again (tests).
 */
export function installWebLinks(options: { publicOrigin: string }) {
  configureViewLinks({ publicOrigin: options.publicOrigin });
  configurePosting({ publicOrigin: options.publicOrigin, webUrl: (ctx: Context, kind, id) => webUrl(ctx, kind, id) });
  configureAlerts({ webUrl: (ctx: Context, kind, id) => webUrl(ctx, kind, id), machineWarnings: (ctx: Context, device: Row) => machineWarnings(ctx, device) });
}
