import { coreActions } from './core-actions';
import { supportActions } from './support-actions';

export const actions = { ...coreActions, ...supportActions };
