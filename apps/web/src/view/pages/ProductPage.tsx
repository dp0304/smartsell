import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError } from '@smartsell/sdk';
import {
  AgentPrompt, AvailabilityTag, BarChart, StatusChip, Timeline, ViewLink, availabilityText, dayIn, formatDateTime, formatDay, formatMeasure, isNum, relativeTime, type Tuple,
} from '@smartsell/ui';
import { fill } from '../copy';
import { todayIn } from '../data/period';
import { useView, useViewContext, workspaceZone } from '../data/use-view';
import { Loaded, PageHeader, Section, useText } from '../parts';
import {
  channelText, detailPrompts, goalLabel, listingFor, marketColumns, platformLabel, priceFlagsInUse, promptText, rankedPosts, roleText, safeLink, storeLine,
  timelineEntryLabel, timelineLanes, timelineWindow, type Listing, type MarketColumn, type ProductDetailView, type ProductPlan, type ProductPost,
  type PromptKey, type TimelineEntry, type VariantRow,
} from './products-logic';
import { AnyStatus, AttentionChips, CreatedVia, Fact, MetricValue, PriceFlags, PriceValue, ProductStatus, ProductThumb, SalesValue, StockChip, flagText } from './products-parts';
import './products.css';

const text = {
  back: ['← 全部商品', '← All products'], notFound: ['找不到這個商品', 'Product not found', '找不到这个商品'],
  notFoundDetail: ['它可能已被刪除，或不在你目前能看到的品牌裡。', 'It may have been deleted, or it belongs to a brand you cannot see.', '它可能已被删除，或不在你目前能看到的品牌里。'],
  markets: ['市場', 'Markets', '市场'], marketsHint: ['缺貨 {a} · 庫存偏低 {b}', '{a} out of stock · {b} low', '缺货 {a} · 库存偏低 {b}'], variants: ['變體', 'Variants', '变体'],
  variantsHint: ['{a} 個販售中', '{a} active', '{a} 个销售中'], live: ['推廣中的計劃', 'Live plans', '推广中的计划'], liveNone: ['沒有', 'None', '没有'], upcoming: ['另有 {n} 個即將開始', '{n} more starting soon', '另有 {n} 个即将开始'],
  next: ['下一則發布', 'Next post', '下一则发布'], notScheduled: ['未排定', 'Nothing scheduled'], next7: ['7 天內 {n} 則', '{n} in the next 7 days', '7 天内 {n} 则'],
  views: ['近 30 天瀏覽', 'Views, 30 days', '近 30 天浏览'], engagements: ['近 30 天互動', 'Engagements, 30 days', '近 30 天交互'], orders: ['近 30 天訂單', 'Orders, 30 days', '近 30 天订单'],
  noPosts: ['近 30 天沒有發布', 'No posts in 30 days', '近 30 天没有发布'], ordersNote: ['含此商品、已記錄在 SmartSell 的訂單', 'Orders recorded in SmartSell that include this product', '含此商品、已记录在 SmartSell 的订单'],
  attention: ['需注意', 'Needs attention'], review: ['去審核', 'Review', '去审核'], seePrices: ['看下方的市場價格', 'See market prices below', '看下方的市场价格'],
  stockOut: ['{m}：缺貨', '{m}: out of stock', '{m}：缺货'], stockLow: ['{m}：庫存偏低', '{m}: low stock', '{m}：库存偏低'],
  attentionHint: ['價格與庫存的變動由同步偵測；商品資訊與在地化草稿要由你審核後才會生效。', 'Price and stock changes are detected by sync; fact and localization drafts take effect only after you review them.', '价格与库存的变动由同步侦测；商品信息与本地化草稿要由你审核后才会生效。'],
  pricing: ['市場價格與庫存', 'Market prices and stock', '市场价格与库存'], allVariants: ['全部變體', 'All variants', '全部变体'], variant: ['變體', 'Variant', '变体'],
  lastRead: ['最後讀取 {t}', 'Last read {t}', '最后读取 {t}'], noPrice: ['價格未提供', 'No price', '价格未提供'], legend: ['標記說明', 'What the marks mean', '标记说明'],
  notCollectedLong: ['還沒有讀到這個變體在此市場的價格或庫存，不代表 0。', 'No price or stock has been read for this variant in this market yet; it is not zero.', '还没有读到这个变体在此市场的价格或库存，不代表 0。'],
  timeline: ['推廣時間線', 'Promotion timeline', '推广时间线'], noTimeline: ['還沒有推廣計劃、排期或貼文', 'No plans, schedules or posts yet', '还没有推广计划、排期或帖子'], asTimeline: ['時間線', 'Timeline', '时间线'], asList: ['列表', 'List'],
  hiddenEntries: ['另有 {n} 筆在半年以外，請看列表', '{n} more are over six months away; see the list', '另有 {n} 笔在半年以外，请看列表'],
  undated: ['{n} 個計劃還沒有日期，未畫在時間線上', '{n} plans have no dates yet and are not drawn', '{n} 个计划还没有日期，未画在时间在线'],
  showAll: ['顯示全部 {n} 筆', 'Show all {n}', '显示全部 {n} 条'], showLess: ['收合', 'Show less'],
  posts: ['相關貼文成效', 'Related post performance', '相关帖子成效'], noPostsYet: ['還沒有帶到這個商品的貼文', 'No posts feature this product yet', '还没有带到这个商品的帖子'], topViews: ['相關貼文瀏覽（已採集的前 {n} 則）', 'Related post views (top {n} collected)', '相关帖子浏览（已采集的前 {n} 则）'],
  unranked: ['{n} 則貼文的瀏覽未採集，未參與排名（不當作 0）。', '{n} posts have no collected views and are not ranked (not treated as zero).', '{n} 则帖子的浏览未采集，未参与排名（不当作 0）。'],
  untitledPost: ['未命名的貼文', 'Untitled post', '未命名的帖子'], openPost: ['在平台上查看', 'View on platform'], postViews: ['瀏覽', 'Views', '浏览'], postEngagements: ['互動', 'Engagements', '交互'],
  plans: ['推廣計劃', 'Promotion plans', '推广计划'], role: ['此商品：{r}', 'This product: {r}'], dayOf: ['第 {a} / {b} 天', 'Day {a} of {b}'],
  completeness: ['內容完成度', 'Content completeness', '内容完成度'], completenessUnknown: ['完成度未知', 'Completeness unknown'],
  matrix: ['已發布 {a} · 已排程 {b} · 缺 {c}', '{a} published · {b} scheduled · {c} missing', '已发布 {a} · 已调度 {b} · 缺 {c}'], nextPub: ['下一則：{t}', 'Next: {t}', '下一则：{t}'],
  decide: ['{n} 項待你決定', '{n} waiting for you', '{n} 项待你决定'], undatedPlan: ['尚未排定日期', 'No dates yet'],
  ask: ['請 Agent 幫忙', 'Ask your agent', '请 Agent 帮忙'],
  kind: { plan: ['推廣計劃', 'Plan', '推广计划'], publish: ['發布排期', 'Scheduled post', '发布排期'], post: ['已發布貼文', 'Published post', '已发布帖子'], change: ['商品變動', 'Product change', '商品变动'], fact: ['商品資訊修訂', 'Fact revision', '商品信息修订'] },
} as const;

