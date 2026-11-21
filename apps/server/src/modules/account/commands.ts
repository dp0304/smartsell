import { parseLeaseScope, type LeaseScope } from '../../../../../packages/connector-tasks/src/index.js';
import { createPlatformAdapter, findPlatform, platforms, type ConnectionCtx } from '../../extensions/platforms.js';
import { admins, DomainError, readers, text, writers, type Commands, type Context, type Fields, type Role } from '../types.js';
import { deviceBlock, readiness, reportIdentity, resolveBlock, setBinding } from './bindings.js';
import { commandOAuth, type CommandOAuthServices } from './command-oauth.js';
import { authenticateDeviceCommand, type SignedDeviceCommand } from './device-ingress.js';
import { checkLease, finishPairing, heartbeat, issueLease, markDeviceOnline, revokeDevice, revokeLease, startDeviceProof, startPairing, sweepPresence, type LeaseKey } from './devices.js';
import { approved, choice, emit, ensure, get, idFor, identifier, insert, list, millis, openBlock, requireRole, stopAuto, update } from './model.js';
import { autoDecision, bindingHalt, currentTerms, enableAuto, haltGeneration, recheckTerms, setWorkspaceHalt, workspaceHalt, type AutoLimits, type TermsSource } from './policy.js';
import { accountStatus, connectionActive, linkedActive, recordGrant, recordManualResult, registerAccount, revokeConnection, type LicenseSource } from './registry.js';

export interface CommandServices {
  leaseKey?: LeaseKey;
  oauth?: CommandOAuthServices;
  terms?: TermsSource;
  license?: LicenseSource;
  phase?: ConnectionCtx['phase'];
  credential?: (ctx: Context, connectionId: string, accountId: string, grantRevision: number) => Promise<ConnectionCtx['credential']>;
  authorizeJob?: (ctx: Context, scope: LeaseScope) => Promise<boolean>;
  connectorCompatibility?: (ctx: Context, scope: Omit<LeaseScope, 'jobId'>, target: { mobileDeviceId: string | null }) => Promise<{ ready: boolean; allowAuto: boolean; limits?: AutoLimits }>;
}

const bindingFor = (ctx: Context, input: Fields) => get(ctx, 'account_execution_binding', identifier(input, 'binding_id'));

