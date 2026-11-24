// F11 (wave 6): xWeightedLength follows twitter-text v3 (config/v3.json: scale 100, defaultWeight 200, emojiParsingEnabled,
// transformedURLLength 23, four light ranges at weight 100; js/src/parseTweet.js: NFC, URLs before emoji before characters;
// extractUrlsWithIndices extracts protocol-less domains with a valid TLD). Checked against twitter-text's sources via Exa.
import assert from 'node:assert/strict';
import test from 'node:test';
import { xWeightedLength } from '../../packages/contracts/src/index.ts';

test('F11: every URL counts 23, also a bare domain with a known TLD; trailing punctuation and CJK after it are text', () => {
  assert.equal(xWeightedLength('makemylure.com'), 23, 'X wraps a bare domain in t.co');
  assert.equal(xWeightedLength('Shop at makemylure.com now'), 8 + 23 + 4);
  assert.equal(xWeightedLength('MakeMyLure.COM'), 23, 'case-insensitive');
  assert.equal(xWeightedLength('www.makemylure.shop/lures?id=7'), 23, 'gTLD, path and query');
  assert.equal(xWeightedLength('https://makemylure.com/shop?x=1.'), 24, 'the final period is not part of the URL');
  assert.equal(xWeightedLength('看makemylure.com。'), 2 + 23 + 2, 'CJK around a bare domain');
  assert.equal(xWeightedLength('(see https://x.com/a_b)'), 1 + 4 + 23 + 1, 'an unbalanced closing parenthesis is text');
  assert.equal(xWeightedLength('https://en.wikipedia.org/wiki/Bass_(fish)'), 23, 'balanced parentheses stay in the URL');
  assert.equal(xWeightedLength('a.com,b.com'), 23 + 1 + 23);
  assert.equal(xWeightedLength('https://a.com https://b.com'), 23 + 1 + 23);
});

test('F11: text that only looks like a domain is counted as characters', () => {
  assert.equal(xWeightedLength('file.txt'), 8, 'txt is not a TLD');
  assert.equal(xWeightedLength('e.g. U.S. Node.js'), 17);
  assert.equal(xWeightedLength('info@makemylure.com'), 19, 'an e-mail address is not a URL');
  assert.equal(xWeightedLength('/makemylure.com'), 15, 'a bare domain right after a slash is not extracted');
  assert.equal(xWeightedLength('https://localhost/x'), 19, 'no valid TLD');
  assert.equal(xWeightedLength('3.14 and v1.2'), 13);
});

test('F11: each emoji, including ZWJ, skin-tone, keycap and flag sequences, counts 2', () => {
  assert.equal(xWeightedLength('👨‍👩‍👧‍👦'), 2, 'family ZWJ sequence');
  assert.equal(xWeightedLength('👍🏽'), 2, 'skin tone');
  assert.equal(xWeightedLength('🇹🇼'), 2, 'flag');
  assert.equal(xWeightedLength('1️⃣'), 2, 'keycap');
  assert.equal(xWeightedLength('❤️'), 2, 'text symbol with VS16');
  assert.equal(xWeightedLength('🎣🎣'), 4);
  assert.equal(xWeightedLength('New lure 🎣 makemylure.com'), 9 + 2 + 1 + 23);
});

test('F11: other code points weigh 1 in the light ranges and 2 elsewhere, after NFC', () => {
  assert.equal(xWeightedLength('hello'), 5);
  assert.equal(xWeightedLength('中文'), 4);
  assert.equal(xWeightedLength('é'), 1, 'NFC composes é');
  assert.equal(xWeightedLength('‘quoted’'), 8, 'U+2018–U+201F are light');
  assert.equal(xWeightedLength(''), 0);
  assert.equal(xWeightedLength('a'.repeat(280)), 280);
});