const LIVE = ['active', 'paused', 'wrapping'];
const UPCOMING = ['draft', 'planned'];
const planRank = (plan: ProductPlan) => LIVE.includes(String(plan.status)) ? 0 : UPCOMING.includes(String(plan.status)) ? 1 : 2;
const decisionKind: Record<string, string> = { fact_pending: 'fact_revision', localization_stale: 'localization' };

export function ProductPage() {
  const { l } = useText();
  const { id = '' } = useParams();
  const { base } = useViewContext();
  const read = useView<ProductDetailView>(`/views/products/${encodeURIComponent(id)}`, {}, { enabled: Boolean(id) });
  const back = <nav className="pp-back"><ViewLink to={`${base}/products`}>{l(text.back)}</ViewLink></nav>;
  if (read.value === undefined && read.error instanceof ApiError && read.error.status === 404) return <>{back}
    <div className="vs-empty"><strong>{l(text.notFound)}</strong><p className="muted">{l(text.notFoundDetail)}</p></div></>;
  return <>{back}<Loaded read={read}>{product => <ProductBody product={product} asOf={read.asOf ?? product.as_of ?? null} />}</Loaded></>;
}

function ProductBody({ product, asOf }: { product: ProductDetailView; asOf: string | null }) {
  const { l, lang } = useText();
  const { ws, base } = useViewContext();
  const zone = workspaceZone(ws);
  const title = product.title ?? product.id;
  const variants = product.variants ?? [];
  const plans = [...(Array.isArray(product.plans) ? product.plans : [])].sort((a, b) => planRank(a) - planRank(b) || String(a.starts_at ?? '~').localeCompare(String(b.starts_at ?? '~')));
  const live = plans.filter(plan => LIVE.includes(String(plan.status)));
  const upcoming = plans.filter(plan => UPCOMING.includes(String(plan.status)));
  const columns = marketColumns(product.markets ?? [], variants);
  const summaries = columns.map(column => column.summary).filter(Boolean);
  const out = summaries.filter(market => market!.stock?.status === 'out_of_stock');
  const low = summaries.filter(market => market!.stock?.status === 'low');
  const posts = product.posts ?? [];
  const { ranked, unranked } = rankedPosts(posts);
  const quiet = (product.content?.published_30d ?? 0) === 0;
  const store = storeLine(product.store, lang) || undefined;
  const marketName = (market: { market_id: string; market_name: string | null }) => market.market_name ?? market.market_id;

  const planHref = (planId: string) => `${base}/plans/${encodeURIComponent(planId)}`;
  const permalinks = new Map(posts.map(post => [post.platform_post_id, safeLink(post.permalink)]));
  const entryHref = (entry: TimelineEntry) => {
    if (entry.kind === 'plan' && entry.resource?.id) return planHref(entry.resource.id);
    if (entry.kind === 'post' && entry.resource?.id && permalinks.get(entry.resource.id)) return permalinks.get(entry.resource.id)!;
    if (entry.kind === 'publish' || entry.kind === 'post') { const day = dayIn(entry.at, zone); return day ? `${base}/calendar?month=${day.slice(0, 7)}` : `${base}/calendar`; }
    return undefined;
  };
  const { lanes, spans, undatedPlans } = timelineLanes(product, { lang, timeZone: zone, planHref, entryHref });

  // With nothing on the timeline there are no plans either, so the timeline's empty state carries the
  // plan prompt and the plans section is left out. Prompts shown inline are not repeated at the end.
  const timelineEmpty = !lanes.length && !(product.timeline ?? []).length;
  const suggestions = detailPrompts(product);
  const inline = new Set<PromptKey>();
  if (!columns.length) inline.add('prices');
  if (timelineEmpty || !plans.length) inline.add('plan');
  if (!posts.length) inline.add('posts');
  else if (!ranked.length) inline.add('metrics');
  const rest = suggestions.filter(key => !inline.has(key)).slice(0, 3);
  const prompt = (key: PromptKey, heading?: string) => {
    const entry = promptText(key, product.title ?? '');
    return <AgentPrompt key={key} title={heading ?? l(entry.heading)} prompt={l(entry.prompt)} agentHref={`${base}/agent`} />;
  };

  const attention = product.attention ?? [];
  // Stock problems matter while the product is on sale; the card's attention list covers the rest.
  const stockIssues = product.status !== 'active' ? [] : [
    ...out.map(market => ({ status: 'out_of_stock', label: fill(l(text.stockOut), { m: marketName(market!) }) })),
    ...low.map(market => ({ status: 'low', label: fill(l(text.stockLow), { m: marketName(market!) }) })),
  ];

  return <div className="pp-page">
    <PageHeader title={title} subtitle={store} asOf={asOf} timeZone={zone}>
      <ProductStatus status={product.status} /><CreatedVia via={product.created_via} showHuman />
    </PageHeader>

    <div className="pp-hero">
      <ProductThumb title={product.title} imageUrl={product.image_url} size="lg" />
      <div className="pp-facts">
        <Fact label={text.markets} tone={out.length ? 'critical' : low.length ? 'warning' : undefined}>
          <strong>{columns.length}</strong>{(out.length > 0 || low.length > 0) && <small>{fill(l(text.marketsHint), { a: out.length, b: low.length })}</small>}
        </Fact>
        <Fact label={text.variants}><strong>{variants.length}</strong>
          {variants.length > 0 && <small>{fill(l(text.variantsHint), { a: variants.filter(row => row.status !== 'archived').length })}</small>}</Fact>
        <Fact label={text.live}>{live.length ? <span className="pp-fact-links">{live.map(plan => <ViewLink key={plan.id} to={planHref(plan.id)}>{plan.name ?? plan.id}</ViewLink>)}</span>
          : <span className="muted">{l(text.liveNone)}</span>}
          {upcoming.length > 0 && <small>{fill(l(text.upcoming), { n: upcoming.length })}</small>}</Fact>
        <Fact label={text.next}>{product.content?.next_scheduled_at
          ? <time dateTime={product.content.next_scheduled_at}>{formatDateTime(product.content.next_scheduled_at, lang, zone)}</time> : <span className="muted">{l(text.notScheduled)}</span>}
          {isNum(product.content?.scheduled_next_7d) && <small>{fill(l(text.next7), { n: product.content!.scheduled_next_7d! })}</small>}</Fact>
        <Fact label={text.views}><MetricValue metric={product.performance?.views} empty={quiet ? text.noPosts : undefined} /></Fact>
        <Fact label={text.engagements}><MetricValue metric={product.performance?.engagements} empty={quiet ? text.noPosts : undefined} /></Fact>
        <Fact label={text.orders}><SalesValue sales={product.sales} />{product.sales?.visible && <small>{l(text.ordersNote)}</small>}</Fact>
      </div>
    </div>

    {(attention.length > 0 || stockIssues.length > 0) && <Section title={<>{l(text.attention)}<span className="vs-badge">{attention.length + stockIssues.length}</span></>} className="pp-attention-card">
      <ul className="vs-list">
        {stockIssues.map(issue => <li key={issue.label}><StatusChip status={issue.status} tone={issue.status === 'out_of_stock' ? 'critical' : 'warning'} label={issue.label} /></li>)}
        {attention.map((item, index) => <li key={`${item.kind}-${item.resource?.id ?? index}`}>
          <span className="vs-grow"><AttentionChips items={[item]} /></span>
          {decisionKind[item.kind] && <ViewLink to={`${base}/decisions?kind=${decisionKind[item.kind]}`} className="vs-btn">{l(text.review)}</ViewLink>}
          {item.kind === 'price_unpublishable' && <small className="muted">{l(text.seePrices)}</small>}
        </li>)}
      </ul>
      <p className="muted"><small>{l(text.attentionHint)}</small></p>
    </Section>}

    <Section title={l(text.pricing)}>
      {columns.length ? <PriceMatrix columns={columns} variants={variants} product={product} /> : prompt('prices')}
    </Section>

    <Section title={l(text.timeline)} className="pp-timeline-card">
      {timelineEmpty ? prompt('plan', l(text.noTimeline))
        : <TimelineView lanes={lanes} spans={spans} entries={product.timeline ?? []} undatedPlans={undatedPlans} entryHref={entryHref} />}
    </Section>

    <div className={timelineEmpty && !plans.length ? undefined : 'vs-columns'}>
      <Section title={l(text.posts)}>
        {!posts.length ? prompt('posts', l(text.noPostsYet)) : <>
          {ranked.length > 0 && <BarChart title={fill(l(text.topViews), { n: Math.min(8, ranked.length) })} unit="count"
            bars={ranked.slice(0, 8).map(post => ({ key: post.platform_post_id, label: post.title ?? `${platformLabel(post.platform, lang)} ${post.published_at ? formatDay(dayIn(post.published_at, zone), lang) : ''}`.trim(),
              value: post.metrics!.views!.value, availability: post.metrics!.views!.availability }))} />}
          {unranked > 0 && <p className="muted"><small>{fill(l(text.unranked), { n: unranked })}</small></p>}
          {!ranked.length && prompt('metrics')}
          <PostList posts={posts} plans={plans} />
        </>}
      </Section>
      {(plans.length > 0 || !timelineEmpty) && <Section title={l(text.plans)}>
        {plans.length ? <ul className="pp-plans">{plans.map(plan => <PlanItem key={plan.id} plan={plan} productId={product.id} />)}</ul> : prompt('plan')}
      </Section>}
    </div>

    {rest.length > 0 && <Section title={l(text.ask)}><div className="pp-prompts">{rest.map(key => prompt(key))}</div></Section>}
  </div>;
}

