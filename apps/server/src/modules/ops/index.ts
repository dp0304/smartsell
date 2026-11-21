import type { Commands } from '../types.js';
import type { Operation } from '@smartsell/contracts';
import { controlOperations } from './controls.js';
import { deploymentOperations } from './deployment.js';
import { governanceOperations } from './governance.js';
import { meteringOperations } from './metering.js';
import { recoveryOperations } from './recovery.js';
import { retentionOperations } from './retention.js';
import { webhookOperations } from './webhooks.js';
import { controlCommands } from './control.js';
import { egressCommands } from './egress.js';
import { retentionCommands } from './retention-policy.js';
import { usageCommands } from './usage.js';

export const commands: Commands = { ...controlCommands, ...egressCommands, ...retentionCommands, ...usageCommands };
export type { OpsContext } from './command-support.js';
export { forbiddenJobFlags, inheritConnectorAutoStop, isConnectorAutoStopped, isSafeMode, recordHeartbeat } from './control.js';
export { evaluateEgress, requireEgress } from './egress.js';
export { getRetentionPolicy } from './retention-policy.js';
export { appendUsageEvent, getUsage, requireUsageCapacity } from './usage.js';

const operationDefinitions = [
  ...controlOperations, ...deploymentOperations, ...governanceOperations,
  ...meteringOperations, ...recoveryOperations, ...retentionOperations, ...webhookOperations,
];
export const operations: Operation[] = operationDefinitions;
export const opsMcpNames: ReadonlySet<string> = new Set(operationDefinitions.filter(item => item.mcp).map(item => item.name));
export type { OpsContext as OperationOpsContext, OpsServices, Store } from './support.js';
export { assertEmergencyNotStopped, isEmergencyStopped, isSafeMode as isOperationSafeMode, isQueuePaused,
  isJobPaused, assertJobAllowed, evaluateEgress as evaluateOperationEgress, setEgressPolicy, confirmModelEgress } from './controls.js';
export { assertLicenseAllowed, assertModuleEnabled, assertSyncIntervalAllowed, assertUsageAllowed,
  getUsage as getOperationUsage, recordUsage } from './metering.js';
export { recordHeartbeat as recordOperationHeartbeat, recordProviderObservation } from './deployment.js';
export { executeRestore, runBackup } from './recovery.js';
export { getRetentionPolicy as getOperationRetentionPolicy } from './retention.js';
export { reportConnectorAutoStopped } from './governance.js';
export { deliverWebhook } from './webhooks.js';
