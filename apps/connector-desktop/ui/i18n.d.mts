export type DesktopLanguage = 'zh-Hans' | 'zh-Hant';
export type LanguagePreference = DesktopLanguage | 'system';

export const defaultLanguage: DesktopLanguage;
export function isLanguagePreference(value: unknown): value is LanguagePreference;
export function negotiateLanguage(preference: LanguagePreference, preferredLanguages: readonly string[]): DesktopLanguage;
export function translate(language: DesktopLanguage, key: string, ...values: (string | number)[]): string;
