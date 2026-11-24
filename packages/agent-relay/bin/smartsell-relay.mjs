#!/usr/bin/env node
// Prefer the zero-dependency bundle (Node 20+). Without it, run the TypeScript source directly (Node 22.18+ strips types).
import { existsSync } from 'node:fs';

const bundle = new URL('../dist/smartsell-relay.mjs', import.meta.url);
await import(existsSync(bundle) ? bundle.href : new URL('../src/main.ts', import.meta.url).href);
