import { queueCommandReport } from './report-generation.js';
import { writers } from '../types.js';
import type { Commands } from '../types.js';
import { metricCommands } from './metrics.js';
import { registryCommands } from './registry.js';
import { reportCommands } from './report-workflows.js';
import { salesCommands } from './sales.js';
import { fxCommands } from './shared.js';
import { studyCommands } from './study-workflows.js';
import { reconciliationCommands } from './reconciliation.js';

import { commerceInsightCommands } from './commerce-insights.js';

export const commands: Commands = { ...registryCommands, ...metricCommands, ...fxCommands, ...salesCommands, ...reportCommands, ...studyCommands, ...reconciliationCommands, ...commerceInsightCommands,
  reports_generate_version: { roles: writers, accepted: true, run: queueCommandReport },
};
