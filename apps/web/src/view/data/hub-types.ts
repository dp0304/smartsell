// Phase 1 view types come from the frozen contract (Appendix A, packages/contracts/src/phase1.ts). The web package does not
// link @smartsell/contracts, and phase1.ts has no imports, so the source file is referenced directly (types only).
export type {
  AlertChannelConfig, AttentionItem, AutomationNoticeAck, BlockerCode, ChannelDetail, ChannelPause, ChannelReadiness, ChannelSettingsRecord, ChannelSummary,
  DevicePosture, DriverHealth, EffectiveMode, ExecutionMode, ApprovalMode, HubProvider, JobDetailView, JobSummary, LoginState, MachineDetail, MachineSummary,
  MachineWarning, MediaRecentItem, OverviewView, OwnerAlert, OwnerAlertKind, PlatformDefaults, PostAction, PostDetailView, PostGroup, PostStatus, PostSummary,
  PublishWindow, Ref, RiskAck, TikTokDefaults, TimelineEntry, TodayView, WorkerJobStatus, XDefaults,
} from '../../../../../packages/contracts/src/phase1';

import type { AttentionItem, ChannelPause, PostGroup, PostSummary, TodayView } from '../../../../../packages/contracts/src/phase1';

/**
 * E35 (additive, views/posts.ts): what holds a post that would otherwise go out — an active publishing pause or its paused
 * machine. Present only while the post is held.
 */
export type PostPause = Omit<ChannelPause, 'scope'> & { scope: ChannelPause['scope'] | 'campaign' | 'machine'; pause_id: string | null };
/** The pause on any post a view returned (PostSummary, PostDetailView.post), if one holds it. */
export const pauseOf = (post: PostSummary | null | undefined): PostPause | undefined => (post as (PostSummary & { pause?: PostPause }) | null | undefined)?.pause;

/** views_today adds what each group is (content title or media file name); see views/today.ts. */
export type TodayGroup = PostGroup & { title?: string; media_filename?: string | null };
/** E35: an item per active publishing pause (kind 'publishing_paused'); E30: whether an item stops scheduling. */
export type TodayItem = Omit<AttentionItem, 'kind'> & { kind: AttentionItem['kind'] | 'publishing_paused'; blocks_scheduling?: boolean };
export type TodayData = Omit<TodayView, 'upcoming' | 'attention'> & { upcoming: TodayGroup[]; attention: TodayItem[] };

/** GET /api/v1/hub/info (§2.7, S1 ledger): only on the hub; 404 in development. */
export interface HubInfo {
  public_origin?: string; request_origin_ok?: boolean; version?: string;
  /** E46 (SEC-3): `funnel_on` true when Tailscale Funnel exposes the hub; `funnel_warning` is the owner sentence with the fix. */
  tailscale?: { serve_ok?: boolean | null; hostname?: string | null; funnel_on?: boolean | null; funnel_warning?: string | null } | null;
  worker_downloads?: { platform: string; url: string; filename?: string; version?: string; sha256?: string | null; bytes?: number }[];
}

/** hub_alerts_get_channels (S10 ledger 15). */
export interface AlertChannelsView {
  channels: ({ id: string; kind: 'ntfy' | 'bark' | 'telegram'; enabled: boolean; url?: string; chat_id?: string; token_set?: boolean;
    last_test?: { at?: string; ok?: boolean; status?: string; error?: string | null } | null;
    last_delivery?: { at?: string; ok?: boolean; error?: string | null } | null })[];
  preferences: { published: boolean; daily_summary: boolean };
  settings_url?: string;
}
