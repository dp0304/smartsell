import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { api, ApiError, recordOptions, type Command, type Entity, type Payload } from './workbench-api';
import { asEntity, has, useCommandRead } from './workbench-data';
import { Failure, recordName, useFormat } from './workbench-ui';
import { findOperation, recordRows, rowTitle, useApi, useRead, wsKey } from './api';

const formats: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', m4a: 'audio/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  vtt: 'text/vtt', srt: 'application/x-subrip', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
};
const allowedTypes = new Set([...Object.values(formats), 'audio/webm']);
const maxBytes = 512 * 1024 * 1024;
const assetCreate = { module: 'asset', action: 'asset_create' };
const filesPath = (wid: string) => `/api/v1/workspaces/${encodeURIComponent(wid)}/files`;
const filePath = (wid: string, id: string) => `${filesPath(wid)}/${encodeURIComponent(id)}`;

function responseError(status: number, body: { error?: { code?: string; message?: string }; detail?: string } | null) {
  return new ApiError(status, body?.error?.code ?? 'http_error', body?.error?.message ?? body?.detail ?? '');
}

async function json<T>(path: string, signal: AbortSignal, write?: { body: Payload; csrf: string; key: string }): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  if (write) {
    headers.set('Content-Type', 'application/json');
    headers.set('X-CSRF-Token', write.csrf);
    headers.set('Idempotency-Key', write.key);
  }
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store', signal, headers,
    ...(write && { method: 'POST', body: JSON.stringify(write.body) }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw responseError(response.status, body);
  if (!body) throw new ApiError(response.status, 'invalid_response', '');
  return body as T;
}

function uploadBytes(path: string, file: File, csrf: string, key: string, signal: AbortSignal, progress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) progress(Math.floor(100 * event.loaded / event.total));
    };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(responseError(xhr.status, xhr.response));
    xhr.onerror = xhr.ontimeout = () => reject(new ApiError(0, 'upload_failed', ''));
    xhr.onabort = () => reject(signal.reason);
    xhr.onloadend = () => signal.removeEventListener('abort', abort);
    xhr.open('PUT', path);
    xhr.responseType = 'json';
    xhr.timeout = 10 * 60_000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-CSRF-Token', csrf);
    xhr.setRequestHeader('Idempotency-Key', key);
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(file);
  });
}

const copy = {
  heading: ['上傳素材', 'Upload media'], file: ['素材檔案', 'Media file'], brand: ['品牌', 'Brand'], title: ['素材名稱', 'Asset title'],
  noBrands: ['請先在工作區設定中建立品牌。', 'Create a brand in Workspace settings before uploading.'],
  invalidFile: ['請選擇支援的非空白檔案，大小上限為 512 MiB。', 'Choose a supported, non-empty file up to 512 MiB.'],
  preparing: ['正在準備檔案…', 'Preparing file…'], uploading: ['正在上傳檔案…', 'Uploading file…'],
  verifying: ['正在驗證檔案…', 'Verifying file…'], saving: ['正在儲存素材…', 'Saving asset…'],
  saved: ['已新增至素材庫', 'Added to the asset library'], reset: ['選擇其他檔案', 'Choose another file'], retry: ['重試', 'Retry'],
  preview: ['預覽', 'Preview'], download: ['下載檔案', 'Download file'],
  previewError: ['無法顯示預覽。', 'The browser could not display the preview.'],
  loading: ['載入中…', 'Loading…'], select: ['請選擇…', 'Select…'], error: ['操作失敗。', 'The request failed.'],
} as const;
function useMediaCopy() {
  const { locale, t } = useFormat();
  return { t, text: (key: keyof typeof copy) => copy[key][locale === 'en' ? 1 : 0] };
}

function MediaFailure({ error, retry }: { error: unknown; retry?: () => void }) {
  const { text } = useMediaCopy();
  return <div role="alert"><strong>{text('error')}</strong>
    {error instanceof Error && error.message && <p>{error.message}</p>}
    {retry && <button type="button" onClick={retry}>{text('retry')}</button>}
  </div>;
}

