// Serialized into the main frame's isolated world by both X readers.
export function inspectXLogin(): 'blocked' | 'login' | 'unknown' {
  const here = new URL(location.href);
  if (here.origin !== 'https://x.com' || here.username || here.password ||
    /^\/(?:account\/access|i\/flow\/(?:challenge|verify|signup)|oauth)(?:\/|$)/i.test(here.pathname)) return 'blocked';

  const visible = (element: Element) => {
    if (element.closest('[hidden], [aria-hidden="true"], [inert]') ||
      !element.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  };
  const challenges = 'iframe[src*="captcha" i], iframe[src*="arkoselabs" i], iframe[title*="captcha" i], ' +
    '[role="alertdialog"], [data-testid="error-detail"], [data-testid="protectedAccount"]';
  if (Array.from(document.querySelectorAll(challenges)).some(visible)) return 'blocked';
  if (/^\/(?:i\/flow\/login|login)(?:\/|$)/i.test(here.pathname)) return 'login';
  if (here.pathname !== '/' || document.readyState === 'loading' ||
    document.querySelector('header a[data-testid="AppTabBar_Profile_Link"], [role="banner"] a[data-testid="AppTabBar_Profile_Link"]') ||
    Array.from(document.querySelectorAll('[aria-modal="true"], [aria-busy="true"], [role="progressbar"]')).some(visible)) return 'unknown';

  // Hit testing skips pointer-transparent layers. Check painted layers too,
  // while letting transparent layout containers leave controls visible.
  const overlays = Array.from(document.querySelectorAll('body *')).filter(element => {
    const { position, pointerEvents, backgroundColor, backgroundImage, backdropFilter } = getComputedStyle(element);
    return pointerEvents === 'none' && /^(?:absolute|fixed|sticky)$/.test(position) && visible(element) &&
      (backgroundColor !== 'rgba(0, 0, 0, 0)' || backgroundImage !== 'none' || backdropFilter !== 'none');
  });
  const exposed = (element: Element) => {
    if (!visible(element)) return false;
    const { left, top, width, height } = element.getBoundingClientRect();
    const x = left + width / 2, y = top + height / 2;
    const hit = document.elementFromPoint(x, y);
    return !!hit && element.contains(hit) && !overlays.some(overlay => {
      if (element.contains(overlay) || overlay.contains(element)) return false;
      const { left, right, top, bottom } = overlay.getBoundingClientRect();
      return x >= left && x < right && y >= top && y < bottom;
    });
  };
  const normalized = (text: string | null) => text?.trim().replace(/\s+/g, ' ') ?? '';
  const identifierLabel = /^(?:email(?: address)? or username|电子邮[件箱]或用户名|邮件地址或用户名|電子郵件或使用者名稱|phone, email, or username)$/i;
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter(input => {
    const form = input.form ?? input.closest('[role="form"]');
    return form && /^(?:text|email)$/.test(input.type) && !input.matches(':disabled, [readonly]') && exposed(input) &&
      (input.autocomplete.split(/\s+/).includes('username') || /^(?:text|username|username_or_email|email)$/.test(input.name)) &&
      [input.getAttribute('aria-label'), input.getAttribute('placeholder'),
        ...Array.from(input.labels ?? []).filter(exposed).map(label => label.innerText),
        ...(input.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id))
          .filter((label): label is HTMLElement => label instanceof HTMLElement && exposed(label)).map(label => label.innerText),
      ].some(text => identifierLabel.test(normalized(text)));
  });
  if (inputs.length !== 1) return 'unknown';
  const form = inputs[0].form ?? inputs[0].closest('[role="form"]')!;
  const surface = form.closest('main, [role="main"]') ?? document;
  const actions = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], a[href]'))
    .filter(exposed);
  const labelOf = (control: HTMLElement) => normalized(control.getAttribute('aria-label') || control.innerText);
  // The login form disables Continue until the user supplies an identifier.
  const hasContinue = actions(form).some(control => !control.matches('a[href], button[type="reset"]') &&
    /^(?:continue|next|继续|繼續|下一步)$/i.test(labelOf(control)));
  const input = inputs[0];
  const passkeyLanding = input.name === 'username_or_email' && input.autocomplete.split(/\s+/).includes('webauthn') &&
    Array.from(surface.querySelectorAll<HTMLElement>('h1')).some(title => exposed(title) &&
      /^(?:正发生|正發生|happening now)[.。]?$/i.test(normalized(title.innerText)));
  if (!hasContinue && !passkeyLanding) return 'unknown';
  const providers = [
    /^(?:使用手机号?继续|使用手機繼續|continue with (?:your )?phone)$/i,
    /^(?:继续使用 Google|使用 Google 继续|使用 Google 繼續|(?:continue|sign in) with Google)$/i,
    /^(?:继续使用 Apple|使用 Apple 继续|使用 Apple 繼續|(?:continue|sign in) with Apple)$/i,
  ];
  const labels = actions(surface).filter(control => !control.matches(':disabled, [aria-disabled="true"]')).map(labelOf);
  return providers.filter(pattern => labels.some(label => pattern.test(label))).length >= 2 ? 'login' : 'unknown';
}
