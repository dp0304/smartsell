import { useState, type ReactNode } from 'react';
import { ActorBadge, AvailabilityTag, Glyph, StatusChip, ViewLink, formatMeasure, formatNumber, isNum, pick, useLang, type Metric, type Tone, type Tuple } from '@smartsell/ui';
import {
  attentionText, extraStatusText, initials, priceRange, productStatusText, safeImage, salesLines, severityTone, stockText,
  type AttentionItem, type MarketPrice, type MarketStock, type Sales,
} from './products-logic';

// Building blocks shared by the product list and the product page. They read the language from
// ViewLang (not i18next) so they render the same in the app and in node tests.

export function ProductThumb({ title, imageUrl, size = 'md' }: { title: string | null; imageUrl?: string | null; size?: 'md' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  const src = safeImage(imageUrl);
  return <span className={`pp-thumb ${size}`} aria-hidden="true">
    {src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <span className="pp-initials">{initials(title)}</span>}
  </span>;
}

export function ProductStatus({ status }: { status: string | null | undefined }) {
  const known = status ? productStatusText[status] : undefined;
  return known ? <StatusChip status={status} tone={known[0]} label={[known[1], known[2]]} /> : <StatusChip status={status} />;
}

/** Status chip that also knows publication, post, change and fact states the shared chip lacks. */
export function AnyStatus({ status }: { status: string | null | undefined }) {
  const known = status ? extraStatusText[status] : undefined;
  return known ? <StatusChip status={status} tone={known[0]} label={[known[1], known[2]]} /> : <StatusChip status={status} />;
}

const stockTone: Record<string, Tone> = { in_stock: 'good', low: 'warning', out_of_stock: 'critical' };
export function StockChip({ stock, status, quantity }: { stock?: MarketStock | null; status?: string | null; quantity?: number | null }) {
  const lang = useLang();
  const value = status ?? stock?.status ?? 'unknown';
  const count = quantity !== undefined ? quantity : stock?.quantity;
  const text = pick(stockText[value] ?? [value.replace(/_/g, ' '), value.replace(/_/g, ' ')], lang);
  const label = isNum(count) && value !== 'out_of_stock' ? `${text} ${formatNumber(count, lang, true)}` : text;
  const partial = stock && isNum(stock.variants_total) && isNum(stock.variants_observed) && stock.variants_total > 0 && stock.variants_observed < stock.variants_total
    ? pick([`${stock.variants_observed}/${stock.variants_total} 個變體已採集庫存`, `Stock collected for ${stock.variants_observed} of ${stock.variants_total} variants`], lang) : undefined;
  return <span className="pp-stock" title={partial}>
    <StatusChip status={value} tone={stockTone[value] ?? 'neutral'} label={label} />
    {partial && value !== 'unknown' && <small className="muted">{stock!.variants_observed}/{stock!.variants_total}</small>}
  </span>;
}

export const flagText = {
  estimate: { short: ['估算', 'Estimate'], long: ['由匯率或規則推估，不是店鋪實際標價。', 'Derived from an exchange rate or rule, not the price the store shows.'] },
  stale: { short: ['已過時', 'Stale'], long: ['超過店鋪設定的同步時效沒有重新取得，實際價格可能已變動。', 'Not re-read within the store’s sync window; the real price may have changed.'] },
  unpublishable: { short: ['不可用於發布', 'Not for publishing'], long: ['估算、過時、商品未上架或資料不完整時，這個價格不能放進貼文或投放。', 'Estimated, stale, unpublished or incomplete prices cannot go into posts or ads.'] },
} satisfies Record<string, { short: Tuple; long: Tuple }>;

/** Small tags for an estimated, stale or unpublishable price; each one carries its explanation as a tooltip. */
export function PriceFlags({ price }: { price: Pick<MarketPrice, 'is_estimate' | 'stale' | 'publishable'> }) {
  const lang = useLang();
  const shown = (['estimate', 'stale', 'unpublishable'] as const).filter(key =>
    key === 'estimate' ? price.is_estimate === true : key === 'stale' ? price.stale === true : price.publishable === false && price.is_estimate !== true && price.stale !== true);
  if (!shown.length) return null;
  return <>{shown.map(key => <span key={key} className={`pp-flag flag-${key}`} title={pick(flagText[key].long, lang)}>
    <Glyph name={key === 'stale' ? 'info' : key === 'estimate' ? 'neutral' : 'warning'} size={11} />{pick(flagText[key].short, lang)}
  </span>)}</>;
}

/** A market price range with its flags, or the honest "not collected". */
export function PriceValue({ price, compact = false }: { price: MarketPrice | null | undefined; compact?: boolean }) {
  const lang = useLang();
  const text = priceRange(price, lang, compact);
  if (!price || !text) return <AvailabilityTag availability="not_collected" />;
  return <span className="pp-price"><strong>{text}</strong><PriceFlags price={price} /></span>;
}

/** A metric value, or its availability instead of a zero. */
export function MetricValue({ metric, empty }: { metric: Metric | null | undefined; empty?: Tuple }) {
  const lang = useLang();
  if (metric && isNum(metric.value) && (metric.availability === 'observed' || metric.availability === 'estimated')) {
    return <span className="pp-metric"><strong>{formatMeasure(metric.value, 'count', null, lang, true)}</strong>{metric.availability === 'estimated' && <AvailabilityTag availability="estimated" />}</span>;
  }
  if (empty) return <span className="muted">{pick(empty, lang)}</span>;
  return <AvailabilityTag availability={metric?.availability ?? 'not_collected'} />;
}

export const salesNoOrders: Tuple = ['沒有已記錄的訂單', 'No recorded orders'];
/** Orders recorded in SmartSell that include the product; hidden sales say so instead of showing zero. */
export function SalesValue({ sales }: { sales: Sales | null | undefined }) {
  const lang = useLang();
  if (!sales || !sales.visible) return <AvailabilityTag availability="no_permission" />;
  const lines = salesLines(sales, lang);
  if (!lines.length) return <span className="muted">{pick(salesNoOrders, lang)}</span>;
  return <span className="pp-sales">{lines.map(line => <strong key={line}>{line}</strong>)}</span>;
}

export function AttentionChips({ items, limit = items.length }: { items: readonly AttentionItem[]; limit?: number }) {
  const lang = useLang();
  if (!items.length) return null;
  const shown = items.slice(0, limit);
  return <ul className="pp-attention">
    {shown.map((item, index) => <li key={`${item.kind}-${item.resource?.id ?? index}`}>
      <StatusChip status={item.severity} tone={severityTone(item.severity)} label={attentionText(item)} />
    </li>)}
    {items.length > shown.length && <li className="muted"><small>+{items.length - shown.length}</small></li>}
  </ul>;
}

export function CreatedVia({ via, showHuman = false }: { via: 'agent' | 'human' | null | undefined; showHuman?: boolean }) {
  const lang = useLang();
  if (via === 'agent') return <ActorBadge type="agent" label={pick(['由 Agent 建立', 'Created by agent'], lang)} />;
  if (via === 'human' && showHuman) return <ActorBadge type="human" label={pick(['由人建立', 'Created by a person'], lang)} />;
  return null;
}

/** A labelled fact on the page header strip. */
export function Fact({ label, children, tone, href }: { label: Tuple; children: ReactNode; tone?: Tone; href?: string }) {
  const lang = useLang();
  const body = <><span className="pp-fact-label">{pick(label, lang)}</span><span className="pp-fact-value">{children}</span></>;
  const className = `pp-fact${tone ? ` tone-${tone}` : ''}`;
  return href ? <ViewLink to={href} className={className}>{body}</ViewLink> : <div className={className}>{body}</div>;
}
