// Test-controllable TCP proxy between one headless Worker and the hub (§10.2 stack step 4). `partition(true)` drops
// every open connection and resets new ones, so that machine alone sees the hub as unreachable (connection errors,
// exactly what §5.7 rule 1 counts); the hub and the other machine are unaffected.
import { createServer, connect, type Server, type Socket } from 'node:net';

export interface TcpProxy {
  readonly port: number;
  readonly origin: string;
  readonly partitioned: boolean;
  partition(on: boolean): void;
  /** Connections accepted while partitioned (each one was reset). */
  readonly refused: number;
  close(): Promise<void>;
}

export async function startTcpProxy(target: { host: string; port: () => number }): Promise<TcpProxy> {
  const sockets = new Set<Socket>();
  let partitioned = false;
  let refused = 0;
  const server: Server = createServer(client => {
    if (partitioned) { refused++; client.resetAndDestroy(); return; }
    const upstream = connect({ host: target.host, port: target.port() });
    sockets.add(client);
    sockets.add(upstream);
    const drop = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on('error', drop);
    upstream.on('error', () => { if (!client.destroyed) client.resetAndDestroy(); drop(); });
    client.on('close', drop);
    upstream.on('close', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const { port } = server.address() as { port: number };
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    get partitioned() { return partitioned; },
    get refused() { return refused; },
    partition(on: boolean) {
      partitioned = on;
      if (on) for (const socket of sockets) socket.resetAndDestroy();
    },
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
