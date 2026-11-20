import { Readable } from 'node:stream';

/** Revalidate the live bearer between heartbeats. A stalled verifier also closes the connection. */
export function mcpEventStream(verify: () => Promise<boolean>) {
  let checking = false;
  let lastVerified = performance.now();
  let closed = false;
  const stream = new Readable({ read() {} });
  stream.push(': connected\nretry: 2000\n\n');
  const timer = setInterval(() => {
    if (performance.now() - lastVerified >= 15_000) { stream.destroy(); return; }
    if (checking) return;
    checking = true;
    void Promise.resolve().then(verify).then(valid => {
      if (closed || stream.destroyed) return;
      if (!valid) close();
      else {
        lastVerified = performance.now();
        if (!stream.push(': heartbeat\n\n')) stream.destroy();
      }
    }, close).finally(() => { checking = false; });
  }, 2000).unref();
  function close() {
    if (closed || stream.destroyed) return;
    closed = true;
    clearInterval(timer);
    stream.push(null);
  }
  stream.once('close', () => clearInterval(timer));
  return stream;
}

export function headerAcceptsEventStream(accept: string | undefined) {
  return accept?.split(',').some(entry => /^\s*text\/event-stream\s*(?:;\s*q=(?:1(?:\.0+)?|0\.\d*[1-9]\d*))?\s*$/i.test(entry));
}
