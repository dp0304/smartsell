import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isLanguagePreference, type LanguagePreference } from '../ui/i18n.mjs';
import { DesktopError } from './errors.ts';

export function languageSettings(path: string) {
  return {
    load(): LanguagePreference {
      try {
        const saved = readFileSync(path, 'utf8').trim();
        if (isLanguagePreference(saved)) return saved;
      } catch { /* Missing or unreadable settings use the system preference. */ }
      return 'system';
    },
    save(preference: unknown): LanguagePreference {
      if (!isLanguagePreference(preference)) throw DesktopError.create('请选择支持的界面语言。');
      const temp = `${path}.${randomUUID()}.part`;
      try {
        writeFileSync(temp, `${preference}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(temp, path);
      } catch {
        try { rmSync(temp, { force: true }); } catch { /* Retain the localized save error. */ }
        throw DesktopError.create('无法保存语言设置。请检查本机权限后重试。');
      }
      return preference;
    },
  };
}
