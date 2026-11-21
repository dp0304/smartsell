import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intlLocale, pick, statusInfo } from '@smartsell/ui';
import { primaryI18n } from './i18n';
import { getLocale, negotiateLocale, setLanguage, supportedLocale, viewLanguage } from './locale';
import { problemSummary } from './problem-copy';
import workbench from './workbench-i18n';

test('locale negotiation recognizes regional aliases and respects explicit scripts', () => {
  for (const locale of ['zh', 'zh-CN', 'zh-SG', 'zh-MY', 'zh-Hans-HK']) assert.equal(supportedLocale(locale), 'zh-Hans');
  for (const locale of ['zh-TW', 'zh-HK', 'zh-MO', 'ZH_hant_cn']) assert.equal(supportedLocale(locale), 'zh-Hant');
  assert.equal(negotiateLocale('en-GB', 'zh-CN', ['zh-CN']), 'en');
  assert.equal(negotiateLocale('unsupported', 'zh-CN', ['en']), 'zh-Hans');
  assert.equal(negotiateLocale(null, null, ['fa-IR', 'zh-SG', 'en-US']), 'zh-Hans');
  assert.equal(negotiateLocale(null, null, ['fa-IR']), 'zh-Hant');
  assert.equal(supportedLocale('zh-Latn'), undefined);
});

test('both web catalogs switch together, preserve unknown values, and fall back to Traditional copy', () => {
  const before = getLocale();
  try {
    setLanguage('zh-CN');
    assert.equal(primaryI18n.t('language'), '界面语言');
    assert.equal(workbench.t('ui.workbench'), '运营工作台');
    const lang = viewLanguage(getLocale());
    assert.equal(intlLocale(lang), 'zh-Hans');
    assert.equal(statusInfo('published', lang).label, '已发布');
    assert.equal(pick(['沿用既有文案', 'Existing label'], lang), '沿用既有文案');
    assert.equal(pick('繁體商品名稱 · SKU_燕麥01', lang), '繁體商品名稱 · SKU_燕麥01');
    assert.equal(problemSummary(getLocale(), 'INVALID_CREDENTIALS', 401), '用户名、电子邮箱或密码不正确。');
    assert.equal(problemSummary(getLocale(), 'UNRECOGNIZED_CODE', 429), '请求过于频繁，请稍后重试。');
    setLanguage('bad locale');
    assert.equal(getLocale(), 'zh-Hans');
    setLanguage('en');
    assert.equal(primaryI18n.t('language'), 'Interface language');
    assert.equal(workbench.t('ui.workbench'), 'Operations workspace');
  } finally {
    setLanguage(before);
  }
});
