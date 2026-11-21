const idPattern = '[A-Za-z0-9_-]{1,128}';
const routePattern = new RegExp(`^/(s|invite)/(${idPattern})/?$`);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function routeFor(pathname, hash) {
  if (pathname === '/') return { type: 'home' };
  const route = pathname.match(routePattern);
  if (!route) return { type: 'missing' };
  const token = hash.startsWith('#') && tokenPattern.test(hash.slice(1)) ? hash.slice(1) : undefined;
  return { type: route[1] === 's' ? 'share' : 'invite', id: route[2], token };
}

export function fetchPortal(path, { token, body } = {}, transport = fetch) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Share ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return transport(`/api/v1/portal${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers, cache: 'no-store',
    credentials: token ? 'omit' : 'same-origin', redirect: 'error',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async res => {
    if (!res.ok) throw Object.assign(new Error('Portal request failed'), { status: res.status });
    return (await res.json()).data;
  });
}

export function localSignInPath(configured) {
  return /^\/(?!\/)[a-zA-Z0-9/_-]+$/.test(configured ?? '') ? configured : null;
}