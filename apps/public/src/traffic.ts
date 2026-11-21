import type { PublicTrafficRequest, PublicTrafficResponse } from '../../server/src/modules/traffic/operation-bridge.js';

type Dispatch = (hostname: string, input: PublicTrafficRequest, request: Request) => Promise<PublicTrafficResponse> | PublicTrafficResponse;
type Page = Extract<PublicTrafficResponse, { type: 'page' }>;
type Block = Page['blocks'][number];
const languageNames = { 'zh-Hant': '繁體中文', 'zh-Hans': '简体中文', en: 'English' } as const;
type Locale = keyof typeof languageNames;
const localeCookie = 'smartsell_traffic_lang';
const copy = {
  'zh-Hant': {
    language: '語言', market: '市場', allMarkets: '所有市場', links: '連結', chooseMarket: '選擇市場', defaultDestination: '預設目的地',
    expired: '部分連結已到期。', delisted: '部分商品已下架。', empty: '目前沒有可用連結。',
    service: '服務聯絡', marketing: '行銷訂閱', submit: '送出', video: '影片', unavailableForm: '表單目前無法使用。',
    fields: { name: '姓名', email: '電子郵件', phone: '電話', message: '留言' },
    prices: { '店鋪市場價格': '店鋪市場價格', '店鋪基礎價格': '店鋪基礎價格', '人工錄入': '人工錄入' },
    analytics: '分析同意', allow: '允許分析', deny: '拒絕分析',
    received: '已收到您的資料', thanks: '謝謝您的提交。',
  },
  'zh-Hans': {
    language: '语言', market: '市场', allMarkets: '所有市场', links: '链接', chooseMarket: '选择市场', defaultDestination: '默认目的地',
    expired: '部分链接已过期。', delisted: '部分商品已下架。', empty: '目前没有可用链接。',
    service: '服务联系', marketing: '营销订阅', submit: '提交', video: '视频', unavailableForm: '表单暂时无法使用。',
    fields: { name: '姓名', email: '电子邮箱', phone: '电话', message: '留言' },
    prices: { '店鋪市場價格': '店铺市场价格', '店鋪基礎價格': '店铺基础价格', '人工錄入': '手动录入' },
    analytics: '分析同意', allow: '允许分析', deny: '拒绝分析',
    received: '已收到您的信息', thanks: '感谢您的提交。',
  },
  en: {
    language: 'Language', market: 'Market', allMarkets: 'All markets', links: 'Links', chooseMarket: 'Choose a market', defaultDestination: 'Default destination',
    expired: 'Some links have expired.', delisted: 'Some products have been delisted.', empty: 'No links are currently available.',
    service: 'Service contact', marketing: 'Marketing subscriptions', submit: 'Submit', video: 'Video', unavailableForm: 'This form is currently unavailable.',
    fields: { name: 'Name', email: 'Email', phone: 'Phone', message: 'Message' },
    prices: { '店鋪市場價格': 'Store market price', '店鋪基礎價格': 'Store base price', '人工錄入': 'Manual entry' },
    analytics: 'Analytics consent', allow: 'Allow analytics', deny: 'Decline analytics',
    received: 'We received your information', thanks: 'Thank you for submitting the form.',
  },
};
const errors: Record<number, Record<Locale, readonly [title: string, detail: string]>> = {
  400: { 'zh-Hant': ['無法處理請求', '請檢查連結或表單後再試。'], 'zh-Hans': ['无法处理请求', '请检查链接或表单后重试。'], en: ['Invalid request', 'Check the link or form and try again.'] },
  403: { 'zh-Hant': ['無法提交表單', '請由原始活動頁送出資料。'], 'zh-Hans': ['无法提交表单', '请从原活动页面提交。'], en: ['Unable to submit the form', 'Submit the form from the original campaign page.'] },
  404: { 'zh-Hant': ['找不到此頁面', '請檢查連結是否正確。'], 'zh-Hans': ['找不到此页面', '请检查链接是否正确。'], en: ['Page not found', 'Check that the link is correct.'] },
  405: { 'zh-Hant': ['此頁面不支援這種請求', '請從活動頁重新開啟連結或表單。'], 'zh-Hans': ['此页面不支持这种请求', '请从活动页面重新打开链接或表单。'], en: ['Request method not allowed', 'Open the link or form from the campaign page.'] },
  409: { 'zh-Hant': ['表單已更新', '請重新開啟活動頁後再提交。'], 'zh-Hans': ['表单已更新', '请重新打开活动页面后再提交。'], en: ['The form has changed', 'Reopen the campaign page and submit the form again.'] },
  410: { 'zh-Hant': ['此連結已失效', '請向提供連結的一方索取最新連結。'], 'zh-Hans': ['此链接已失效', '请向提供链接的一方索取最新地址。'], en: ['This link is no longer available', 'Ask the sender for an updated link.'] },
  413: { 'zh-Hant': ['提交的資料過多', '請縮短留言後再試。'], 'zh-Hans': ['提交的信息过多', '请缩短留言后重试。'], en: ['The submission is too large', 'Shorten your message and try again.'] },
  415: { 'zh-Hant': ['不支援此表單格式', '請從原始活動頁提交表單。'], 'zh-Hans': ['不支持此表单格式', '请从原活动页面提交表单。'], en: ['Unsupported form format', 'Submit the form from the original campaign page.'] },
  422: { 'zh-Hant': ['無法處理這些資料', '請檢查表單欄位或連結中的選項後再試。'], 'zh-Hans': ['无法处理这些信息', '请检查表单字段或链接中的选项后重试。'], en: ['Unable to process this information', 'Check the form fields or link options and try again.'] },
  429: { 'zh-Hant': ['請稍後再試', '請等待一分鐘再重新提交。'], 'zh-Hans': ['请稍后重试', '请等待一分钟后再提交。'], en: ['Too many requests', 'Wait one minute before submitting again.'] },
  503: { 'zh-Hant': ['暫時無法提供服務', '請稍後再試。'], 'zh-Hans': ['服务暂时不可用', '请稍后重试。'], en: ['Service temporarily unavailable', 'Try again later.'] },
};
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src https:; media-src https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Content-Type': 'text/html; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'Vary': 'Accept-Language, Cookie',
  'X-Content-Type-Options': 'nosniff',
};
function escape(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
const segment = (value: string) => encodeURIComponent(value);

function supportedLocale(tag?: string | null, bareChinese: Locale = 'zh-Hans'): Locale | undefined {
  if (!tag) return;
  try {
    const { language, script, region } = new Intl.Locale(tag.trim().replaceAll('_', '-'));
    if (language === 'en') return 'en';
    if (language !== 'zh') return;
    if (script) return script === 'Hans' ? 'zh-Hans' : script === 'Hant' ? 'zh-Hant' : undefined;
    return region ? (['TW', 'HK', 'MO'].includes(region) ? 'zh-Hant' : 'zh-Hans') : bareChinese;
  } catch {
    return;
  }
}

function browserLocale(header: string): Locale | undefined {
  return header.split(',').map(range => {
    const [tag, weight] = range.trim().split(/\s*;\s*/, 2);
    const quality = weight === undefined ? 1 : Number(/^q=(\d*\.?\d+)$/i.exec(weight)?.[1]);
    return { locale: supportedLocale(tag), quality };
  }).filter(({ locale, quality }) => locale && quality > 0 && quality <= 1)
    .sort((a, b) => b.quality - a.quality)[0]?.locale;
}

function localePreference(request: Request, url: URL) {
  const selected = supportedLocale(url.searchParams.get('lang'));
  const saved = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim())
    .find(value => value.startsWith(`${localeCookie}=`))?.slice(localeCookie.length + 1);
  const locale = selected ?? supportedLocale(saved) ?? browserLocale(request.headers.get('accept-language') ?? '');
  const cookie = selected && request.method === 'GET'
    ? `${localeCookie}=${selected}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}` : undefined;
  return { locale, cookie };
}

