
import type { Commands } from '../types.js';
import { accounts } from './accounts.js';
import { adjustments } from './adjustments.js';
import { creatives } from './creatives.js';
import { operations as manualOperations } from './operations.js';
import { performance } from './performance.js';
import { proposals } from './proposals.js';

export const commands: Commands = { ...accounts, ...creatives, ...proposals, ...manualOperations, ...performance, ...adjustments };

export { operations } from "./workspace-operations.js";
