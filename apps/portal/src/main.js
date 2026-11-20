import { fetchPortal, localSignInPath, routeFor } from './api.js';
import { messages } from './i18n.js';

const main = document.querySelector('#main');
const picker = document.querySelector('#language');
const route = routeFor(location.pathname, location.hash);
if (route.token) history.replaceState(null, '', location.pathname);
const login = localSignInPath(document.querySelector('meta[name="portal-login"]')?.content);
const savedLocale = localStorage.getItem('portal-locale');
picker.value = savedLocale === 'en' ? 'en' : 'zh-Hant';
let revision = 0;

const t = key => messages[picker.value][key];
const date = value => new Intl.DateTimeFormat(picker.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

function node(tag, value, attributes = {}) {
  const item = document.createElement(tag);
  if (value !== undefined) item.textContent = value;
  for (const [key, attr] of Object.entries(attributes)) item.setAttribute(key, attr);
  return item;
}

function panel(title) {
  const section = node('section');
  section.append(node('h2', title));
  return section;
}

function status(key) {
  return node('p', t(key), { role: 'status', class: 'status' });
}

function errorKey(error) {
  return error.status === 401 ? 'session' : [403, 404].includes(error.status) ? 'unavailable' : 'retry';
}

function action(parent, label, call, field, done = () => render('submitted')) {
  const form = node('form');
  const submit = node('button', label, { type: 'submit' });
  const result = node('p', undefined, { role: 'status' });
  const input = field ? node('textarea', undefined, { required: '', maxlength: '4000', rows: '3' }) : null;
  if (input) {
    const caption = node('label', field);
    caption.append(input);
    form.append(caption);
  }
  form.append(submit, result);
  parent.append(form);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    result.textContent = '';
    try {
      await call(input?.value);
      if (form.isConnected) done();
    } catch (error) {
      result.textContent = t(errorKey(error));
    } finally {
      submit.disabled = false;
    }
  });
}

function showBrand(element, branding) {
  element.textContent = branding.label;
  element.style.borderInlineStartColor = branding.accent;
  if (typeof branding.logo_data_url === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(branding.logo_data_url)) {
    element.prepend(node('img', undefined, { class: 'brand-logo', alt: '', src: branding.logo_data_url }));
  }
}

function shareView(share, path) {
  const article = node('article');
  if (typeof share.branding?.label === 'string' && /^#[0-9a-f]{6}$/i.test(share.branding.accent)) {
    const brand = node('p', undefined, { class: 'share-brand' });
    showBrand(brand, share.branding);
    article.append(brand);
  }
  const send = (action, body = {}) => fetchPortal(`${path}/${action}`, { body });
  if (!route.token) article.append(node('a', t('back'), { href: '/' }));
  article.append(node('h1', share.title), node('p', `${t('expires')} · ${date(share.expires_at)}`, { class: 'meta' }));
  if (share.status === 'stale') article.append(status('stale'));
  article.append(node('p', share.text, { class: 'preview' }));
  if (share.deliveries?.length) {
    const timeline = panel(t('delivery'));
    for (const delivery of share.deliveries) {
      const times = node('dl', undefined, { class: 'delivery-times' });
      for (const key of ['produced_at', 'sent_at', 'confirmed_at']) {
        const event = node('div');
        const value = node('dd');
        value.append(node('time', date(delivery[key]), { datetime: delivery[key] }));
        event.append(node('dt', t(key)), value);
        times.append(event);
      }
      timeline.append(times);
    }
    article.append(timeline);
  }
  if (share.attachments.length) {
    const downloads = panel(t('files'));
    for (const file of share.attachments) action(downloads, file.name, async () => {
      const { url } = await fetchPortal(`${path}/download?file_id=${encodeURIComponent(file.id)}`, { token: route.token });
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Invalid download');
      location.assign(target.href);
    }, undefined, () => {});
    article.append(downloads);
  }
  if (share.threads.length || share.actions.comment) {
    const feedback = panel(t('feedback'));
    for (const thread of share.threads) {
      const list = node('ul', undefined, { class: 'comments' });
      for (const comment of thread.comments) {
        const item = node('li');
        item.append(node('time', date(comment.at), { datetime: comment.at }), node('p', comment.text));
        list.append(item);
      }
      feedback.append(list);
      if (share.actions.comment && thread.status === 'open') action(feedback, t('reply'), text => send('comments', { thread_id: thread.id, text }), t('reply'));
    }
    if (share.actions.comment) action(feedback, t('send'), text => send('comments', { text }), t('leaveFeedback'));
    article.append(feedback);
  }
  if (share.actions.approve || share.actions.submit || share.actions.confirm_delivery) {
    const review = panel(t('review'));
    if (share.actions.confirm_delivery) {
      if (share.confirmation_reminder) review.append(status('confirmationReminder'));
      action(review, t('confirm'), () => send('confirm-delivery'));
    }
    if (share.actions.submit) action(review, t('submit'), text => send('submit', { text }), t('submission'));
    if (share.actions.approve) {
      action(review, t('approve'), () => send('approve'));
      action(review, t('changes'), text => send('request-changes', { text }), t('reason'));
    }
    article.append(review);
  }
  return article;
}

