import { fileURLToPath } from 'node:url';
import { makeContext } from '../../context.js';
import { commandBackgroundStore } from '../../integration/command-background.js';
import { localStore } from '../../local.js';
import { createExecutionWorker, type ExecutionAdapter, type Transact } from './worker.js';

export async function publishingTransactions(store: ReturnType<typeof localStore>) {
  const background = commandBackgroundStore(store);
  const [workspace] = await background.workspaces();
  const transact: Transact = action => background.transact(workspace, false, (records, scope) => action(makeContext(records, scope, 'owner')));
  return { background, workspace, transact };
}

export function loopbackAdapter(origin: string): ExecutionAdapter {
  const endpoint = new URL(origin);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port) throw new Error('Expected an ephemeral loopback origin');
  return {
    provider: 'meta_facebook',
    async submit(request) {
      const response = await fetch(new URL('/posts', endpoint), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Fixture submit returned ${response.status}`);
      return response.json();
    },
    async observe(request) {
      const response = await fetch(new URL(`/posts/${encodeURIComponent(request.client_request_id)}`, endpoint), { redirect: 'error' });
      if (!response.ok) throw new Error(`Fixture observation returned ${response.status}`);
      return response.json();
    },
  };
}

// The crash test kills this real consumer while it is waiting for the provider response.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, origin, taskId] = process.argv.slice(2);
  const store = localStore(path, { existing: true });
  try {
    const { transact } = await publishingTransactions(store);
    await createExecutionWorker(transact, [loopbackAdapter(origin)]).dispatch(taskId);
  } finally {
    await store.close();
  }
}
