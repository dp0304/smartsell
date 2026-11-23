import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const route = '/api/v1/worker-downloads';
const packages = {
  'mac-arm64': { filename: 'SmartSell-Worker-mac-arm64.zip', type: 'application/zip' },
  'mac-x64': { filename: 'SmartSell-Worker-mac-x64.zip', type: 'application/zip' },
  'win-x64': { filename: 'SmartSell-Worker-win-x64.exe', type: 'application/octet-stream' },
};

async function openPackage(directory: string | undefined, filename: string) {
  if (!directory) return;
  const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(error.code ?? '')) throw error;
    });
  if (!file) return;
  try {
    const stat = await file.stat();
    if (stat.isFile() && stat.size > 0) return { file, size: stat.size };
  } catch (error) {
    await file.close();
    throw error;
  }
  await file.close();
}

export function registerWorkerDownloads(app: FastifyInstance, directory: string | undefined,
  requireSession: (request: FastifyRequest) => Promise<unknown>) {
  app.get(route, async request => {
    await requireSession(request);
    const available = await Promise.all(Object.entries(packages).map(async ([platform, { filename }]) => {
      const opened = await openPackage(directory, filename);
      if (!opened) return;
      await opened.file.close();
      return { platform, filename, url: `${route}/${platform}` };
    }));
    return { data: available.filter(Boolean) };
  });
  app.get<{ Params: { platform: string } }>(`${route}/:platform`, async (request, reply) => {
    await requireSession(request);
    const platform = request.params.platform;
    const pkg = Object.hasOwn(packages, platform) ? packages[platform as keyof typeof packages] : undefined;
    const opened = pkg && await openPackage(directory, pkg.filename);
    if (!opened) return reply.callNotFound();
    return reply.type(pkg.type)
      .header('content-disposition', `attachment; filename="${pkg.filename}"`)
      .header('content-length', opened.size)
      .send(opened.file.createReadStream());
  });
}