async function render(notice) {
  const generation = ++revision;
  document.documentElement.lang = picker.value;
  document.title = `SmartSell · ${t('portal')}`;
  document.querySelector('#language-label').textContent = t('language');
  document.querySelector('#desktop-notice').textContent = t('desktop');
  main.setAttribute('aria-busy', 'true');
  main.replaceChildren(status('loading'));
  try {
    let content;
    if (route.type === 'home') {
      const query = (new URLSearchParams(location.search).get('q') ?? '').trim().slice(0, 120);
      const shares = await fetchPortal(query ? `/shares?${new URLSearchParams({ q: query })}` : '/shares');
      content = node('article');
      const search = node('form', undefined, { action: '/', method: 'get', role: 'search' });
      const label = node('label', t('searchShared'));
      const field = node('input', undefined, { type: 'search', name: 'q', maxlength: '120' });
      field.value = query;
      label.append(field);
      search.append(label, node('button', t('search'), { type: 'submit' }));
      search.addEventListener('submit', event => {
        event.preventDefault();
        const value = field.value.trim();
        history.pushState(null, '', value ? `/?${new URLSearchParams({ q: value })}` : '/');
        void render();
      });
      if (query) search.append(node('a', t('back'), { href: '/' }));
      content.append(node('h1', t('shared')), search);
      if (!shares.length) content.append(status(query ? 'noMatches' : 'empty'));
      const list = node('ul', undefined, { class: 'shares' });
      for (const share of shares) {
        const item = node('li');
        const link = node('a', share.title, { href: `/s/${encodeURIComponent(share.id)}` });
        item.append(link, node('p', `${t(share.kind) ?? t('shared')} · ${t('expires')} ${date(share.expires_at)}`, { class: 'meta' }));
        list.append(item);
      }
      content.append(list);
    } else if (route.type === 'invite' && route.token) {
      await fetchPortal('/me');
      content = node('article');
      content.append(node('h1', t('invitation')));
      action(content, t('accept'), () => fetchPortal(`/invitations/${route.id}/accept`, { body: { token: route.token } }), undefined, () => location.replace('/'));
    } else if (route.type === 'share') {
      const path = `/shares/${route.id}`;
      content = shareView(await fetchPortal(path, { token: route.token }), path);
    } else {
      content = status('unavailable');
    }
    if (generation !== revision) return;
    main.replaceChildren(content);
    if (notice) main.prepend(status(notice));
  } catch (error) {
    if (generation !== revision) return;
    main.replaceChildren(status(errorKey(error)));
    if (error.status === 401 && login) {
      // The return URL is same-origin and carries the capability only in its fragment.
      const returnPath = route.type === 'invite' ? `/invite/${route.id}` : location.pathname;
      const signIn = new URL(login, location.origin);
      signIn.searchParams.set('return_to', returnPath);
      if (route.type === 'invite' && route.token) signIn.hash = route.token;
      main.append(node('a', t('signIn'), { href: signIn.href }));
    }
  } finally {
    if (generation === revision) main.removeAttribute('aria-busy');
  }
}

// The custom host can present workspace branding before sign-in.
fetchPortal('/branding').then(branding => {
  if (typeof branding?.label === 'string' && /^#[0-9a-f]{6}$/i.test(branding.accent)) {
    const brand = document.querySelector('.topbar .brand');
    brand.classList.add('share-brand');
    showBrand(brand, branding);
  }
}).catch(() => {});

if (route.type === 'home') window.addEventListener('popstate', () => render());

picker.addEventListener('change', () => {
  localStorage.setItem('portal-locale', picker.value);
  render();
});
render();