import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { setupText } from './setup-copy';
import { canSetUp } from './setup-data';
import { AgentPrompt, AvailabilityTag, Glyph, StatusChip, ViewLink, formatDateTime, formatMeasure, formatMinor, isNum, type Tone, type Tuple } from '@smartsell/ui';
import { copy, fill } from '../copy';
import { useView, useViewContext, workspaceZone } from '../data/use-view';
import { Loaded, PageHeader, useFilters, useText } from '../parts';
import {
  channelText, filterCounts, isProductFilter, isProductSort, marketColumns, matchesFilter, productFlags, sortProducts, storeLine, summarize,
  type ProductFilter, type ProductItem, type ProductSort, type ProductSummary,
} from './products-logic';
import { AttentionChips, CreatedVia, MetricValue, PriceValue, ProductStatus, ProductThumb, SalesValue, StockChip } from './products-parts';
import './products.css';

const text = {
  subtitle: ['哪個在推、哪個賣得好、哪個有狀況，一眼看完。', 'What is being promoted, what sells and what needs attention, at a glance.'],
  products: ['商品', 'Products'], onSale: ['販售中 {a} · 草稿 {b}', '{a} on sale · {b} draft'],
  live: ['推廣中', 'Promoting'], liveHint: ['有進行中的推廣計劃', 'In a live promotion plan'], upcomingOnly: ['另 {n} 個有即將開始的計劃', '{n} more have a plan starting soon'],
  attention: ['需注意', 'Needs attention'], attentionHint: ['價格、庫存、商品資訊或在地化', 'Price, stock, facts or localization'], lowHint: ['含 {n} 個庫存偏低', 'Includes {n} with low stock'],
  out: ['缺貨', 'Out of stock'], outHint: ['至少一個市場缺貨', 'Out of stock in at least one market'],
  topViews: ['近 30 天瀏覽最多', 'Most viewed, last 30 days'], topOrders: ['近 30 天訂單最多', 'Most ordered, last 30 days'],
  coverage: ['{a}/{b} 個商品有已採集數據', '{a} of {b} products have collected data'], noViews: ['還沒有已採集的貼文成效', 'No post performance collected yet'],
  ordersCount: ['{n} 筆', '{n} orders'], amountUnknown: ['{c} 金額未知', '{c} amount unknown'], noOrders: ['沒有已記錄的訂單', 'No recorded orders'], hiddenSales: ['你的角色看不到訂單', 'Your role cannot see orders'],
  noSum: ['瀏覽與訂單不跨商品加總：一則貼文或一筆訂單可能同時帶到多個商品。訂單只含已記錄在 SmartSell 的部分。',
    'Views and orders are not summed across products: one post or order can feature several products. Orders cover only what is recorded in SmartSell.'],
  metricsMissing: ['近 30 天有發布，但還沒有任何成效數據', 'Posts went out in the last 30 days, but no performance data has been collected'],
  metricsPrompt: ['幫我匯入各社群帳號最近 30 天的貼文成效', 'Import the last 30 days of post performance for each social account'],
  filters: ['篩選商品', 'Filter products'], all: ['全部', 'All'], search: ['搜尋商品名稱或 SKU', 'Search by product name or SKU'],
  sort: ['排序', 'Sort'], recent: ['最近更新', 'Recently updated'], byViews: ['近 30 天瀏覽', 'Views, last 30 days'], byOrders: ['近 30 天訂單', 'Orders, last 30 days'],
  sortNote: ['未採集的排在最後，不當作 0。', 'Unknown values sort last; they are not treated as zero.'],
  noSearch: ['找不到符合「{q}」的商品', 'No products match “{q}”'], clearSearch: ['清除搜尋', 'Clear search'],
  importPrompt: ['幫我把「{q}」這個商品匯入 SmartSell，並同步各市場的價格和庫存', 'Import the product “{q}” into SmartSell and sync its prices and stock in each market'],
  noLive: ['目前沒有商品在推廣', 'No products are being promoted'], noLivePrompt: ['幫我挑一個主打商品，建立下個月的推廣計劃', 'Pick a hero product and create next month’s promotion plan for it'],
  allClear: ['沒有需要注意的商品', 'No products need attention'], noneOut: ['沒有缺貨的商品', 'No products are out of stock'],
  recheck: ['想再確認一次？', 'Want to double-check?'], recheckPrompt: ['幫我重新同步所有商品在各市場的價格和庫存', 'Re-sync prices and stock for every product in every market'],
  moreMarkets: ['還有 {n} 個市場', '{n} more markets'], noMarkets: ['還沒有市場價格與庫存', 'No market prices or stock yet'],
  promo: ['推廣', 'Promotion'], noPlan: ['沒有進行中的計劃', 'No live plan'], upcoming: ['{n} 個即將開始', '{n} starting soon'],
  next: ['下一則', 'Next post'], notScheduled: ['未排定', 'Nothing scheduled'], cadence: ['7 天內 {a} 則 · 30 天已發 {b} 則', '{a} in the next 7 days · {b} published in 30 days'],
  views: ['瀏覽', 'Views'], engagements: ['互動', 'Engagements'], orders: ['訂單', 'Orders'], period: ['近 30 天', 'Last 30 days'],
  noPosts: ['沒有發布', 'No posts'],
} satisfies Record<string, Tuple>;

