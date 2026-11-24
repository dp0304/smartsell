#!/usr/bin/env node
// Entry for `node smartsell-relay.mjs` (the esbuild bundle) and `bin/smartsell-relay.mjs`.
import { relayMain } from './cli.ts';

process.on('SIGTERM', () => process.exit(0));
relayMain({ argv: process.argv.slice(2), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })
  .then(code => { process.exitCode = code; if (code !== 0) process.exit(code); });
