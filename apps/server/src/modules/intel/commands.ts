import type { Commands } from '../types.ts';
import { candidateCommands } from './candidates.ts';
import { observationCommands } from './observations.ts';
import { researchCommands } from './research.ts';
import { signalCommands } from './signals.ts';

export const commands: Commands = {
  ...observationCommands,
  ...researchCommands,
  ...candidateCommands,
  ...signalCommands,
};