const DAY = 86_400_000;
const filterLabel: Record<ProductFilter, Tuple> = { all: text.all, live: text.live, attention: text.attention, out: text.out };

function Tile({ label, value, hint, tone, children }: { label: Tuple; value: string; hint?: ReactNode; tone?: Tone; children?: ReactNode }) {
  const { l } = useText();
  return <div className={`pp-tile${tone ? ` tone-${tone}` : ''}`}>
    <span className="pp-tile-label">{l(label)}</span>
    <strong className={value === '—' ? 'pp-tile-value unknown' : 'pp-tile-value'}>{value}{children}</strong>
    {hint && <small className="pp-tile-hint">{hint}</small>}
  </div>;
}

function SummaryStrip({ summary, base }: { summary: ProductSummary; base: string }) {
  const { l, lang } = useText();
  const link = (id: string, title: string | null) => <ViewLink to={`${base}/products/${encodeURIComponent(id)}`}>{title ?? id}</ViewLink>;
  const views = summary.views, orders = summary.orders;
  return <div className="pp-strip" aria-label={l(text.products)}>
    <Tile label={text.products} value={String(summary.total)} hint={fill(l(text.onSale), { a: summary.active, b: summary.draft })} />
    <Tile label={text.live} value={String(summary.live)} hint={summary.upcomingOnly ? fill(l(text.upcomingOnly), { n: summary.upcomingOnly }) : l(text.liveHint)} />
    <Tile label={text.attention} value={String(summary.attention)} tone={summary.attention ? 'serious' : undefined}
      hint={summary.low ? fill(l(text.lowHint), { n: summary.low }) : l(text.attentionHint)} />
    <Tile label={text.out} value={String(summary.out)} tone={summary.out ? 'critical' : undefined} hint={l(text.outHint)} />
    {views.leader ? <Tile label={text.topViews} value={formatMeasure(views.leader.metric.value!, 'count', null, lang, true)}
      hint={<>{link(views.leader.id, views.leader.title)} · {fill(l(text.coverage), { a: views.known, b: summary.total })}</>}>
      {views.leader.metric.availability === 'estimated' && <AvailabilityTag availability="estimated" />}</Tile>
      : <Tile label={text.topViews} value="—" hint={l(text.noViews)}><AvailabilityTag availability={views.availability} /></Tile>}
    {!orders.visible ? <Tile label={text.topOrders} value="—" hint={l(text.hiddenSales)}><AvailabilityTag availability="no_permission" /></Tile>
      : orders.leader ? <Tile label={text.topOrders} value={fill(l(text.ordersCount), { n: orders.leader.orders })}
        hint={<>{link(orders.leader.id, orders.leader.title)}{orders.leader.currencies.filter(row => row.orders > 0).map(row =>
          <span key={row.currency}> · {formatMinor(row.net_minor, row.currency, lang, true) ?? fill(l(text.amountUnknown), { c: row.currency })}</span>)}</>} />
        : <Tile label={text.topOrders} value="—" hint={l(text.noOrders)} />}
  </div>;
}

function daysLeft(endsAt: string | null, now: number) {
  const end = endsAt ? Date.parse(endsAt) : NaN;
  return Number.isFinite(end) ? Math.ceil((end - now) / DAY) : null;
}

