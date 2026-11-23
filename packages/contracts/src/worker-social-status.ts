export const workerSocialStatusVersion = 1;
export const workerSocialPlatforms = ['x', 'youtube', 'facebook', 'instagram', 'reddit', 'douyin', 'xhs', 'tiktok'] as const;
export const workerSocialStatusModes = ['account_status', 'recent_posts'] as const;
export const workerSocialChannelStatuses = ['verified', 'login_required', 'identity_mismatch', 'unverified', 'unsupported'] as const;
export const workerSocialStatusLimits = { identity: 160, posts: 5, text: 500 } as const;

export type WorkerSocialPlatform = typeof workerSocialPlatforms[number];
export type WorkerSocialStatusMode = typeof workerSocialStatusModes[number];
export type WorkerSocialStatusTarget = {
  mode: WorkerSocialStatusMode;
  platform?: WorkerSocialPlatform;
  expected_identity?: string;
};
export type WorkerSocialStatusRequest = Partial<WorkerSocialStatusTarget> & { device_id?: string };
export type WorkerSocialStatusClaim = WorkerSocialStatusTarget & {
  id: string;
  workspace_id: string;
  device_id: string;
  fencing_token: number;
  lease_expires_at: string;
};
export type WorkerSocialPost = { id: string; url: string; text: string; has_video: boolean };
export type WorkerSocialChannel = {
  platform: WorkerSocialPlatform;
  status: typeof workerSocialChannelStatuses[number];
  identity?: string;
  posts?: WorkerSocialPost[];
};
export type WorkerSocialStatusResult = { channels: WorkerSocialChannel[] };
export type WorkerSocialStatusReport = Pick<WorkerSocialStatusClaim, 'id' | 'fencing_token'> & { result: WorkerSocialStatusResult };
export type WorkerSocialStatusReceipt = { id: string; status: 'completed' | 'blocked' };
export type WorkerSocialStatusView = WorkerSocialStatusTarget & {
  id: string;
  workspace_id: string;
  device_id: string;
  status: 'queued' | 'claimed' | 'expired' | WorkerSocialStatusReceipt['status'];
  lease_expires_at?: string;
  reported_at?: string;
  result?: WorkerSocialStatusResult;
};