function PriceMatrix({ columns, variants, product }: { columns: MarketColumn[]; variants: VariantRow[]; product: ProductDetailView }) {
  const { l, lang } = useText();
  const { ws } = useViewContext();
  const zone = workspaceZone(ws);
  const flags = priceFlagsInUse(product.markets ?? [], variants);
  const anyMissing = variants.some(variant => columns.some(column => { const row = listingFor(variant, column); return !row || row.availability !== 'observed'; }))
    || columns.some(column => !column.summary?.price);
  const read = (at: string | null | undefined) => at ? fill(l(text.lastRead), { t: formatDateTime(at, lang, zone) }) : undefined;
  return <>
    <div className="pp-matrix-scroll" role="region" aria-label={l(text.pricing)} tabIndex={0}>
      <table className="vs-table pp-matrix">
        <thead><tr><th scope="col">{l(text.variant)}</th>{columns.map(column => <th scope="col" key={column.key}>
          {column.market_name ?? column.market_id}{column.showChannel && column.channel && <small className="muted"> · {l(channelText[column.channel] ?? [column.channel, column.channel])}</small>}
        </th>)}</tr></thead>
        <tbody>
          <tr className="pp-matrix-summary"><th scope="row">{l(text.allVariants)}</th>{columns.map(column => <td key={column.key} title={read(column.summary?.price?.observed_at)}>
            <div className="pp-cell"><PriceValue price={column.summary?.price} />{column.summary?.stock && <StockChip stock={column.summary.stock} />}</div>
          </td>)}</tr>
          {variants.map(variant => <tr key={variant.id} className={variant.status === 'archived' ? 'is-archived' : undefined}>
            <th scope="row"><div className="pp-variant"><span>{variant.title ?? variant.sku ?? variant.id}</span>
              {variant.sku && variant.title && <small className="muted">{variant.sku}</small>}
              {variant.status && variant.status !== 'active' && <ProductStatus status={variant.status} />}</div></th>
            {columns.map(column => <ListingCell key={column.key} listing={listingFor(variant, column)} title={read(listingFor(variant, column)?.observed_at)} />)}
          </tr>)}
        </tbody>
      </table>
    </div>
    {(flags.estimate || flags.stale || flags.unpublishable || anyMissing) && <dl className="pp-legend" aria-label={l(text.legend)}>
      {(['estimate', 'stale', 'unpublishable'] as const).filter(key => flags[key]).map(key => <div key={key}>
        <dt><PriceFlags price={key === 'estimate' ? { is_estimate: true } : key === 'stale' ? { stale: true } : { publishable: false }} /></dt><dd>{l(flagText[key].long)}</dd>
      </div>)}
      {anyMissing && <div><dt><AvailabilityTag availability="not_collected" /></dt><dd>{l(text.notCollectedLong)}</dd></div>}
    </dl>}
  </>;
}