function ProductTile({ item, base, timeZone, now }: { item: ProductItem; base: string; timeZone?: string; now: number }) {
  const { l, lang } = useText();
  const href = `${base}/products/${encodeURIComponent(item.id)}`;
  const flags = productFlags(item);
  const columns = marketColumns(item.markets ?? []);
  const shown = columns.slice(0, 3);
  const live = item.plans?.live ?? [];
  const upcoming = item.plans?.upcoming ?? 0;
  const content = item.content;
  const quiet = (content?.published_30d ?? 0) === 0;
  const store = storeLine(item.store, lang);
  return <li className={`pp-card${flags.out ? ' is-out' : flags.attention ? ' is-attention' : ''}`}>
    <header className="pp-card-head">
      <ProductThumb title={item.title} imageUrl={item.image_url} />
      <div className="pp-card-title">
        <ViewLink to={href} className="pp-title">{item.title ?? item.id}</ViewLink>
        {store && <small className="muted">{store}</small>}
        {(item.status !== 'active' || item.created_via === 'agent') && <span className="pp-badges">
          {item.status !== 'active' && <ProductStatus status={item.status} />}<CreatedVia via={item.created_via} />
        </span>}
      </div>
    </header>
    <AttentionChips items={item.attention ?? []} limit={2} />
    {shown.length ? <ul className="pp-markets">{shown.map(column => {
      const market = column.summary!;
      return <li key={column.key}>
        <span className="pp-market-name">{column.market_name ?? column.market_id}
          {column.showChannel && column.channel && <small className="muted"> · {l(channelText[column.channel] ?? [column.channel, column.channel])}</small>}</span>
        <PriceValue price={market.price} compact />
        <StockChip stock={market.stock} />
      </li>;
    })}
      {columns.length > shown.length && <li className="pp-more"><ViewLink to={href}>{fill(l(text.moreMarkets), { n: columns.length - shown.length })}</ViewLink></li>}
    </ul> : <p className="muted pp-empty-line">{l(text.noMarkets)}</p>}
    <div className="pp-row"><span className="pp-row-label">{l(text.promo)}</span>
      <span className="pp-row-body">{live.length ? live.map(plan => {
        const left = daysLeft(plan.ends_at, now);
        return <span key={plan.id} className="pp-plan-link"><ViewLink to={`${base}/plans/${encodeURIComponent(plan.id)}`}>{plan.name ?? plan.id}</ViewLink>
          {plan.status && plan.status !== 'active' && <StatusChip status={plan.status} />}
          {isNum(left) && <small className="muted">{left > 0 ? fill(l(copy.common.daysLeft), { n: left }) : l(copy.common.ended)}</small>}</span>;
      }) : <span className="muted">{l(text.noPlan)}</span>}
        {upcoming > 0 && <small className="muted">{fill(l(text.upcoming), { n: upcoming })}</small>}</span>
    </div>
    <div className="pp-row"><span className="pp-row-label">{l(text.next)}</span>
      <span className="pp-row-body">{content?.next_scheduled_at ? <time dateTime={content.next_scheduled_at}>{formatDateTime(content.next_scheduled_at, lang, timeZone)}</time>
        : <span className="muted">{l(text.notScheduled)}</span>}
        {content && <small className="muted">{fill(l(text.cadence), { a: content.scheduled_next_7d ?? 0, b: content.published_30d ?? 0 })}</small>}</span>
    </div>
    <dl className="pp-stats" aria-label={l(text.period)}>
      <div><dt>{l(text.views)}</dt><dd><MetricValue metric={item.performance?.views} empty={quiet ? text.noPosts : undefined} /></dd></div>
      <div><dt>{l(text.engagements)}</dt><dd><MetricValue metric={item.performance?.engagements} empty={quiet ? text.noPosts : undefined} /></dd></div>
      <div><dt>{l(text.orders)}</dt><dd><SalesValue sales={item.sales} /></dd></div>
    </dl>
  </li>;
}

function EmptyFilter({ filter, base }: { filter: ProductFilter; base: string }) {
  const { l } = useText();
  if (filter === 'live') return <AgentPrompt title={l(text.noLive)} prompt={l(text.noLivePrompt)} agentHref={`${base}/agent`} />;
  return <div className="pp-clear">
    <p className="vs-all-clear"><Glyph name="check" />{l(filter === 'out' ? text.noneOut : text.allClear)}</p>
    <AgentPrompt title={l(text.recheck)} prompt={l(text.recheckPrompt)} agentHref={`${base}/agent`} />
  </div>;
}

