import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ViewLang, type Lang } from '@smartsell/ui';
import { AttentionChips, CreatedVia, MetricValue, PriceValue, ProductStatus, ProductThumb, SalesValue, StockChip } from './products-parts';

const html = (node: ReactNode, lang: Lang = 'zh') => renderToStaticMarkup(<ViewLang lang={lang}>{node}</ViewLang>);

test('unknown metrics and hidden sales render their availability, never a zero', () => {
  assert.match(html(<MetricValue metric={{ value: null, availability: 'not_collected' }} />), /未採集/);
  assert.match(html(<MetricValue metric={{ value: null, availability: 'no_permission' }} />, 'en'), /No permission/);
  assert.match(html(<MetricValue metric={undefined} empty={['近 30 天沒有發布', 'No posts']} />), /近 30 天沒有發布/);
  // A value with an unknown availability is not shown as a number.
  assert.doesNotMatch(html(<MetricValue metric={{ value: 0, availability: 'sync_failed' }} />), />0</);
  assert.match(html(<MetricValue metric={{ value: 12345, availability: 'estimated' }} />, 'en'), /12\.3K.*Estimated/);
  assert.match(html(<SalesValue sales={{ visible: false }} />), /無權限查看/);
  assert.match(html(<SalesValue sales={{ visible: true, currencies: [] }} />), /沒有已記錄的訂單/);
  assert.match(html(<SalesValue sales={{ visible: true, currencies: [{ currency: 'TWD', orders: 2, net_minor: 150000 }] }} />, 'en'), /2 orders · NT\$1,500/);
});

test('prices carry their estimate, stale and unpublishable marks with explanations', () => {
  assert.match(html(<PriceValue price={null} />), /未採集/);
  const estimate = html(<PriceValue price={{ min_minor: 99000, max_minor: 120000, currency: 'TWD', is_estimate: true, publishable: false }} />, 'en');
  assert.match(estimate, /NT\$990 – NT\$1,200/);
  assert.match(estimate, /Estimate/);
  assert.match(estimate, /title="Derived from an exchange rate/);
  // The estimate already explains why it cannot be published, so no second mark.
  assert.doesNotMatch(estimate, /Not for publishing/);
  assert.match(html(<PriceValue price={{ min_minor: 100, max_minor: 100, currency: 'USD', publishable: false }} />, 'en'), /Not for publishing/);
  assert.doesNotMatch(html(<PriceValue price={{ min_minor: 100, max_minor: 100, currency: 'USD', publishable: true }} />, 'en'), /pp-flag/);
});

test('stock, status, attention and agent markers use labelled chips', () => {
  assert.match(html(<StockChip stock={{ status: 'low', quantity: 3, variants_observed: 1, variants_total: 2 }} />), /庫存偏低 3.*1\/2/);
  assert.match(html(<StockChip status="out_of_stock" quantity={0} />), /tone-critical.*缺貨/);
  assert.doesNotMatch(html(<StockChip status="out_of_stock" quantity={0} />), /缺貨 0/);
  assert.match(html(<StockChip stock={{ status: 'unknown', quantity: null }} />), /庫存未採集/);
  assert.match(html(<ProductStatus status="active" />), /販售中/);
  assert.match(html(<AttentionChips items={[{ kind: 'localization_stale', severity: 'high', count: 2 }, { kind: 'fact_pending', severity: 'normal', count: 1 }]} limit={1} />), /2 項在地化內容已過時.*\+1/);
  assert.match(html(<CreatedVia via="agent" />), /由 Agent 建立/);
  assert.equal(html(<CreatedVia via="human" />), '');
});

test('product images fall back to initials for unsafe URLs', () => {
  assert.match(html(<ProductThumb title="夏日防曬乳" imageUrl="javascript:alert(1)" />), /夏日/);
  assert.doesNotMatch(html(<ProductThumb title="Tee" imageUrl="javascript:alert(1)" />), /<img/);
  assert.match(html(<ProductThumb title="Tee" imageUrl="https://cdn.example.com/tee.jpg" />), /<img[^>]+src="https:\/\/cdn\.example\.com\/tee\.jpg"/);
});
