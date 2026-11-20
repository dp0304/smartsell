import type { ConnectorTask, PlatformApp } from '../../../packages/connector-tasks/src/index.ts';

export type BlockReason = 'pairing_required' | 'binding_invalid' | 'host_unsupported' | 'mobile_unavailable' | 'device_compat_blocked'
  | 'identity_mismatch' | 'login_expired' | 'captcha' | 'risk_control' | 'app_prompt' | 'draft_ambiguous'
  | 'media_unverified' | 'approval_invalid' | 'unsupported' | 'lease_expired' | 'permit_unavailable'
  | 'late_or_stale' | 'assist_submit_timeout' | 'assist_closed' | 'result_not_found' | 'consent_required';
export type LocalBinding = {
  id: string; workspace_id: string; account_id: string; connector_device_id: string; platform_identity: string;
  owned: boolean; verified: boolean; consent_confirmed: boolean;
} & ({ channel: 'browser'; app: 'douyin' | 'xhs'; profile_id: string; dedicated: boolean }
  | { channel: 'mobile'; app: PlatformApp; mobile_device_id: string; expected_hardware_id: string });
export type LocalPhone = {
  id: string; hardware_id: string; owner_workspace_id: string; os: 'android' | 'ios'; major: number;
  transport: 'usb' | 'same_lan'; same_lan_confirmed: boolean;
  owned: boolean; physical: boolean; emulator: boolean; cloud: boolean; modified: boolean; paired: boolean;
  online: boolean; authorized: boolean; unlocked: boolean; developer_mode: boolean; ui_automation: boolean;
  compatible_apps: readonly PlatformApp[];
  apple?: { customer_signed: boolean; developer_account_confirmed: boolean; trusted: boolean; expires_at: string };
};
export type LocalState = {
  host: string;
  phase: 'P0b' | 'P1';
  pairing?: { device_id: string; workspace_id: string; owned: boolean; revoked: boolean };
  bindings: readonly LocalBinding[];
  phones: readonly LocalPhone[];
};

export function preflight(task: ConnectorTask, state: LocalState, now: number): BlockReason | undefined {
  if (state.host !== 'darwin' && state.host !== 'win32') return 'host_unsupported';
  const { pairing } = state;
  if (!pairing || pairing.owned !== true || pairing.revoked !== false || pairing.device_id !== task.connector_device_id || pairing.workspace_id !== task.workspace_id) return 'pairing_required';
  const candidates = state.bindings.filter(row => row.id === task.binding_id);
  const binding = candidates[0];
  const { target } = task;
  if (candidates.length !== 1 || binding.owned !== true || binding.verified !== true || binding.app !== target.app
    || binding.workspace_id !== task.workspace_id || binding.account_id !== task.account_id
    || binding.connector_device_id !== task.connector_device_id || binding.platform_identity !== task.platform_identity) return 'binding_invalid';
  if (binding.consent_confirmed !== true) return 'consent_required';
  if (binding.channel === 'browser' && target.channel === 'browser') {
    const unique = state.bindings.filter(row => row.channel === 'browser' && row.profile_id === target.profile_id).length === 1;
    return binding.dedicated === true && binding.profile_id === target.profile_id && unique ? undefined : 'binding_invalid';
  }
  if (binding.channel !== 'mobile' || target.channel !== 'mobile' || binding.mobile_device_id !== target.mobile_device_id) return 'binding_invalid';
  if (state.bindings.filter(row => row.channel === 'mobile' && row.mobile_device_id === target.mobile_device_id && row.app === target.app).length !== 1) return 'binding_invalid';
  const phones = state.phones.filter(row => row.id === target.mobile_device_id);
  const phone = phones[0];
  if (phones.length !== 1 || phone.owned !== true || phone.owner_workspace_id !== task.workspace_id || phone.physical !== true || phone.emulator !== false
    || phone.cloud !== false || phone.modified !== false || phone.paired !== true || !phone.hardware_id || /^emulator-/i.test(phone.hardware_id)
    || phone.online !== true || phone.authorized !== true || phone.unlocked !== true || phone.developer_mode !== true || phone.ui_automation !== true
    || !['android', 'ios'].includes(phone.os) || !['usb', 'same_lan'].includes(phone.transport)
    || (phone.transport === 'same_lan' && phone.same_lan_confirmed !== true)) return 'mobile_unavailable';
  if (phone.hardware_id !== binding.expected_hardware_id) return 'identity_mismatch';
  if (state.phones.some(other => other.id !== phone.id && other.hardware_id === phone.hardware_id)) return 'binding_invalid';
  if (!Number.isInteger(phone.major) || !phone.compatible_apps.includes(target.app)) return 'device_compat_blocked';
  if (phone.os === 'android' && phone.major < (phone.transport === 'same_lan' ? 11 : 8)) return 'device_compat_blocked';
  if (phone.os === 'ios') {
    if (state.host !== 'darwin' || state.phase !== 'P1' || phone.major < 18) return 'device_compat_blocked';
    const apple = phone.apple;
    if (apple?.customer_signed !== true || apple.developer_account_confirmed !== true || apple.trusted !== true || !(Date.parse(apple.expires_at) > now)) return 'mobile_unavailable';
  }
}
