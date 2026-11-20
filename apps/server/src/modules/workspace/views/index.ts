import type { Operation } from '@smartsell/contracts';
import { activityViewOperations } from './activity.js';
import { adsViewOperations } from './ads.js';
import { calendarViewOperations } from './calendar.js';
import { campaignsViewOperations } from './campaigns.js';
import { decisionsViewOperations } from './decisions.js';
import { homeViewOperations } from './home.js';
import { presenceViewOperations } from './presence.js';
import { productsViewOperations } from './products.js';
import { socialViewOperations } from './social.js';

/** Aggregated read models behind the agent-first web views (GET /views/*). */
export const viewOperations: Operation[] = [
  ...homeViewOperations, ...productsViewOperations, ...campaignsViewOperations, ...calendarViewOperations,
  ...socialViewOperations, ...adsViewOperations, ...decisionsViewOperations, ...activityViewOperations, ...presenceViewOperations,
];