function localizedLang(locale: string, parent: string) {
  return locale === parent ? '' : ` lang="${escape(locale)}"`;
}

function document(title: string, content: string, status: number, locale: Locale, cookie?: string, titleLocale: string = locale) {
  const lang = localizedLang(titleLocale, locale);
  const response = new Response(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title${lang}>${escape(title)}</title><link rel="stylesheet" href="/assets/traffic.css"></head><body><main><h1${lang}>${escape(title)}</h1>${content}</main></body></html>`, { status, headers });
  if (cookie) response.headers.append('Set-Cookie', cookie);
  return response;
}

export function trafficError(request: Request, status: number) {
  const { locale = 'zh-Hant', cookie } = localePreference(request, new URL(request.url));
  return errorDocument(status, locale, cookie);
}

function errorDocument(status: number, locale: Locale, cookie?: string) {
  const known = errors[status];
  const [title, detail] = (known ?? errors[503]!)[locale];
  return document(title, `<p>${escape(detail)}</p>`, known ? status : 503, locale, cookie);
}

function query(url: URL, changes: Record<string, string | undefined>) {
  const params = new URLSearchParams(url.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }
  return params.size ? `?${params}` : '';
}

function languageChoices(url: URL, locale: Locale) {
  const links = (Object.keys(languageNames) as Locale[]).map(language =>
    `<a class="action" href="${escape(query(url, { lang: language }))}" lang="${language}" hreflang="${language}"${language === locale ? ' aria-current="true"' : ''}>${languageNames[language]}</a>`);
  return `<nav aria-label="${copy[locale].language}">${links.join('')}</nav>`;
}

function cta(label: string, url: string) { return `<a class="action" href="${escape(url)}" rel="noreferrer">${escape(label)}</a>`; }
function form(page: Page, block: Extract<Block, { type: 'form' }>, locale: Locale) {
  const text = copy[locale];
  const lang = localizedLang(locale, page.locale);
  const fields = block.fields.map(field => {
    const label = escape(field.label || text.fields[field.key]);
    const labelLang = field.label ? '' : lang;
    const required = field.required ? ' required' : '';
    if (field.key === 'message') return `<label${labelLang}>${label}<textarea name="message" maxlength="4000" rows="4"${required}></textarea></label>`;
    const type = field.key === 'phone' ? 'tel' : field.key === 'email' ? 'email' : 'text';
    const autocomplete = field.key === 'phone' ? 'tel' : field.key;
    return `<label${labelLang}>${label}<input name="${field.key}" type="${type}" autocomplete="${autocomplete}" maxlength="254"${required}></label>`;
  }).join('');
  const groups = (['service','marketing'] as const).map(purpose => {
    const choices = block.choices.filter(choice => choice.key.endsWith(`:${purpose}`));
    if (!choices.length) return '';
    return `<fieldset><legend${lang}>${text[purpose]}</legend>${choices.map(choice => `<label class="choice"><input type="checkbox" name="consent" value="${escape(choice.key)}"><span>${escape(choice.label)}</span></label>`).join('')}</fieldset>`;
  }).join('');
  return `<form method="post" action="/f/${segment(block.formId)}/submit?lang=${locale}"><input type="hidden" name="slug" value="${escape(page.slug)}"><input type="hidden" name="version_id" value="${escape(page.versionId)}"><input type="hidden" name="form_version_id" value="${escape(block.formVersionId)}">${fields}${groups}<button type="submit"${lang}>${text.submit}</button></form>`;
}
function blockHtml(page: Page, block: Block, locale: Locale) {
  const text = copy[locale];
  const lang = localizedLang(locale, page.locale);
  let content: string;
  switch (block.type) {
    case 'text': content = `<p>${escape(block.text)}</p>`; break;
    case 'cta': content = cta(block.label, block.url); break;
    case 'product': {
      const source = block.price_source_label;
      const label = source && Object.hasOwn(text.prices, source) ? text.prices[source as keyof typeof text.prices] : source;
      content = `${block.price == null ? '' : `<p>${escape(block.price)}<small${lang}>${escape(label)} · <time datetime="${escape(block.observed_at)}">${escape(block.observed_at)}</time></small></p>`}${cta(block.label, block.url)}`;
      break;
    }
    case 'image': content = `<img loading="lazy" src="${escape(block.url)}" alt="${escape(block.alt)}">`; break;
    case 'video': {
      const label = block.alt || block.title;
      content = `<video controls playsinline preload="none" src="${escape(block.url)}" aria-label="${escape(label || text.video)}"${label ? '' : lang}></video>`;
      break;
    }
    case 'faq': content = block.entries.map(entry => `<details><summary>${escape(entry.question)}</summary><p>${escape(entry.answer)}</p></details>`).join(''); break;
    case 'form': content = form(page, block, locale); break;
    case 'unavailable': content = `<p${lang}>${text.unavailableForm}</p>`; break;
  }
  return `<section${localizedLang(page.locale, locale)}>${block.title ? `<h2>${escape(block.title)}</h2>` : ''}${content}</section>`;
}

function bioDocument(result: Extract<PublicTrafficResponse, { type: 'bio' }>, url: URL, locale: Locale, cookie?: string) {
  const text = copy[locale];
  const markets = result.markets.length ? `<nav aria-label="${text.market}">${cta(text.allMarkets, query(url, { market: undefined }) || '?')}${result.markets.map(key => cta(key, query(url, { market: key }))).join('')}</nav>` : '';
  const links = `<nav aria-label="${text.links}">${result.entries.map(entry => cta(entry.label, entry.path)).join('')}</nav>`;
  const expired = result.notices.expired ? `<p>${text.expired}</p>` : '';
  const delisted = result.notices.delisted ? `<p>${text.delisted}</p>` : '';
  const empty = result.entries.length ? '' : `<p>${text.empty}</p>`;
  return document(result.title, languageChoices(url, locale) + markets + links + expired + delisted + empty, 200, locale, cookie);
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
    const { locale: preferred, cookie } = localePreference(request, url);
    const locale = preferred ?? 'zh-Hant';
    const text = copy[locale];
    const expected = formMatch ? 'POST' : 'GET';
    if (request.method !== expected) {
      const response = errorDocument(405, locale, cookie);
      response.headers.set('Allow', expected);
      return response;
    }
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
        if (request.headers.get('origin') !== url.origin) return errorDocument(403, locale);
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
        case 'market_choice': return document(text.chooseMarket, languageChoices(url, locale) + `<nav aria-label="${text.market}">${cta(text.defaultDestination, query(url, { market: 'default' }))}${result.choices.map(choice => cta(choice.label, query(url, { market: choice.market_id }))).join('')}</nav>`, 200, locale, cookie);
        case 'bio': return bioDocument(result, url, locale, cookie);
        case 'page': {
          const uiLocale = preferred ?? supportedLocale(result.locale, 'zh-Hant') ?? 'zh-Hant';
          const ui = copy[uiLocale];
          const content = result.blocks.map(block => blockHtml(result, block, uiLocale)).join('');
          const consent = analyticsConsent?.();
          const action = `/p/${segment(result.slug)}${url.search}`;
          const choice = analyticsConsent ? `<section><h2>${ui.analytics}</h2><form method="post" action="${escape(action)}"><button name="analytics" value="allow"${consent === true ? ' disabled' : ''}>${ui.allow}</button> <button name="analytics" value="deny"${consent === false ? ' disabled' : ''}>${ui.deny}</button></form></section>` : '';
          const response = document(result.title, languageChoices(url, uiLocale) + content + choice, 200, uiLocale, cookie, result.locale);
          // With no-referrer, Chromium sends Origin: null on native form POSTs.
          if (analyticsConsent || result.blocks.some(block => block.type === 'form')) response.headers.set('Referrer-Policy', 'same-origin');
          return response;
        }
        case 'submit': return document(text.received, `<p>${text.thanks}</p>`, 200, locale);
        default: return errorDocument(404, locale, cookie);
      }
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      return errorDocument(status ?? 503, locale, cookie);
    }
  };
}