type Phase = 'preparing' | 'uploading' | 'verifying' | 'saving';
type Reservation = { id: string; expires_at: string };
type Attempt = {
  beginKey: string;
  bytesKey: string;
  completeKey: string;
  assetKey: string;
  sha?: string;
  reservation?: Reservation;
  staged?: boolean;
  fileId?: string;
};
const newAttempt = (): Attempt => ({
  beginKey: crypto.randomUUID(), bytesKey: crypto.randomUUID(), completeKey: crypto.randomUUID(), assetKey: crypto.randomUUID(),
});

type Media = { fileId: string; mime: string; thumbnailId?: string };
function versionMedia(row?: Entity): Media | undefined {
  const data = row?.data;
  if (typeof data?.file_object_id !== 'string' || typeof data.mime_type !== 'string') return;
  return { fileId: data.file_object_id, mime: data.mime_type,
    thumbnailId: typeof data.thumbnail_file_id === 'string' ? data.thumbnail_file_id : undefined };
}

function useDownloadLink(wid: string, id?: string) {
  return useQuery({
    queryKey: ['workspace', wid, 'media-link', id], enabled: Boolean(id), gcTime: 0, retry: false, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const path = filePath(wid, id!);
      const { data } = await json<{ data: { url: string } }>(`${path}/download?inline=true`, signal);
      const url = new URL(data.url, window.location.origin);
      if (url.origin !== window.location.origin || url.pathname !== `${path}/bytes`) throw new ApiError(200, 'invalid_response', '');
      return url.href;
    },
  });
}

function MediaPreview({ wid, media, title, thumbnail = false }: { wid: string; media: Media; title: string; thumbnail?: boolean }) {
  const { text } = useMediaCopy();
  const image = media.mime.startsWith('image/');
  const video = media.mime.startsWith('video/');
  const audio = media.mime.startsWith('audio/');
  const file = useDownloadLink(wid, thumbnail && image ? media.thumbnailId ?? media.fileId : media.fileId);
  const poster = useDownloadLink(wid, video ? media.thumbnailId : undefined);
  const [failedUrl, setFailedUrl] = useState<string>();
  const url = file.data;
  const refresh = async () => {
    await Promise.all([file.refetch(), ...(video && media.thumbnailId ? [poster.refetch()] : [])]);
    setFailedUrl(undefined);
  };
  const retry = () => void refresh();
  if (file.isError) return <MediaFailure error={file.error} retry={retry} />;
  if (!url) return <p role="status">{text('loading')}</p>;
  return <div>
    {failedUrl === url ? <div role="alert">{text('previewError')} <button type="button" onClick={retry}>{text('retry')}</button></div>
      : image ? <img src={url} alt={title} style={{ display: 'block', maxWidth: thumbnail ? 160 : '100%', maxHeight: thumbnail ? 100 : 320, objectFit: 'contain' }} onError={() => setFailedUrl(url)} />
      : video ? <video src={url} poster={poster.data} aria-label={title} controls preload="metadata" style={{ display: 'block', maxWidth: '100%', maxHeight: 320 }} onError={() => setFailedUrl(url)} />
      : audio ? <audio src={url} aria-label={title} controls preload="metadata" onError={() => setFailedUrl(url)} />
      : <a href={url} download>{text('download')}</a>}
  </div>;
}

export function WorkbenchAssetPreview({ wid, asset, commands }: { wid: string; asset: Entity; commands: Command[] }) {
  const { t, text } = useMediaCopy();
  const detail = useCommandRead<{ asset: Entity; versions: Entity[] }>(wid, commands, 'asset', 'asset_get', { asset_id: asset.id });
  const current = detail.data?.versions.find(row => row.id === detail.data?.asset.data.current_version_id);
  const media = versionMedia(current);
  if (!detail.permitted || (!detail.isPending && !detail.isError && !media)) return null;
  return <section>
    <h3>{text('preview')}</h3>
    {detail.isError ? <Failure error={detail.error} retry={() => void detail.refetch()} />
      : media ? <MediaPreview key={media.fileId} wid={wid} media={media} title={recordName(asset)} /> : <p role="status">{t('ui.loading')}</p>}
  </section>;
}

