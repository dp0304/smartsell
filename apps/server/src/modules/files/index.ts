import { randomBytes } from 'node:crypto';
import { createMediaFiles, mediaStorageFromEnv } from '../../extensions/media-files.js';

// The host can instead construct and register an explicitly configured instance.
export const mediaFiles = createMediaFiles({
  storage: mediaStorageFromEnv(),
  signingKey: process.env.APP_SECRET ?? randomBytes(32),
});

export const operations = mediaFiles.operations;
