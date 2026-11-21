import type { Commands } from '../types.js';
import { coverageCommands } from './coverage.js';
import { metricCommands } from './metrics.js';
import { runCommands } from './runs.js';
import { sourceCommands } from './sources.js';

export { checkUse } from './model.js';
export const commands: Commands = { ...sourceCommands, ...runCommands, ...coverageCommands, ...metricCommands };
