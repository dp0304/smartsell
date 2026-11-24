/**
 * The single definition of production semantics (phase1-design §2.2): a hub (`SMARTSELL_MODE=hub`) is always production,
 * even when E2E starts it with `NODE_ENV=test`; otherwise `NODE_ENV=production`. `configuration()` returns it as its
 * `production` field; modules that run before or without a Config (egress, model runtime, lead contacts) call this
 * instead of reading `NODE_ENV`, so they agree with the configuration in every mode. No imports: safe from any module.
 */
export function productionSemantics(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SMARTSELL_MODE === 'hub' || env.NODE_ENV === 'production';
}
