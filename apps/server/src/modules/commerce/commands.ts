import type { Commands } from '../types.js';
import { catalogCommands } from './catalog-commands.js';
import { coverageCommands } from './coverage.js';
import { importCommands } from './csv-workflow.js';

import { revisionCommands } from './revision-commands.js';

import { settlementCommands } from './settlement-commands.js';

import { promotionCommands } from './promotion-commands.js';

export const commands: Commands = { ...catalogCommands, ...importCommands, ...coverageCommands, ...revisionCommands, ...settlementCommands, ...promotionCommands };