export function createAccountModule(services: CommandServices = {}) {
  const oauth = commandOAuth(services.oauth);

  async function location(ctx: Context, input: Fields, deviceId?: string) {
    const binding = await bindingFor(ctx, input);
    if (deviceId !== undefined) ensure(binding.data.device_id === deviceId, 'device_binding_mismatch', 403);
    const account = await get(ctx, 'social_account', binding.data.social_account_id);
    const scope = { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, bindingId: binding.id, platform: account.data.provider, deviceId: binding.data.device_id, channel: binding.data.connector_channel, workflow: binding.data.workflow } as Omit<LeaseScope, 'jobId'>;
    const reason = await readiness(ctx, account, binding);
    const target = { mobileDeviceId: binding.data.mobile_device_id ?? null };
    const compatibility = reason ? undefined : await services.connectorCompatibility?.(ctx, scope, target);
    return { binding, scope, reason: reason ?? (compatibility?.ready ? null : 'compatibility_unverified'), compatibility };
  }

  async function jobScope(ctx: Context, scope: Omit<LeaseScope, 'jobId'>, input: Fields) {
    const jobId = identifier(input, 'job_id');
    try { scope = parseLeaseScope({ ...scope, jobId }); }
    catch { throw new DomainError('invalid_job_scope', 'Invalid job scope', 422); }
    const result = scope as LeaseScope;
    ensure(await services.authorizeJob?.(ctx, result), 'job_not_authorized', 403);
    return result;
  }

  async function credentialFor(ctx: Context, connection: Awaited<ReturnType<typeof get>>, accountId: string) {
    const revision = connection.data.grant_revision ?? 0;
    const credential = await services.credential?.(ctx, connection.id, accountId, revision);
    if (!credential || credential.accountId !== accountId || !Array.isArray(connection.data.granted_scopes)) return undefined;
    const expiresAt = Math.min(Date.parse(connection.data.expires_at), credential.expiresAt ?? Infinity);
    if (!Number.isFinite(expiresAt)) return undefined;
    return { ...credential, expiresAt, scopes: credential.scopes.filter((scope) => connection.data.granted_scopes.includes(scope)) };
  }

  async function capabilities(ctx: Context, input: Fields) {
    const target = choice(input, 'target', ['social_account', 'store_connection'] as const);
    const id = identifier(input, 'id');
    const row = await get(ctx, target === 'social_account' ? 'social_account' : 'connection', id);
    if (target === 'store_connection') ensure(row.data.purpose === 'store', 'not_store_connection', 422);
    const adapter = createPlatformAdapter(row.data.provider);
    const disabled = row.data.status === 'disabled';
    const connections = disabled ? [] : target === 'social_account' ? await linkedActive(ctx, row) : connectionActive(ctx, row) ? [row] : [];
    const accountId = target === 'social_account' ? row.data.external_account_id : row.data.principal_id;
    const reports = [await adapter.probe({ accountId, phase: services.phase })];
    for (const conn of connections) {
      const credential = await credentialFor(ctx, conn, accountId);
      if (credential) reports.push(await adapter.probe({ accountId, phase: services.phase, credential }));
    }
    let connector: Fields = { available: false, reason: 'device_not_assigned' };
    if (target === 'social_account' && (await ctx.get('account', 'account_execution_binding', id))?.data.device_id) {
      const { binding, reason, compatibility } = await location(ctx, { binding_id: id });
      const decision = reason ? undefined : await autoDecision(ctx, binding, services.terms);
      connector = { available: !reason, reason, channel: binding.data.connector_channel, workflow: binding.data.workflow,
        mode: compatibility?.allowAuto && decision && decision.status !== 'denied' ? 'auto' : 'assist' };
    }
    const paths = reports[0].capabilities.map((decl, index) => {
      const candidates = reports.slice(1).map((report) => report.capabilities[index]);
      const value = candidates.find((entry) => entry?.available) ?? candidates[0] ?? decl;
      return disabled ? { ...value, available: false, reason: 'account_disabled' } : value;
    });
    return { provider: row.data.provider, target, id, checked_at: ctx.now, capabilities: paths, connector };
  }

  const commands: Commands = {};
  function command(name: string, roles: readonly Role[], run: (ctx: Context, input: Fields) => Promise<unknown>) {
    commands[name] = { roles, run: async (ctx, input) => {
      requireRole(ctx, roles);
      ensure(input && typeof input === 'object' && !Array.isArray(input), 'invalid_input', 422);
      return run(ctx, input);
    } };
  }
  command('list_accounts', readers, async (ctx, input) => {
    const brandId = input.brand_id === undefined ? undefined : identifier(input, 'brand_id');
    const provider = input.provider === undefined ? undefined : identifier(input, 'provider');
    if (provider) ensure(findPlatform(provider), 'invalid_provider', 422);
    const rows = await list(ctx, 'social_account');
    return { items: rows.filter(({ data }) => (!brandId || data.brand_id === brandId) && (!provider || data.provider === provider)) };
  });
  command('register_account', admins, async (ctx, input) => {
    const brand = await ctx.get('workspace', 'brand', identifier(input, 'brand_id'));
    ensure(brand && (brand.data.status === 'active' || brand.data.status === undefined), 'brand_not_found', 404);
    return registerAccount(ctx, input, services.license);
  });
  command('disable_account', admins, (ctx, input) => accountStatus(ctx, input, 'disabled'));
  command('enable_account', admins, (ctx, input) => accountStatus(ctx, input, 'active', services.license));
  command('start_oauth', admins, oauth.start);
  command('revoke_connection', admins, revokeConnection);
  command('platform_catalog', readers, async () => Object.keys(platforms).map(findPlatform));
  command('check_capabilities', readers, capabilities);
  command('create_pairing_code', admins, startPairing);
  command('revoke_device', admins, revokeDevice);
  command('set_execution_binding', admins, setBinding);
  command('get_auto_terms', readers, async (ctx) => ({ terms: await currentTerms(ctx, services.terms) ?? null }));
  command('enable_auto_mode', admins, async (ctx, input) => {
    const target = await location(ctx, input);
    if (target.reason) throw new DomainError('connector_unavailable', target.reason, 409);
    return enableAuto(ctx, target.binding, input, services.terms, target.compatibility?.allowAuto === true, target.compatibility?.limits);
  });
  command('disable_auto_mode', admins, async (ctx, input) => {
    const binding = await bindingFor(ctx, input);
    const row = await update(ctx, binding, { connector_mode: 'assist' });
    await emit(ctx, 'binding.auto_disabled', { binding_id: binding.id, actor_id: ctx.actorId });
    return row;
  });
  command('halt_auto_mode', writers, async (ctx, input) => bindingHalt(ctx, await bindingFor(ctx, input), true, text(input, 'reason', 512)));
  command('release_auto_halt', admins, async (ctx, input) => bindingHalt(ctx, await bindingFor(ctx, input), false, text(input, 'reason', 512)));
  command('halt_workspace_auto', writers, (ctx, input) => setWorkspaceHalt(ctx, input, true));
  command('release_workspace_auto', admins, (ctx, input) => setWorkspaceHalt(ctx, input, false));
  command('revoke_lease', admins, revokeLease);
  command('resolve_block', admins, resolveBlock);
  command('record_manual_result', writers, recordManualResult);

  // Callers authenticate the device principal or internal worker before running these methods.
  const internal = {
    recordGrant, completeOAuth: oauth.complete, finishPairing, startDeviceProof, heartbeat, sweepPresence,
    async resolveStoreCatalog(ctx: Context, connectionId: string): Promise<ConnectionCtx> {
      const connection = await get(ctx, 'connection', connectionId);
      ensure(connection.data.purpose === 'store', 'not_store_connection', 422);
      const accountId = connection.data.principal_id;
      const empty = { accountId, phase: services.phase };
      if (!connectionActive(ctx, connection)) return empty;
      const credential = await credentialFor(ctx, connection, accountId);
      if (!credential) return empty;
      const candidate = { ...empty, credential };
      const report = await createPlatformAdapter(connection.data.provider).probe(candidate);
      return report.capabilities.some((cap) => cap.executor === 'api' && cap.operation === 'catalog' && cap.available) ? candidate : empty;
    },
    async resolveOfficialConnection(ctx: Context, request: { accountId: string; externalAccountId: string; provider: string; operation: 'publish' | 'observe' | 'upload_draft' }): Promise<ConnectionCtx> {
      const account = await get(ctx, 'social_account', request.accountId);
      ensure(account.data.provider === request.provider && account.data.external_account_id === request.externalAccountId, 'account_identity_mismatch', 403);
      // Disabled accounts can still reconcile previously submitted work through an active grant.
      const empty = { accountId: request.externalAccountId, phase: services.phase };
      if (account.data.status !== 'active' && request.operation !== 'observe') return empty;
      const adapter = createPlatformAdapter(account.data.provider);
      for (const conn of await linkedActive(ctx, account)) {
        const credential = await credentialFor(ctx, conn, request.externalAccountId);
        if (!credential) continue;
        const candidate = { ...empty, credential };
        const report = await adapter.probe(candidate);
        if (report.capabilities.some((cap) => cap.executor === 'api' && cap.operation === request.operation && cap.available)) return candidate;
      }
      return empty;
    },
    recheckTerms: (ctx: Context) => recheckTerms(ctx, services.terms),
    setOpsHalt: (ctx: Context, ruleId: string, halted: boolean, reason: string) => workspaceHalt(ctx, halted, reason, ruleId),
    reportIdentity: (ctx: Context, deviceId: string, input: Fields) => reportIdentity(ctx, identifier(input, 'binding_id'), deviceId, input.observed_platform_user_id === null ? null : identifier(input, 'observed_platform_user_id')),
    reportBlock: (ctx: Context, deviceId: string, input: Fields) => deviceBlock(ctx, identifier(input, 'binding_id'), deviceId, choice(input, 'reason', ['captcha', 'platform_restriction'] as const)),
    async claimLease(ctx: Context, deviceId: string, input: Fields) {
      approved(input, 'user_requested');
      const target = await location(ctx, input, deviceId);
      if (target.reason) return { status: 'manual_required', reason: target.reason };
      if (!services.leaseKey) return { status: 'manual_required', reason: 'lease_signing_unconfigured' };
      const scope = await jobScope(ctx, target.scope, input);
      return { status: 'leased', ...await issueLease(ctx, scope, target.binding, services.leaseKey) };
    },
    async useLease(ctx: Context, deviceId: string, input: Fields) {
      ensure(services.leaseKey, 'lease_signing_unconfigured');
      const target = await location(ctx, input, deviceId);
      if (target.reason) return { status: 'manual_required', reason: target.reason };
      const scope = await jobScope(ctx, target.scope, input);
      const lease = await checkLease(ctx, text(input, 'token', 2048), scope, services.leaseKey);
      ensure(lease.data.binding_revision === target.binding.data.binding_revision, 'lease_binding_changed');
      await update(ctx, lease, { status: 'consumed', consumed_at: ctx.now });
      await emit(ctx, 'lease.consumed', { lease_id: lease.id, binding_id: target.binding.id });
      return { status: 'manual_required', reason: 'user_action_required', workflow: scope.workflow };
    },
    async requestSubmitPermit(ctx: Context, deviceId: string, input: Fields) {
      const target = await location(ctx, input, deviceId);
      const { binding } = target;
      const decision = await autoDecision(ctx, binding, services.terms);
      if (decision.status !== 'granted') return decision;
      if (target.reason || !target.compatibility?.allowAuto || !services.leaseKey) return { status: 'denied', reason: target.reason ?? 'connector_auto_unavailable' };
      const scope = await jobScope(ctx, target.scope, input);
      const lease = await checkLease(ctx, text(input, 'token', 2048), scope, services.leaseKey);
      ensure(lease.data.binding_revision === binding.data.binding_revision, 'lease_binding_changed');
      const permitId = idFor(binding.id, scope.jobId);
      const previous = await ctx.get('account', 'submit_permit', permitId);
      const auto_generation = binding.data.auto_generation ?? 0;
      const halt_generation = await haltGeneration(ctx);
      const stillReserved = previous?.data.status === 'reserved' && Date.parse(previous.data.expires_at) > millis(ctx) &&
        previous.data.auto_generation === auto_generation && previous.data.halt_generation === halt_generation;
      ensure(previous?.data.status !== 'consumed' && !stillReserved, 'permit_already_issued');
      const expiresAt = new Date(Math.min(lease.data.exp * 1000, millis(ctx) + 15000)).toISOString();
      const reservation = { binding_id: binding.id, job_id: scope.jobId, lease_id: lease.id, expires_at: expiresAt, status: 'reserved', auto_generation, halt_generation };
      await update(ctx, binding, { permit_usage: decision.usage });
      if (previous) await update(ctx, previous, reservation);
      else await insert(ctx, 'submit_permit', reservation, permitId);
      await emit(ctx, 'submit_permit.granted', { permit_id: permitId, binding_id: binding.id, job_id: scope.jobId });
      return { status: 'granted', permit_id: permitId, expires_at: expiresAt };
    },
    async consumeSubmitPermit(ctx: Context, deviceId: string, input: Fields) {
      const target = await location(ctx, input, deviceId);
      const { binding } = target;
      const decision = await autoDecision(ctx, binding, services.terms, true);
      if (decision.status !== 'granted') return decision;
      if (target.reason || !target.compatibility?.allowAuto || !services.leaseKey) return { status: 'denied', reason: target.reason ?? 'connector_auto_unavailable' };
      const scope = await jobScope(ctx, target.scope, input);
      const lease = await checkLease(ctx, text(input, 'token', 2048), scope, services.leaseKey);
      ensure(lease.data.binding_revision === binding.data.binding_revision, 'lease_binding_changed');
      const permitId = idFor(binding.id, scope.jobId);
      const permit = await get(ctx, 'submit_permit', permitId);
      ensure(permit.data.lease_id === lease.id && permit.data.status === 'reserved' && Date.parse(permit.data.expires_at) > millis(ctx) &&
        permit.data.auto_generation === (binding.data.auto_generation ?? 0) && permit.data.halt_generation === await haltGeneration(ctx), 'permit_unavailable');
      // Fence concurrent account updates and consume both artifacts in the same transaction.
      await update(ctx, binding, { last_permit_consumed_at: ctx.now });
      await update(ctx, permit, { status: 'consumed', consumed_at: ctx.now });
      await update(ctx, lease, { status: 'consumed', consumed_at: ctx.now });
      await emit(ctx, 'submit_permit.consumed', { permit_id: permitId, binding_id: binding.id, job_id: scope.jobId });
      return { status: 'consumed', permit_id: permitId };
    },
    async recordExecutionOutcome(ctx: Context, input: Fields) {
      const binding = await bindingFor(ctx, input);
      if (input.submitted_by !== 'auto' || binding.data.connector_mode !== 'auto') return { counted: false };
      const outcome = choice(input, 'outcome', ['accepted', 'failed', 'outcome_unknown'] as const);
      const id = idFor(binding.id, identifier(input, 'attempt_id'));
      if (await ctx.get('account', 'auto_outcome', id)) return { counted: false };
      const failures = outcome === 'accepted' ? 0 : (binding.data.auto_consecutive_failures ?? 0) + 1;
      await insert(ctx, 'auto_outcome', { binding_id: binding.id, outcome }, id);
      const result = await update(ctx, binding, { auto_consecutive_failures: failures });
      if (failures >= 3) {
        const block = await openBlock(ctx, result, 'auto_failure_streak');
        await stopAuto(ctx, result, 'auto_failure_streak', block.id);
      }
      return { counted: true, consecutive_failures: failures };
    },
  };
  async function dispatchDevice(ctx: Context, request: SignedDeviceCommand, body: Uint8Array) {
    const input = await authenticateDeviceCommand(ctx, request, body);
    const deviceId = request.deviceId;
    switch (request.action) {
      case 'heartbeat': return markDeviceOnline(ctx, await get(ctx, 'device', deviceId));
      case 'report_identity': return internal.reportIdentity(ctx, deviceId, input);
      case 'report_block': return internal.reportBlock(ctx, deviceId, input);
      case 'claim_lease': return internal.claimLease(ctx, deviceId, input);
      case 'use_lease': return internal.useLease(ctx, deviceId, input);
      case 'request_submit_permit': return internal.requestSubmitPermit(ctx, deviceId, input);
      case 'consume_submit_permit': return internal.consumeSubmitPermit(ctx, deviceId, input);
    }
  }
  return { commands, internal, dispatchDevice };
}

export const { commands } = createAccountModule();