function ListingCell({ listing, title }: { listing: Listing | undefined; title?: string }) {
  const { l } = useText();
  if (!listing) return <td><AvailabilityTag availability="not_collected" /></td>;
  if (listing.availability && listing.availability !== 'observed') return <td title={title}><AvailabilityTag availability={listing.availability} /></td>;
  return <td title={title}><div className="pp-cell">
    {isNum(listing.price_minor) ? <PriceValue price={{ min_minor: listing.price_minor, max_minor: listing.price_minor, currency: listing.currency,
      is_estimate: listing.is_estimate, stale: listing.stale, publishable: listing.publishable }} /> : <span className="muted">{l(text.noPrice)}</span>}
    <StockChip status={listing.inventory_status ?? 'unknown'} quantity={listing.inventory_quantity} />
  </div></td>;
}

function TimelineView({ lanes, spans, entries, undatedPlans, entryHref }: {
  lanes: ReturnType<typeof timelineLanes>['lanes']; spans: ReturnType<typeof timelineLanes>['spans']; entries: TimelineEntry[]; undatedPlans: number;
  entryHref: (entry: TimelineEntry) => string | undefined;
}) {
  const { l, lang } = useText();
  const { ws } = useViewContext();
  const zone = workspaceZone(ws);
  const today = todayIn(zone);
  const [mode, setMode] = useState<'timeline' | 'list'>(lanes.length ? 'timeline' : 'list');
  const [all, setAll] = useState(false);
  const window = timelineWindow(today, spans);
  const sorted = [...entries].filter(entry => entry.at).sort((a, b) => b.at.localeCompare(a.at));
  const listed = all ? sorted : sorted.slice(0, 12);
  return <div className="pp-timeline">
    {lanes.length > 0 && <div className="vs-chart-head"><span />
      <button type="button" className="vs-chart-toggle" aria-pressed={mode === 'list'} onClick={() => setMode(mode === 'list' ? 'timeline' : 'list')}>
        {l(mode === 'list' ? text.asTimeline : text.asList)}</button></div>}
    {mode === 'timeline' ? <>
      <Timeline lanes={lanes} from={window.from} to={window.to} today={today} timeZone={zone} />
      <ul className="vs-legend pp-lane-legend">
        {window.hidden > 0 && <li className="muted">{fill(l(text.hiddenEntries), { n: window.hidden })}</li>}
        {undatedPlans > 0 && <li className="muted">{fill(l(text.undated), { n: undatedPlans })}</li>}
      </ul>
    </> : <>
      <ol className="vs-list pp-entries">{listed.map((entry, index) => {
        const href = entryHref(entry);
        const label = timelineEntryLabel(entry, lang);
        return <li key={`${entry.kind}-${entry.resource?.id ?? index}`}>
          <time className="vs-when" dateTime={entry.at}>{formatDateTime(entry.at, lang, zone)}</time>
          <small className="pp-kind">{l((text.kind as Record<string, Tuple>)[entry.kind] ?? [entry.kind, entry.kind])}</small>
          <span className="vs-grow">{href ? <ViewLink to={href}>{label}</ViewLink> : label}</span>
          {entry.status && <AnyStatus status={entry.status} />}
        </li>;
      })}</ol>
      {sorted.length > 12 && <button type="button" className="vs-link-button" onClick={() => setAll(!all)}>{all ? l(text.showLess) : fill(l(text.showAll), { n: sorted.length })}</button>}
    </>}
  </div>;
}

