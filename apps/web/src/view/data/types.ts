import type { ActivityItem, CalendarEvent, DecisionItem, Metric, Point, ResourceRef, Unit } from '@smartsell/ui';

export type { ActivityItem, CalendarEvent, DecisionAction, DecisionItem, Metric, Point, ResourceRef } from '@smartsell/ui';

// Response shapes of GET /views/* (docs/agent-first-design.md §3). Fields may be missing while the
// server side is still rolling out, so readers treat everything as optional at the edges.
export interface Kpi extends Metric { key: string; unit: Unit; currency: string | null; sparkline?: Point[] }
export interface LivePlan { id: string; name: string; status: string; starts_at: string | null; ends_at: string | null; days_left: number | null; completeness_ratio: number | null; published: number | null; planned: number | null }
export interface Alert { kind: string; severity: 'blocker' | 'high' | 'normal'; title: string; resource?: ResourceRef | null }
export interface HomeView {
  as_of?: string; timezone?: string; period?: { from: string; to: string };
  needs_you?: { total: number; items: DecisionItem[] };
  this_week?: { scheduled: number | null; published: number | null; failed: number | null; outcome_unknown: number | null; upcoming: CalendarEvent[] };
  kpis?: Kpi[]; live_plans?: LivePlan[];
  agent?: { connections: number; last_seen_at: string | null; recent: ActivityItem[] };
  alerts?: Alert[];
}
export interface DecisionSummary { counts?: Record<string, number>; total?: number; as_of?: string }

export interface AgentConnection { id: string; label: string; client: string; created_at: string; expires_at: string | null; last_used_at: string | null; revoked: boolean }
export interface AgentSetup { claude_code_command?: string; claude_code_json?: string; codex_toml?: string; codex_command?: string; agents_md?: string }
export interface CreatedConnection { id: string; label: string; client: string; token: string; mcp_url: string; expires_at: string | null; setup?: AgentSetup }
export interface AgentJob {
  id: string; title: string; kind?: string; status: string; created_at?: string; updated_at?: string; due_at?: string | null;
  assignee_type?: 'agent_client' | 'user' | null; progress_note?: string | null; brand_id?: string | null;
}

export interface ProductCard {
  id: string; title: string; status: string; brand_id?: string | null; image_url?: string | null;
  store?: { id: string; name: string; provider: string; status: string } | null; variants?: { total: number };
  markets?: { market_id: string; market_name: string; channel: string; price: { min_minor: number | null; max_minor: number | null; currency: string } | null; stock: { status: string; quantity: number | null } }[];
  plans?: { live: { id: string; name: string; ends_at: string | null }[]; upcoming: number };
  performance?: { views?: Metric; engagements?: Metric };
  attention?: { kind: string; severity: string; title: string }[]; created_via?: 'agent' | 'human' | null;
}
export interface PlanCard {
  id: string; name: string; kind?: string; status: string; brand_id?: string | null; starts_at: string | null; ends_at: string | null; timezone?: string;
  day?: number | null; days?: number | null; matrix?: { planned: number; published: number; completeness_ratio: number | null };
  needs_decision?: number; created_via?: 'agent' | 'human' | null;
}
export interface CalendarView { range?: { from: string; to: string; tz: string }; events?: CalendarEvent[]; sources?: { kind: string; availability: string }[]; as_of?: string }
export interface SocialView {
  period?: { from: string; to: string; tz: string };
  accounts?: { social_account_id: string; platform: string; display_name: string; handle?: string; followers?: Metric; metrics?: Record<string, Metric>; posts_published?: number; last_observed_at?: string | null }[];
  totals?: { views?: Metric; engagements?: Metric };
  series?: { metric: string; total: Point[]; by_account: { social_account_id: string; label: string; points: Point[] }[] };
  unranked_count?: number; as_of?: string;
}
export interface AdsView {
  accounts?: { id: string; provider: string; name: string; currency: string }[];
  metrics?: { spend?: Metric; impressions?: Metric; clicks?: Metric; conversions?: Metric };
  series?: { spend: Point[] }; proposals?: { id: string; name: string; status: string; budget?: { amount_minor: number | null; currency: string } | null }[];
  as_of?: string;
}