function ProductGrid({ items, filter, sort, base, query, onClear }: { items: ProductItem[]; filter: ProductFilter; sort: ProductSort; base: string; query: string; onClear: () => void }) {
  const { l } = useText();
  const { ws } = useViewContext();
  const zone = workspaceZone(ws);
  const [now] = useState(() => Date.now());
  if (query && !items.length) return <div className="pp-clear">
    <p className="vs-actions"><strong>{fill(l(text.noSearch), { q: query })}</strong><button type="button" className="vs-btn ghost" onClick={onClear}>{l(text.clearSearch)}</button></p>
    <AgentPrompt title={fill(l(text.noSearch), { q: query })} prompt={fill(l(text.importPrompt), { q: query })} agentHref={`${base}/agent`} />
  </div>;
  const shown = sortProducts(items.filter(item => matchesFilter(item, filter)), sort);
  if (!shown.length) return <EmptyFilter filter={filter} base={base} />;
  return <ul className="pp-grid">{shown.map(item => <ProductTile key={item.id} item={item} base={base} timeZone={zone} now={now} />)}</ul>;
}

export function ProductsPage() {
  const { l } = useText();
  const { base, workspace } = useViewContext();
  const { brandId } = useFilters();
  const [params, setParams] = useSearchParams();
  const searchId = useId();
  const show = params.get('show'), order = params.get('sort');
  const filter: ProductFilter = isProductFilter(show) ? show : 'all';
  const sort: ProductSort = isProductSort(order) ? order : 'recent';
  const query = (params.get('q') ?? '').trim();
  const [draft, setDraft] = useState(query);
  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
    setParams(next, { replace: true });
  };
  // The search box writes ?q= after a pause; back/forward navigation writes the box.
  useEffect(() => { setDraft(current => current.trim() === query ? current : query); }, [query]);
  useEffect(() => {
    const value = draft.trim();
    if (value === query) return;
    const timer = setTimeout(() => set({ q: value || null }), 350);
    return () => clearTimeout(timer);
  });
  const all = useView<ProductItem[]>('/views/products', { brand_id: brandId }, { allPages: true });
  const searched = useView<ProductItem[]>('/views/products', { brand_id: brandId, q: query }, { enabled: Boolean(query), allPages: true });
  const list = (value: unknown) => Array.isArray(value) ? value as ProductItem[] : [];
  return <>
    <PageHeader title={l(copy.pages.productsTitle)} subtitle={l(text.subtitle)} asOf={all.isPending ? undefined : all.asOf ?? null}>
      {canSetUp(workspace.role) && <Link className="vs-btn" to={`${base}/products/stores`}>{l(setupText.store)}</Link>}
    </PageHeader>
    <Loaded read={all}>{value => {
      const items = list(value);
      if (!items.length) return <AgentPrompt title={l(copy.pages.productsEmpty)} prompt={l(copy.pages.productsPrompt)} agentHref={`${base}/agent`} />;
      const summary = summarize(items);
      const scope = query ? list(searched.value) : items;
      const counts = filterCounts(scope);
      return <div className="pp-page">
        <SummaryStrip summary={summary} base={base} />
        <p className="pp-note muted"><small>{l(text.noSum)}</small></p>
        {all.nextCursor && <p className="vs-notice">{l(copy.common.more)}</p>}
        {summary.postsWithoutMetrics && <AgentPrompt title={l(text.metricsMissing)} prompt={l(text.metricsPrompt)} agentHref={`${base}/agent`} />}
        <div className="pp-toolbar">
          <div className="vs-filter-row" role="group" aria-label={l(text.filters)}>
            {(Object.keys(filterLabel) as ProductFilter[]).map(key => <button key={key} type="button" aria-pressed={filter === key}
              onClick={() => set({ show: key === 'all' ? null : key })}>{l(filterLabel[key])}
              {(!query || !searched.isPending) && <span className="vs-count"> {counts[key]}</span>}</button>)}
          </div>
          <div className="pp-tools">
            <label className="vs-sr" htmlFor={searchId}>{l(text.search)}</label>
            <input id={searchId} type="search" className="pp-search" value={draft} placeholder={l(text.search)} maxLength={120}
              onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') set({ q: draft.trim() || null }); }} />
            <label className="vs-select pp-sort"><span>{l(text.sort)}</span>
              <select value={sort} onChange={event => set({ sort: event.target.value === 'recent' ? null : event.target.value })} title={l(text.sortNote)}>
                <option value="recent">{l(text.recent)}</option><option value="views">{l(text.byViews)}</option><option value="orders">{l(text.byOrders)}</option>
              </select></label>
          </div>
        </div>
        {query ? <Loaded read={searched}>{found => <ProductGrid items={list(found)} filter={filter} sort={sort} base={base} query={query}
          onClear={() => { setDraft(''); set({ q: null }); }} />}</Loaded>
          : <ProductGrid items={items} filter={filter} sort={sort} base={base} query="" onClear={() => undefined} />}
      </div>;
    }}</Loaded>
  </>;
}