function PostList({ posts, plans }: { posts: ProductPost[]; plans: ProductPlan[] }) {
  const { l, lang } = useText();
  const { ws, base } = useViewContext();
  const zone = workspaceZone(ws);
  const [all, setAll] = useState(false);
  const names = new Map(plans.map(plan => [plan.id, plan.name]));
  const shown = all ? posts : posts.slice(0, 8);
  return <>
    <ol className="vs-list pp-posts">{shown.map(post => {
      const link = safeLink(post.permalink);
      const label = post.title ?? l(text.untitledPost);
      return <li key={post.platform_post_id}>
        <div className="pp-post-head">
          {post.platform && <span className="pp-platform">{platformLabel(post.platform, lang)}</span>}
          <span className="vs-grow">{link ? <a href={link} target="_blank" rel="noreferrer noopener" title={l(text.openPost)}>{label}</a> : label}</span>
          {post.published_at && <time className="muted" dateTime={post.published_at} title={formatDateTime(post.published_at, lang, zone)}>{relativeTime(post.published_at, lang)}</time>}
        </div>
        <dl className="pp-post-metrics">
          <div><dt>{l(text.postViews)}</dt><dd><MetricValue metric={post.metrics?.views} /></dd></div>
          <div><dt>{l(text.postEngagements)}</dt><dd><MetricValue metric={post.metrics?.engagements} /></dd></div>
          {post.campaign_id && names.has(post.campaign_id) && <div><dt>{l(text.plans)}</dt><dd>
            <ViewLink to={`${base}/plans/${encodeURIComponent(post.campaign_id)}`}>{names.get(post.campaign_id) ?? post.campaign_id}</ViewLink></dd></div>}
        </dl>
      </li>;
    })}</ol>
    {posts.length > 8 && <button type="button" className="vs-link-button" onClick={() => setAll(!all)}>{all ? l(text.showLess) : fill(l(text.showAll), { n: posts.length })}</button>}
  </>;
}