export function WorkbenchMediaUpload({ wid, commands }: { wid: string; commands: Command[] }) {
  const permitted = has(commands, assetCreate.module, assetCreate.action);
  const brands = useQuery({ ...recordOptions(wid, 'workspace', 'brand'), enabled: permitted });
  if (!permitted) return null;
  return <MediaUploadForm wid={wid} brands={{ ...brands, data: brands.data?.map(row => ({ id: row.id, name: recordName(row) })) }}
    saveAsset={(body, key, signal) => api.execute(wid, assetCreate, body, key, signal)}
    assetListKey={['workspace', wid, 'records', 'asset', 'asset']} />;
}

export function OperationMediaUpload() {
  const workspace = useApi();
  const brands = useRead('/brands');
  const assetSearch = findOperation(workspace, 'GET', '/assets');
  if (!brands.op || !assetSearch || !findOperation(workspace, 'POST', '/assets') || !findOperation(workspace, 'POST', '/files/uploads')) return null;
  return <MediaUploadForm wid={workspace.ws} operation brands={{ ...brands, data: recordRows(brands.data?.data)?.flatMap(row =>
    typeof row.id === 'string' ? [{ id: row.id, name: rowTitle(row) }] : []) }}
    saveAsset={async (body, key, signal, csrf) => (await json<{ data: unknown }>(`/api/v1/workspaces/${encodeURIComponent(workspace.ws)}/assets`, signal, { body, key, csrf })).data}
    assetListKey={[...wsKey(workspace.ws), 'read', assetSearch.name]} />;
}

export function OperationAssetPreview({ record }: { record: Payload }) {
  const { ws } = useApi();
  const current = recordRows(record.versions)?.find(row => row.id === record.current_version_id);
  const media = versionMedia(asEntity(current, 'asset', 'asset_version'));
  if (!media) return null;
  const thumbnail = recordRows(record.renditions)?.find(row =>
    row.asset_version_id === current?.id && row.kind === 'thumbnail' && row.status === 'ready');
  if (!media.thumbnailId && typeof thumbnail?.file_object_id === 'string') media.thumbnailId = thumbnail.file_object_id;
  return <MediaPreview key={media.fileId} wid={ws} media={media} title={rowTitle(record)} />;
}

