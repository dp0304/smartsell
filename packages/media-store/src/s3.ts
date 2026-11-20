import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { objectKey, ObjectMissing, StorageFailure, type Storage } from './storage.js';

export type S3Transport = (url: URL, request: RequestInit & { duplex?: 'half' }) => Promise<Response>;
export interface S3Options {
  endpoint: string;
  publicEndpoint?: string;
  bucket: string;
  region?: string;
  accessKey: string;
  secretKey: string;
  transport?: S3Transport;
  now?: () => Date;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const query = (values: Record<string, string>) => Object.keys(values).sort().map(key => `${encode(key)}=${encode(values[key])}`).join('&');

function origin(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.href !== `${url.origin}/` || url.username || url.password) throw new Error('Invalid S3 endpoint');
  return url.origin;
}

export function s3Storage(options: S3Options): Storage {
  const endpoint = origin(options.endpoint);
  const publicEndpoint = options.publicEndpoint ? origin(options.publicEndpoint) : endpoint;
  const { bucket, accessKey, secretKey, region = 'us-east-1', transport = fetch, now = () => new Date() } = options;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[\w.-]+$/.test(region) || !accessKey || !secretKey) {
    throw new Error('Invalid S3 configuration');
  }
  const urlFor = (host: string, key: string) => new URL(`/${bucket}/${objectKey(key)}`, host);

  function signature(method: string, url: URL, headers: Record<string, string>, payload: string, expires?: number) {
    const timestamp = now().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = timestamp.slice(0, 8);
    const scope = `${day}/${region}/s3/aws4_request`;
    const algorithm = 'AWS4-HMAC-SHA256';
    const credential = `${accessKey}/${scope}`;
    const canonicalHeaders: Record<string, string> = { ...headers, host: url.host };
    if (expires === undefined) {
      canonicalHeaders['x-amz-date'] = timestamp;
      canonicalHeaders['x-amz-content-sha256'] = payload;
    }
    const names = Object.keys(canonicalHeaders).sort();
    const signedHeaders = names.join(';');
    const values: Record<string, string> = expires === undefined ? {} : {
      'X-Amz-Algorithm': algorithm, 'X-Amz-Credential': credential, 'X-Amz-Date': timestamp,
      'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': signedHeaders,
    };
    const canonical = [method, url.pathname, query(values), names.map(name => `${name}:${canonicalHeaders[name]}\n`).join(''), signedHeaders, payload].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'), 'aws4_request');
    const signed = hmac(key, [algorithm, timestamp, scope, sha(canonical)].join('\n')).toString('hex');
    if (expires !== undefined) {
      url.search = query({ ...values, 'X-Amz-Signature': signed });
      return headers;
    }
    const { host: _host, ...requestHeaders } = canonicalHeaders;
    return { ...requestHeaders, authorization: `${algorithm} Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signed}` };
  }

  async function send(method: string, key: string, headers: Record<string, string> = {}, hash = sha(''), body?: Readable) {
    const url = urlFor(endpoint, key);
    try {
      return await transport(url, {
        method, headers: signature(method, url, headers, hash), redirect: 'error',
        signal: AbortSignal.timeout(120_000), ...(body && { body: Readable.toWeb(body) as unknown as BodyInit, duplex: 'half' }),
      });
    } catch {
      body?.destroy();
      throw new StorageFailure('S3 request failed');
    }
  }

  async function check(response: Response, expected: number, missing = false) {
    if (response.status === expected) return;
    await response.body?.cancel();
    if (missing && response.status === 404) throw new ObjectMissing();
    throw new StorageFailure('S3 request rejected');
  }

  return {
    bucket,
    presignUpload(key, size, expires) {
      if (objectKey(key).split('/')[4] !== 'staging' || !Number.isSafeInteger(size) || size < 1 || !Number.isInteger(expires) || expires < 1 || expires > 900) {
        throw new StorageFailure('Invalid S3 upload signature parameters');
      }
      const url = urlFor(publicEndpoint, key);
      signature('PUT', url, { 'content-length': String(size) }, 'UNSIGNED-PAYLOAD', expires);
      // The browser supplies the signed content-length itself when sending a Blob.
      return { url: url.href, method: 'PUT', headers: {} };
    },
    async read(key, range) {
      const response = await send('GET', key, range ? { range: `bytes=${range.start}-${range.end}` } : {});
      await check(response, range ? 206 : 200, true);
      const length = response.headers.get('content-length');
      const contentRange = response.headers.get('content-range');
      const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      const size = range ? Number(match?.[3]) : Number(length);
      if (!response.body || !length || !/^\d+$/.test(length) || !Number.isSafeInteger(size) || size < 1 ||
        response.headers.has('content-encoding') || (range && (Number(match?.[1]) !== range.start || Number(match?.[2]) !== range.end || Number(length) !== range.end - range.start + 1))) {
        await response.body?.cancel();
        throw new StorageFailure('Invalid S3 response');
      }
      return { stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), size };
    },
    async write(key, object) {
      const response = await send('PUT', key, { 'content-length': String(object.size), 'content-type': object.mime }, object.sha256, createReadStream(object.path));
      await check(response, 200);
      await response.body?.cancel();
    },
    async remove(key) {
      const response = await send('DELETE', key);
      await check(response, 204);
      await response.body?.cancel();
    },
  };
}