function PlanItem({ plan, productId }: { plan: ProductPlan; productId: string }) {
  const { l, lang } = useText();
  const { ws, base } = useViewContext();
  const zone = plan.timezone ?? workspaceZone(ws);
  const href = `${base}/plans/${encodeURIComponent(plan.id)}`;
  const role = plan.products?.find(row => row.product_id === productId)?.role;
  const matrix = plan.matrix;
  const ratio = matrix?.completeness_ratio;
  const day = (value: string | null) => value ? formatDay(dayIn(value, zone), lang) : '—';
  return <li className="pp-plan">
    <div className="vs-row-head"><ViewLink to={href} className="pp-plan-name">{plan.name ?? plan.id}</ViewLink><StatusChip status={plan.status} /></div>
    <small className="muted">{plan.starts_at ? <>{day(plan.starts_at)} – {day(plan.ends_at)}</> : l(text.undatedPlan)}
      {isNum(plan.day) && isNum(plan.days) && <> · {fill(l(text.dayOf), { a: plan.day, b: plan.days })}</>}
      {role && <> · {fill(l(text.role), { r: l(roleText[role] ?? [role, role]) })}</>}</small>
    {isNum(ratio) ? <div className="pp-meter-row"><div className="vs-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)} aria-label={l(text.completeness)}>
      <span style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} /></div><small>{l(text.completeness)} {Math.round(ratio * 100)}%</small></div>
      : <small className="muted">{l(text.completenessUnknown)}</small>}
    {(plan.goals ?? []).length > 0 && <ul className="pp-goals">{(plan.goals ?? []).slice(0, 3).map((goal, index) => {
      const unit = goal.unit === 'currency' ? 'currency' : goal.unit === 'ratio' || goal.unit === 'percent' ? goal.unit : 'count';
      const target = isNum(goal.target_value) ? formatMeasure(goal.target_value, unit, goal.currency, lang, true) : '—';
      return <li key={goal.goal_id ?? index}><span className="muted">{l(goalLabel(goal.metric_key))}</span>
        {isNum(goal.value) ? <strong>{formatMeasure(goal.value, unit, goal.currency, lang, true)}</strong> : <AvailabilityTag availability={availabilityText[goal.coverage_status ?? ''] ? goal.coverage_status : 'not_collected'} />}
        <small className="muted">/ {target}{isNum(goal.progress_percent) && ` · ${Math.round(goal.progress_percent)}%`}</small></li>;
    })}</ul>}
    {matrix && isNum(matrix.planned) && matrix.planned > 0 && <small className="muted">{fill(l(text.matrix), { a: matrix.published ?? 0, b: matrix.scheduled ?? 0, c: matrix.gap ?? 0 })}</small>}
    {plan.next_publication?.scheduled_at && <small>{fill(l(text.nextPub), { t: `${formatDateTime(plan.next_publication.scheduled_at, lang, zone)}${plan.next_publication.title ? ` · ${plan.next_publication.title}` : ''}` })}</small>}
    <div className="pp-badges">
      {isNum(plan.needs_decision) && plan.needs_decision > 0 && <ViewLink to={`${base}/decisions?campaign=${encodeURIComponent(plan.id)}`} className="pp-decide">{fill(l(text.decide), { n: plan.needs_decision })}</ViewLink>}
      <CreatedVia via={plan.created_via} />
    </div>
  </li>;
}