type Brands = { data?: { id: string; name: string }[]; isError: boolean; isPending: boolean; error: unknown; refetch: () => Promise<unknown> };
function MediaUploadForm({ wid, brands, saveAsset, assetListKey, operation = false }: {
  wid: string;
  brands: Brands;
  saveAsset: (body: Payload, key: string, signal: AbortSignal, csrf: string) => Promise<unknown>;
  assetListKey: string[];
  operation?: boolean;
}) {
  const { text } = useMediaCopy();
  const client = useQueryClient();
  const [brand, setBrand] = useState('');
  const [file, setFile] = useState<File>();
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState<Phase>();
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState<{ media: Media; title: string }>();
  const attempt = useRef<Attempt | undefined>(undefined);
  const active = useRef<AbortController | undefined>(undefined);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => () => active.current?.abort(), []);
  const brandId = brand || (brands.data?.length === 1 ? brands.data[0].id : '');

  function choose(next?: File) {
    setFile(next);
    setTitle(next ? Array.from(next.name).slice(0, 250).join('') : '');
    setError(undefined);
    setSaved(undefined);
    attempt.current = undefined;
    if (!next && picker.current) picker.current.value = '';
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (active.current || !file || !brandId || !title.trim()) return;
    const mime = allowedTypes.has(file.type) ? file.type : formats[file.name.split('.').at(-1)?.toLowerCase() ?? ''];
    if (!mime || !file.size || file.size > maxBytes) {
      setError(new ApiError(422, 'invalid_file', text('invalidFile')));
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    const { signal } = controller;
    const job = attempt.current ??= newAttempt();
    setError(undefined);
    try {
      setPhase(job.fileId ? 'saving' : 'preparing');
      const { csrf_token: csrf } = await json<{ csrf_token: string }>('/api/v1/session/csrf', signal);
      if (!job.fileId) {
        if (!job.sha) {
          const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
          signal.throwIfAborted();
          job.sha = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        }
        const uploads = `${filesPath(wid)}/uploads`;
        if (!job.reservation) {
          const name = file.name.trim();
          const original_filename = name && new TextEncoder().encode(name).length <= 255 && !/[\p{Cc}\p{Cf}\\/]/u.test(name) ? name : undefined;
          const { data } = await json<{ data: Reservation }>(uploads, signal, { csrf, key: job.beginKey, body: {
            purpose: 'asset', mime_type: mime, size_bytes: file.size, sha256: job.sha, original_filename,
          } });
          if (!data?.id) throw new ApiError(200, 'invalid_response', '');
          job.reservation = data;
        }
        const url = `${uploads}/${encodeURIComponent(job.reservation.id)}`;
        if (!job.staged) {
          setProgress(0);
          setPhase('uploading');
          await uploadBytes(`${url}/bytes`, file, csrf, job.bytesKey, signal, setProgress);
          job.staged = true;
        }
        setPhase('verifying');
        const { data } = await json<{ data: { id: string } }>(`${url}/complete`, signal, { csrf, key: job.completeKey, body: {} });
        if (!data?.id) throw new ApiError(200, 'invalid_response', '');
        job.fileId = data.id;
      }
      setPhase('saving');
      const type = mime.split('/')[0];
      const kind = ['image', 'video', 'audio'].includes(type) ? type : ['text/vtt', 'application/x-subrip'].includes(mime) ? 'subtitle' : 'document';
      const result = await saveAsset({ brand_id: brandId, title: title.trim(), kind, file_object_id: job.fileId }, job.assetKey, signal, csrf) as { version?: unknown; asset_version?: unknown };
      signal.throwIfAborted();
      setSaved({ title: title.trim(), media: versionMedia(asEntity(result?.asset_version ?? result?.version, 'asset', 'asset_version')) ?? { fileId: job.fileId, mime } });
      void client.invalidateQueries({ queryKey: assetListKey });
    } catch (failure) {
      if (signal.aborted) return;
      if (!job.fileId && job.reservation && failure instanceof ApiError && failure.status === 404 && Date.parse(job.reservation.expires_at) <= Date.now()) {
        attempt.current = { ...newAttempt(), sha: job.sha };
      }
      setError(failure);
    } finally {
      active.current = undefined;
      if (!signal.aborted) setPhase(undefined);
    }
  }

  return <section className={operation ? 'panel detail-body' : 'wb-card'}>
    <h2>{text('heading')}</h2>
    <form className={operation ? 'fields' : 'wb-form wb-note'} onSubmit={submit}>
      {brands.isError && <MediaFailure error={brands.error} retry={() => void brands.refetch()} />}
      {brands.isPending && <p role="status">{text('loading')}</p>}
      {brands.data?.length === 0 && <p>{text('noBrands')}</p>}
      <fieldset disabled={Boolean(phase || saved) || !brands.data?.length}>
        <label className="field">{text('brand')}<select required value={brandId} disabled={Boolean(attempt.current)} onChange={event => setBrand(event.target.value)}>
          <option value="">{text('select')}</option>{brands.data?.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select></label>
        <label className="field">{text('file')}<input ref={picker} type="file" required accept={[...allowedTypes, ...Object.keys(formats).map(ext => `.${ext}`)].join(',')} onChange={event => choose(event.target.files?.[0])} /></label>
        <label className="field">{text('title')}<input value={title} required maxLength={250} disabled={Boolean(attempt.current)} onChange={event => setTitle(event.target.value)} /></label>
        <div className={operation ? 'action-row' : 'wb-inline-actions'}>
          <button className={operation ? 'primary' : 'wb-primary'} type="submit" disabled={!file || !brandId || !title.trim()}><Upload size={16} aria-hidden="true" />{error && attempt.current ? text('retry') : text('heading')}</button>
          {error != null && attempt.current && <button type="button" onClick={() => choose()}>{text('reset')}</button>}
        </div>
      </fieldset>
      {phase && <p role="status">{text(phase)}</p>}
      {phase === 'uploading' && <progress value={progress} max={100} aria-label={text('uploading')} />}
      {error != null && <MediaFailure error={error} />}
      {saved && <div>
        <p role="status">{text('saved')} · {saved.title}</p>
        <MediaPreview wid={wid} media={saved.media} title={saved.title} thumbnail />
        <button type="button" onClick={() => choose()}>{text('reset')}</button>
      </div>}
    </form>
  </section>;
}
