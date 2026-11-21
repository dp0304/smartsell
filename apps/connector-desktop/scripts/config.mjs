export function httpsUrl(value, name, originOnly = false) {
  if (!value) return;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== '/')) {
    throw new Error(`${name} must be an HTTPS ${originOnly ? 'origin' : 'URL'}`);
  }
  return originOnly ? url.origin : url.href;
}

export function releaseConfig(platform) {
  const api = httpsUrl(process.env.SMARTSELL_API_ORIGIN, 'SMARTSELL_API_ORIGIN', true);
  const workbench = httpsUrl(process.env.SMARTSELL_WORKBENCH_ORIGIN, 'SMARTSELL_WORKBENCH_ORIGIN', true);
  const feed = httpsUrl(process.env.SMARTSELL_UPDATE_FEED, 'SMARTSELL_UPDATE_FEED');
  const publisher = process.env.SMARTSELL_WIN_PUBLISHER?.trim();
  if (feed && platform === 'win32' && (!publisher || !/(?:^|,)\s*CN=/.test(publisher) || !/(?:^|,)\s*O=/.test(publisher))) {
    throw new Error('SMARTSELL_WIN_PUBLISHER must be the full Authenticode subject DN, including CN and O');
  }
  return { api, workbench, update: feed ? { feed, publisher } : undefined };
}
