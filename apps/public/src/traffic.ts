import type { PublicTrafficRequest, PublicTrafficResponse } from '../../server/src/modules/traffic/operation-bridge.js';

type Dispatch = (hostname: string, input: PublicTrafficRequest, request: Request) => Promise<PublicTrafficResponse> | PublicTrafficResponse;
type Page = Extract<PublicTrafficResponse, { type: 'page' }>;
type Block = Page['blocks'][number];
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src https:; media-src https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Content-Type': 'text/html; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
function escape(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
const segment = (value: string) => encodeURIComponent(value);
function document(title: string, content: string, status = 200, locale = 'zh-Hant') {
  return new Response(`<!doctype html><html lang="${escape(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/assets/traffic.css"></head><body><main><h1>${escape(title)}</h1>${content}</main></body></html>`, { status, headers });
}
function cta(label: string, url: string) { return `<a class="action" href="${escape(url)}" rel="noreferrer">${escape(label)}</a>`; }
function form(page: Page, block: Extract<Block, { type: 'form' }>) {
  const fields = block.fields.map(field => {
    const label = escape(field.label);
    const required = field.required ? ' required' : '';
    if (field.key === 'message') return `<label>${label}<textarea name="message" maxlength="4000" rows="4"${required}></textarea></label>`;
    const type = field.key === 'phone' ? 'tel' : field.key === 'email' ? 'email' : 'text';
    const autocomplete = field.key === 'phone' ? 'tel' : field.key;
    return `<label>${label}<input name="${field.key}" type="${type}" autocomplete="${autocomplete}" maxlength="254"${required}></label>`;
  }).join('');
  const groups = ['service','marketing'].map(purpose => {
    const choices = block.choices.filter(choice => choice.key.endsWith(`:${purpose}`));
    if (!choices.length) return '';
    return `<fieldset><legend>${purpose === 'service' ? '服務聯絡' : '行銷訂閱'}</legend>${choices.map(choice => `<label class="choice"><input type="checkbox" name="consent" value="${escape(choice.key)}"><span>${escape(choice.label)}</span></label>`).join('')}</fieldset>`;
  }).join('');
  return `<form method="post" action="/f/${segment(block.formId)}/submit"><input type="hidden" name="slug" value="${escape(page.slug)}"><input type="hidden" name="version_id" value="${escape(page.versionId)}"><input type="hidden" name="form_version_id" value="${escape(block.formVersionId)}">${fields}${groups}<button type="submit">送出</button></form>`;
}
function blockHtml(page: Page, block: Block) {
  let content: string;
  switch (block.type) {
    case 'text': content = `<p>${escape(block.text)}</p>`; break;
    case 'cta': content = cta(block.label, block.url); break;
    case 'product': content = `${block.price == null ? '' : `<p>${escape(block.price)}<small>${escape(block.price_source_label)} · <time datetime="${escape(block.observed_at)}">${escape(block.observed_at)}</time></small></p>`}${cta(block.label, block.url)}`; break;
    case 'image': content = `<img loading="lazy" src="${escape(block.url)}" alt="${escape(block.alt)}">`; break;
    case 'video': content = `<video controls playsinline preload="none" src="${escape(block.url)}" aria-label="${escape(block.alt || block.title || '影片')}"></video>`; break;
    case 'faq': content = block.entries.map(entry => `<details><summary>${escape(entry.question)}</summary><p>${escape(entry.answer)}</p></details>`).join(''); break;
    case 'form': content = form(page, block); break;
    case 'unavailable': content = '<p>表單目前無法使用。</p>'; break;
  }
  return `<section>${block.title ? `<h2>${escape(block.title)}</h2>` : ''}${content}</section>`;
}

function bioDocument(result: Extract<PublicTrafficResponse, { type: 'bio' }>, url: URL, market?: string) {
  const locale = url.searchParams.get('lang') === 'en' ? 'en' : 'zh-Hant';
  const en = locale === 'en';
  const choice = (language: string, selectedMarket?: string) => {
    const query = new URLSearchParams({ lang: language });
    if (selectedMarket) query.set('market', selectedMarket);
    return `?${query}`;
  };
  const languages = `<nav aria-label="${en ? 'Language' : '語言'}">${cta('繁體中文', choice('zh-Hant', market))}${cta('English', choice('en', market))}</nav>`;
  const markets = result.markets.length ? `<nav aria-label="${en ? 'Market' : '市場'}">${cta(en ? 'All markets' : '所有市場', choice(locale))}${result.markets.map(key => cta(key, choice(locale, key))).join('')}</nav>` : '';
  const links = `<nav aria-label="${en ? 'Links' : '連結'}">${result.entries.map(entry => cta(entry.label, entry.path)).join('')}</nav>`;
  const expired = result.notices.expired ? `<p>${en ? 'Some links have expired.' : '部分連結已到期。'}</p>` : '';
  const delisted = result.notices.delisted ? `<p>${en ? 'Some products have been delisted.' : '部分商品已下架。'}</p>` : '';
  const empty = result.entries.length ? '' : `<p>${en ? 'No links are currently available.' : '目前沒有可用連結。'}</p>`;
  return document(result.title, languages + markets + links + expired + delisted + empty, 200, locale);
}

async function submission(request: Request): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type') ?? '')) throw { status: 415 };
  const reader = request.body?.getReader();
  if (!reader) throw { status: 400 };
  const decoder = new TextDecoder();
  let length = 0;
  let value = '';
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > 64 * 1024) {
      await reader.cancel();
      throw { status: 413 };
    }
    value += decoder.decode(part.value, { stream: true });
  }
  return new URLSearchParams(value + decoder.decode());
}

