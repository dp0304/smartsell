import type { Commands } from '../types.ts';
import { briefCommands } from './brief-commands.ts';
import { budgetCommands } from './budget-commands.ts';
import { campaignCommands } from './campaign-commands.ts';
import { closeoutCommands } from './closeout-commands.ts';
import { coordinationCommands } from './coordination-commands.ts';
import { templateCommands } from './template-commands.ts';

export const commands: Commands = {
  ...campaignCommands,
  ...briefCommands,
  ...coordinationCommands,
  ...budgetCommands,
  ...closeoutCommands,
  ...templateCommands,
};
