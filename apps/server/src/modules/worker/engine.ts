import { setWorkerEngineHooks, type WorkerEngineHooks } from '../account/channel-settings.js';
import { createCheckLoginJob, dispatchWorkerJob, isWorkerRoute } from './dispatch.js';
import { bumpSyncGeneration } from './model.js';
import { cancelWorkerTask, moveQueuedChannelJobs, revokeForTarget } from './revoke.js';

/**
 * The job engine's entry points for execution/service.ts and S2 (C3). execution/service.ts imports this module, so the
 * hooks S2 calls through are installed whenever the execution module is loaded, not only after discoverOperations().
 */
export { cancelWorkerTask, dispatchWorkerJob, isWorkerRoute };

const hooks: WorkerEngineHooks = {
  revokeForTarget, bumpSyncGeneration, moveQueuedChannelJobs,
  createCheckLoginJob: (ctx, accountId, opts) => createCheckLoginJob(ctx, accountId, opts) as unknown as ReturnType<WorkerEngineHooks['createCheckLoginJob']>,
};
export function installWorkerEngine() { setWorkerEngineHooks(hooks); }
// In a load cycle channel-settings may not have run yet (its `let hooks` is still in the TDZ): retry after the graph loads.
try { installWorkerEngine(); } catch { queueMicrotask(installWorkerEngine); }
