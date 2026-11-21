import type { i18n } from 'i18next';
import { intlLocale, type Lang } from '@smartsell/ui';

export const languages = [
  { code: 'zh-Hant', name: '繁體中文' },
  { code: 'zh-Hans', name: '简体中文' },
  { code: 'en', name: 'English' },
] as const;
export type Locale = (typeof languages)[number]['code'];
export const defaultLocale: Locale = 'zh-Hant';
const storageKey = 'smartsell-language';
const legacyKey = 'smartsell.locale';

export function supportedLocale(tag: string | null | undefined): Locale | undefined {
  if (!tag) return;
  try {
    const locale = new Intl.Locale(tag.trim().replaceAll('_', '-'));
    if (locale.language === 'en') return 'en';
    if (locale.language !== 'zh') return;
    if (locale.script) return locale.script === 'Hans' ? 'zh-Hans' : locale.script === 'Hant' ? 'zh-Hant' : undefined;
    return ['TW', 'HK', 'MO'].includes(locale.region ?? '') ? 'zh-Hant' : 'zh-Hans';
  } catch {
    return;
  }
}

export function negotiateLocale(saved: string | null, legacy: string | null, preferred: readonly string[]): Locale {
  return supportedLocale(saved) ?? supportedLocale(legacy) ?? preferred.map(supportedLocale).find(Boolean) ?? defaultLocale;
}

function readPreference(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

let currentLocale = negotiateLocale(readPreference(storageKey), readPreference(legacyKey), typeof window === 'undefined' ? [] : window.navigator?.languages ?? []);
const instances = new Set<i18n>();

export function getLocale() { return currentLocale; }
export function viewLanguage(locale: Locale): Lang {
  return locale === 'zh-Hans' ? 'zh-Hans' : locale === 'en' ? 'en' : 'zh';
}

function applyLocale(locale: Locale) {
  currentLocale = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = intlLocale(viewLanguage(locale));
  for (const instance of instances) {
    if (instance.language !== locale) void instance.changeLanguage(locale);
  }
}

export function connectLocale(instance: i18n) {
  instances.add(instance);
  applyLocale(currentLocale);
}

export function setLanguage(value: string) {
  const locale = supportedLocale(value);
  if (!locale) return;
  try { window.localStorage.setItem(storageKey, locale); } catch { /* Keep the selection for this page. */ }
  applyLocale(locale);
}

if (typeof window !== 'undefined') window.addEventListener?.('storage', event => {
  if (event.key === storageKey || event.key === legacyKey || event.key === null) {
    applyLocale(negotiateLocale(readPreference(storageKey), readPreference(legacyKey), window.navigator?.languages ?? []));
  }
});
