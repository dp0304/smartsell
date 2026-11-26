// Signed device routes of remote control (design E50). The Worker long-polls /remote/next for the next command of its
// machine and answers on /remote/result. The signature and the machine's settings are checked in one short
// transaction; the wait happens after it (§0 rule 8).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Problem, REMOTE_RESULT_MAX_BYTES, type RemoteCapabilities, type RemoteResultRequest } from '@smartsell/contracts';
import type { SignedDeviceRequest } from '../account/device-control.js';
import type { SignedGateway } from '../worker/device-http.js';
import { remoteBroker } from './broker.js';
import { remoteSettings } from './settings.js';

const header = (request: FastifyRequest, name: string) => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};
const required = (request: FastifyRequest, name: string) => {
  const value = header(request, name);
  if (!value || value.length > 512) throw new Problem(401, 'INVALID_DEVICE_PROOF', `Missing ${name}`);
  return value;
};
const signedFrom = (request: FastifyRequest): SignedDeviceRequest => ({ device_id: required(request, 'x-smartsell-device'), timestamp: required(request, 'x-smartsell-timestamp'),
  nonce: required(request, 'x-smartsell-nonce'), signature: required(request, 'x-smartsell-signature') });
const bodyOf = (request: FastifyRequest) => Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
const json = (bytes: Buffer) => {
  try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new Problem(422, 'INVALID_DEVICE_REQUEST', 'Body must be JSON'); }
};

export function parseCapabilities(value: unknown): RemoteCapabilities {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const phones = Array.isArray(record.phones) ? record.phones.slice(0, 8).flatMap(item => {
    const phone = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if (typeof phone.serial !== 'string' || !/^[\w.:-]{1,128}$/.test(phone.serial)) return [];
    return [{ serial: phone.serial, model: typeof phone.model === 'string' ? phone.model.slice(0, 100) : null, state: typeof phone.state === 'string' ? phone.state.slice(0, 32) : 'unknown' }];
  }) : [];
  return { browser: record.browser === true, phones };
}

export function mountRemoteDeviceRoutes(ingress: FastifyInstance, gateway: SignedGateway) {
  ingress.post('/api/v1/device/remote/next', { bodyLimit: 16_384 }, async (request, reply) => {
    const bytes = bodyOf(request);
    const body = json(bytes) as { wait_ms?: unknown; capabilities?: unknown };
    const waitMs = typeof body.wait_ms === 'number' && Number.isFinite(body.wait_ms) ? Math.max(0, Math.min(25_000, body.wait_ms)) : 25_000;
    const who = await gateway.signed('remote.next', bytes, signedFrom(request), header(request, 'x-smartsell-workspace'), 16_384,
      (ctx, device) => ({ workspaceId: ctx.workspaceId, deviceId: String(device.id), settings: remoteSettings(device) }));
    const serverTime = () => new Date().toISOString();
    // Remote control off on this machine: answer at once so the Worker stops polling until a heartbeat turns it on.
    if (!who.settings.browser.enabled && !who.settings.phone.enabled) return { data: { command: null, settings: who.settings, server_time: serverTime() } };
    const abort = new AbortController();
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) abort.abort(); });
    const command = await remoteBroker().next(who.workspaceId, who.deviceId, parseCapabilities(body.capabilities), waitMs, abort.signal);
    return { data: { command, settings: who.settings, server_time: serverTime() } };
  });

  ingress.post('/api/v1/device/remote/result', { bodyLimit: REMOTE_RESULT_MAX_BYTES + 1024 }, async request => {
    const bytes = bodyOf(request);
    const body = json(bytes) as RemoteResultRequest;
    if (!body || typeof body.command_id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.command_id) || typeof body.ok !== 'boolean') {
      throw new Problem(422, 'INVALID_DEVICE_REQUEST', 'command_id and ok are required');
    }
    if (body.ok ? !body.result || typeof body.result !== 'object' : !body.error || typeof body.error.code !== 'string' || typeof body.error.message !== 'string') {
      throw new Problem(422, 'INVALID_DEVICE_REQUEST', 'A result needs result, a failure needs error {code, message}');
    }
    const who = await gateway.signed(`remote.result:${body.command_id}`, bytes, signedFrom(request), header(request, 'x-smartsell-workspace'), REMOTE_RESULT_MAX_BYTES,
      (ctx, device) => ({ workspaceId: ctx.workspaceId, deviceId: String(device.id) }));
    return { data: { accepted: remoteBroker().resolve(who.workspaceId, who.deviceId, body) } };
  });
}
