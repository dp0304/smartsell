import type { Operation } from '@smartsell/contracts';
import { briefOperations } from './brief-operations.js';
import { closeoutOperations } from './closeout-operations.js';
import { applyCampaignPauseEvent, checkMilestones, coordinationOperations } from './coordination-operations.js';
import { autoTransition, coreOperations } from './core.js';
import { applyCampaignCostEvent, spendOperations } from './spend-operations.js';

export const operations: Operation[] = [
  ...coreOperations, ...briefOperations, ...spendOperations, ...coordinationOperations, ...closeoutOperations,
];
export const schedules = [
  { id: 'campaign.auto_transition', intervalMs: 300_000, run: autoTransition },
  { id: 'campaign.check_milestones', intervalMs: 3_600_000, run: checkMilestones },
];

export const subscribers = [
  { id: 'campaign.costs', accepts: (type: string) => ['creator.terms.signed', 'creator.settlement.paid', 'creator.commission.platform_settled', 'analytics.observations.recorded'].includes(type), run: applyCampaignCostEvent },
  { id: 'campaign.pause', accepts: (type: string) => type === 'campaign.campaign.status_changed', run: applyCampaignPauseEvent },
];

export { commands } from './command-index.ts';
