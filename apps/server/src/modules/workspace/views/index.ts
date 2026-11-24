import type { Operation } from '@smartsell/contracts';
import { activityViewOperations } from './activity.js';
import { adsViewOperations } from './ads.js';
import { calendarViewOperations } from './calendar.js';
import { campaignsViewOperations } from './campaigns.js';
import { decisionsViewOperations } from './decisions.js';
import { homeViewOperations } from './home.js';
import { hubViewOperations } from './hub-views.js';
import { presenceViewOperations } from './presence.js';
import { productsViewOperations } from './products.js';
import { socialViewOperations } from './social.js';

/** Aggregated read models behind the agent-first web views (GET /views/*). */
export const viewOperations: Operation[] = [
  ...homeViewOperations, ...productsViewOperations, ...campaignsViewOperations, ...calendarViewOperations,
  ...socialViewOperations, ...adsViewOperations, ...decisionsViewOperations, ...activityViewOperations, ...presenceViewOperations,
  ...hubViewOperations,
];

// Phase 1 builders (C7) for the Agent tools (S4) and the host wiring (installWebLinks).
export { buildOverview, buildToday } from './today.js';
export { machineSummaries, machineDetail, machineWarnings } from './machines.js';
export { channelSummaries, channelDetail } from './channels.js';
export { postSummary, postDetail, listPosts, jobDetail } from './posts.js';
export { webUrl, configureViewLinks } from './links.js';
export { installWebLinks } from './install.js';