/** Core supplies the host registry, scoped transaction, secrets and rate limiting. */
export function createPublicTrafficHandler(dispatch: Dispatch, resolveVisitor?: (request: Request) => Extract<PublicTrafficRequest, { type: 'page' }>['visitor'], analyticsConsent?: () => boolean | undefined) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const pageMatch = /^\/p\/([a-z0-9_-]+)\/?$/i.exec(path);
    const bioMatch = /^\/b\/([a-z0-9_-]+)\/?$/i.exec(path);
    const formMatch = /^\/f\/([a-z0-9_-]+)\/submit\/?$/i.exec(path);
    const linkMatch = /^\/([a-z0-9][a-z0-9_-]{0,79}|[_-][a-z0-9_-]{31})\/?$/i.exec(path);
    if (!pageMatch && !bioMatch && !formMatch && !linkMatch) return undefined;
    if (linkMatch && ['api','assets','health','p','b','f','landing','unsubscribe'].includes(linkMatch[1]!.toLowerCase())) return undefined;
    const expected = formMatch ? 'POST' : 'GET';
    if (request.method !== expected) return new Response(null, { status: 405, headers: { Allow: expected, 'Cache-Control': 'no-store' } });
    const hostname = url.hostname;
    const market = url.searchParams.get('market') || undefined;
    try {
      let result: PublicTrafficResponse;
      if (pageMatch) {
        const visitor = resolveVisitor?.(request);
        result = await dispatch(hostname, { type: 'page', slug: pageMatch[1]!, ...(visitor ? { visitor } : {}) }, request);
      }
      else if (bioMatch) result = await dispatch(hostname, { type: 'bio', hostname, handle: bioMatch[1]!, ...(market ? { market } : {}) }, request);
      else if (formMatch) {
        if (request.headers.get('origin') !== url.origin) return document('無法提交表單', '<p>請由原始活動頁送出資料。</p>', 403);
        const body = await submission(request);
        const fields = Object.fromEntries(['name','email','phone','message'].flatMap(key => body.has(key) ? [[key, body.get(key)]] : []));
        const visitor = resolveVisitor?.(request);
        result = await dispatch(hostname, { type: 'submit', formId: formMatch[1]!, slug: body.get('slug') ?? '', versionId: body.get('version_id') ?? '',
          body: { form_version_id: body.get('form_version_id'), fields, consents: body.getAll('consent') }, ...(visitor ? { visitor } : {}) }, request);
      } else result = await dispatch(hostname, { type: 'redirect', hostname, code: linkMatch![1]!, ...(market ? { market } : {}),
        userAgent: request.headers.get('user-agent') ?? '', purpose: request.headers.get('sec-purpose') ?? request.headers.get('purpose') ?? '',
        navigation: request.headers.get('sec-fetch-mode') === 'navigate' && request.headers.get('sec-fetch-user') === '?1' }, request);
      switch (result.type) {
        case 'redirect': return new Response(null, { status: 302, headers: { Location: result.location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
        case 'market_choice': return document('選擇市場', `<nav>${cta('預設目的地', '?market=default')}${result.choices.map(choice => cta(choice.label, `?market=${segment(choice.market_id)}`)).join('')}</nav>`);
        case 'bio': return bioDocument(result, url, market);
        case 'page': {
          const content = result.blocks.map(block => blockHtml(result, block)).join('');
          const en = result.locale.startsWith('en');
          const consent = analyticsConsent?.();
          const choice = analyticsConsent ? `<section><h2>${en ? 'Analytics consent' : '分析同意'}</h2><form method="post" action="/p/${segment(result.slug)}"><button name="analytics" value="allow"${consent === true ? ' disabled' : ''}>${en ? 'Allow analytics' : '允許分析'}</button> <button name="analytics" value="deny"${consent === false ? ' disabled' : ''}>${en ? 'Decline analytics' : '拒絕分析'}</button></form></section>` : '';
          const response = document(result.title, content + choice, 200, result.locale);
          // With no-referrer, Chromium sends Origin: null on native form POSTs.
          if (analyticsConsent || result.blocks.some(block => block.type === 'form')) response.headers.set('Referrer-Policy', 'same-origin');
          return response;
        }
        case 'submit': return document('已收到您的資料', '<p>謝謝您的提交。</p>');
        default: return document('找不到此頁面', '', 404);
      }
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      if (status === 404 || status === 410) return document('此頁面目前無法使用', '', status);
      if (status === 409 || status === 422 || status === 400 || status === 413 || status === 415) return document('無法提交或開啟此頁面', '<p>請返回上一頁，重新整理後再試。</p>', status);
      if (status === 429) return document('請稍後再試', '', 429);
      return document('暫時無法提供服務', '', 503);
    }
  };
}