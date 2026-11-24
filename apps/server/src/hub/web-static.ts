import { constants, realpathSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** SPA entry points served with `dist/index.html` (§2.6, Appendix B.4). Everything else stays a JSON 404. */
export const SPA_EXACT_PATHS = ['/', '/setup', '/login', '/worker-connect', '/agent-connect'] as const;
export const SPA_PREFIXES = ['/app', '/w'] as const;
export const WEB_CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=0, must-revalidate';

const mimeTypes: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.webmanifest': 'application/manifest+json',
};
export const mimeType = (path: string) => mimeTypes[extname(path).toLowerCase()] ?? 'application/octet-stream';
/** Vite's content hash: `name-<8+ url-safe chars>.ext`. */
export const isHashedAsset = (path: string) => /[.-][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(path);

export function isSpaPath(url: string) {
  const path = url.split(/[?#]/, 1)[0];
  return (SPA_EXACT_PATHS as readonly string[]).includes(path) || SPA_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Resolves a request path under `base`, or undefined for anything that could escape it: `..` segments, absolute or
 * drive paths, backslashes, NUL, dot-files, or a symlink pointing outside the directory.
 */
export function safeStaticPath(base: string, requested: string) {
  if (!requested || requested.length > 512 || /[\0\\]/.test(requested) || isAbsolute(requested) || /^[A-Za-z]:/.test(requested)) return;
  const segments = requested.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.'))) return;
  const root = resolve(base);
  const candidate = resolve(root, ...segments);
  const inside = relative(root, candidate);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(candidate);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return;
    return real;
  } catch {
    return;
  }
}

// Helpers return booleans, never the reply: FastifyReply is a thenable, so awaiting a returned reply yields undefined.
async function sendFile(reply: FastifyReply, path: string, cacheControl: string) {
  const file = await open(path, constants.O_RDONLY).catch(() => undefined);
  if (!file) return false;
  const stat = await file.stat().catch(() => undefined);
  if (!stat?.isFile()) {
    await file.close();
    return false;
  }
  reply.header('cache-control', cacheControl).header('content-length', stat.size).type(mimeType(path)).send(file.createReadStream());
  return true;
}

export function webStatic(distDir: string) {
  const root = resolve(distDir);
  const indexPath = join(root, 'index.html');
  const notFoundBody = { error: { code: 'not_found', message: 'Resource not found' } };

  async function asset(directory: 'assets' | 'fonts', request: FastifyRequest<{ Params: { '*': string } }>, reply: FastifyReply) {
    const path = safeStaticPath(join(root, directory), request.params['*']);
    if (path && await sendFile(reply, path, isHashedAsset(path) ? IMMUTABLE : REVALIDATE)) return reply;
    return reply.code(404).send(notFoundBody);
  }

  return {
    indexPath,
    routes(app: FastifyInstance) {
      app.get<{ Params: { '*': string } }>('/assets/*', (request, reply) => asset('assets', request, reply));
      app.get<{ Params: { '*': string } }>('/fonts/*', (request, reply) => asset('fonts', request, reply));
      app.get('/favicon.ico', async (_request, reply) => {
        const path = safeStaticPath(root, 'favicon.ico');
        if (path && await sendFile(reply, path, REVALIDATE)) return reply;
        return reply.code(204).send();
      });
    },
    /** Delegate for `buildApp`'s 404 handler: serves index.html for SPA paths (returns true) and declines everything else. */
    async notFound(request: FastifyRequest, reply: FastifyReply) {
      if ((request.method !== 'GET' && request.method !== 'HEAD') || !isSpaPath(request.url)) return false;
      let html: Buffer;
      try { html = await readFile(indexPath); } catch {
        reply.code(503).send({ error: { code: 'web_not_built', message: 'The Web app is not built on this hub. Run pnpm hub:update.' } });
        return true;
      }
      reply.code(200).header('cache-control', 'no-store').header('content-security-policy', WEB_CSP)
        .header('x-frame-options', 'DENY').type('text/html; charset=utf-8').send(html);
      return true;
    },
  };
}
