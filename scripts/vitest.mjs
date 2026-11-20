import { relative } from 'node:path';
import { startVitest } from 'vitest/node';

const [config, ...tests] = process.argv.slice(2);
const files = tests.map(path => relative(process.cwd(), path).split('\\').join('/'));
const vitest = await startVitest('test', files, {
  config: config || undefined,
  watch: false,
  passWithNoTests: false,
}, { test: { include: files } });
await vitest.close();
