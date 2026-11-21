import { Link } from 'react-router-dom';
import { AgentPrompt, LineChart, ViewLink, diffDays, formatDateTime, formatNumber, intlLocale, isNum, relativeTime, type LineSeries, type Tuple , platformName } from '@smartsell/ui';
import { copy, fill } from '../copy';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, PageHeader, Section, useFilters, useText } from '../parts';
import {
  accountNames, engagementRate, followersTotal, hasAnyData, platformLabel, readSeriesMetric, seriesCoverage, silentAccounts, socialHeadline, sortAccounts,
  warningText, type SeriesMetric, type SocialAccount, type SocialData, type TopPost,
} from './social-logic';
import { AskAgent, Choice, MeasureTile, MetricValue, Notices, useParam, usePlans } from './social-shared';
import type { PlanInfo } from './ads-logic';

const t = {
  platforms: ['平台', 'Platforms'], allPlatforms: ['全部平台', 'All platforms'],
  views: ['瀏覽', 'Views', '浏览'], engagements: ['互動', 'Engagements', '交互'], followers: ['粉絲', 'Followers', '粉丝'], rate: ['互動率', 'Engagement rate', '交互率'],
  accountsCovered: ['{a}/{b} 個帳號有數據', '{a} of {b} accounts reported', '{a}/{b} 个账号有数据'], rateDefinition: ['互動 ÷ 瀏覽', 'Engagements ÷ views', '交互 ÷ 浏览'],
  fansPartial: ['變化只計算前後兩期都有數據的帳號', 'Change counts only accounts with both periods', '变化只计算前后两期都有数据的账号'],
  trend: ['逐日走勢', 'Daily trend', '逐日走势'], metric: ['指標', 'Metric', '指标'], split: ['顯示方式', 'Show', '显示方式'], total: ['合計', 'Total', '合计'], perAccount: ['各帳號', 'Per account', '各账号'],
  coverageAll: ['每一天都有數據。', 'Every day has data.', '每一天都有数据。'],
  coveragePart: ['{n} 天中有 {k} 天有數據；沒有數據的日子畫成斷點，不當作 0。', '{k} of {n} days have data; days without data are drawn as gaps, not as 0.', '{n} 天中有 {k} 天有数据；没有数据的日子画成断点，不当作 0。'],
  coverageNone: ['這段期間沒有任何一天採集到{m}數據。', 'No day in this period has {m} data.', '这段期间没有任何一天采集到{m}数据。'],
  accounts: ['帳號', 'Accounts', '账号'], account: ['帳號', 'Account', '账号'], posts: ['貼文', 'Posts', '帖子'], lastData: ['最後數據', 'Last data', '最后数据'],
  days: ['{a}/{b} 天', '{a}/{b} days'], neverCollected: ['尚無數據', 'No data yet', '尚无数据'],
  silent: ['{n} 個帳號在這段期間沒有任何數據：{names}', '{n} accounts have no data in this period: {names}', '{n} 个账号在这段期间没有任何数据：{names}'],
  silentPrompt: ['把 {names} 近 {d} 天的貼文與帳號數據匯入 SmartSell', 'Import the last {d} days of posts and account metrics for {names} into SmartSell', '把 {names} 近 {d} 天的帖子与账号数据导入 SmartSell'],
  topPosts: ['Top 作品', 'Top posts'], rankedBy: ['依{m}排序', 'ranked by {m}'], untitled: ['（無標題）', '(untitled)', '（无标题）'], openPost: ['開啟貼文', 'Open post', '打开帖子'],
  plan: ['計劃', 'Plan', '计划'], viewPlan: ['查看', 'View'],
  unranked: ['另有 {n} 則這段期間發布的貼文還沒有{m}數據，未列入排名（未知不當作 0）。', '{n} more posts published in this period have no {m} data yet and are not ranked (unknown is not treated as 0).', '另有 {n} 则这段期间发布的帖子还没有{m}数据，未列入排名（未知不当作 0）。'],
  noRankedTitle: ['這段期間發布的 {n} 則貼文都還沒有{m}數據', 'None of the {n} posts published in this period has {m} data yet', '这段期间发布的 {n} 则帖子都还没有{m}数据'],
  noRankedPrompt: ['把這段期間貼文的瀏覽與互動數據匯入 SmartSell', 'Import views and engagements for the posts published in this period into SmartSell', '把这段期间帖子的浏览与交互数据导入 SmartSell'],
  noPosts: ['這段期間沒有已登記的貼文', 'No posts are registered for this period', '这段期间没有已登记的帖子'],
  emptyTitle: ['還沒有採集到社媒數據', 'No social data collected yet', '还没有采集到社媒数据'],
  emptyDetail: ['帳號已登記，但這段期間沒有瀏覽、互動或粉絲數據。Agent 匯入後會出現在這裡。', 'Your accounts are registered, but there are no views, engagements or followers for this period. They appear here once your agent imports them.', '账号已登记，但这段期间没有浏览、交互或粉丝数据。Agent 导入后会出现在这里。'],
  emptyPosts: ['已有 {n} 則貼文登記在這段期間，但還沒有成效數據。', '{n} posts are registered in this period but have no performance data yet.', '已有 {n} 则帖子登记在这段期间，但还没有成效数据。'],
  importPrompt: ['把 IG 和 TikTok 近 30 天的貼文與帳號數據匯入 SmartSell', 'Import the last 30 days of IG and TikTok posts and account metrics into SmartSell', '把 IG 和 TikTok 近 30 天的帖子与账号数据导入 SmartSell'],
  noAccounts: ['還沒有社群帳號', 'No social accounts yet', '还没有社交媒体账号'], noAccountsPlatform: ['這個平台還沒有社群帳號', 'No social accounts on this platform yet', '这个平台还没有社交媒体账号'],
  noAccountsDetail: ['社群帳號要由你在「設定」登記（Agent 不能代為登記）；登記後再請 Agent 匯入數據。', 'Social accounts must be registered by you in Settings (your agent cannot do it); then ask your agent to import the data.', '社交媒体账号要由你在「设置」登记（Agent 不能代为登记）；登记后再请 Agent 导入数据。'],
  openSettings: ['前往設定登記帳號', 'Register accounts in Settings', '前往设置登记账号'],
} satisfies Record<string, Tuple>;

const metricLabel: Record<SeriesMetric, Tuple> = { views: t.views, engagements: t.engagements };

export function SocialPage() {
  const { l, lang } = useText();
  const { brandId, from, to } = useFilters(30);
  const [platform, setPlatform] = useParam('platform');
  const [metricParam, setMetric] = useParam('metric');
  const metric = readSeriesMetric(metricParam);
  const query = { brand_id: brandId, from, to, metric: metric === 'views' ? undefined : metric };
  // The unfiltered read lists every platform for the chips; without a platform both reads share one cache entry.
  const all = useView<SocialData>('/views/social', query);
  const read = useView<SocialData>('/views/social', { ...query, platform: platform ?? undefined });
  const platforms = [...new Set([...(all.value?.accounts ?? []).map(account => account.platform), platform].filter((value): value is string => !!value))].sort();
  return <>
    <PageHeader title={l(copy.pages.socialTitle)} asOf={read.isPending ? undefined : read.asOf ?? null} timeZone={read.value?.period?.tz} />
    {(platforms.length > 1 || platform) && <Choice label={l(t.platforms)} value={platform ?? ''} onChange={value => setPlatform(value || null)}
      options={[{ value: '', label: l(t.allPlatforms) }, ...platforms.map(value => ({ value, label: platformLabel(value, lang) }))]} />}
    <Loaded read={read}>{view => <SocialBody view={view} brandId={brandId} filtered={Boolean(platform)} metric={metric} setMetric={value => setMetric(value === 'views' ? null : value)} />}</Loaded>
  </>;
}

function SocialBody({ view, brandId, filtered, metric, setMetric }: { view: SocialData; brandId?: string; filtered: boolean; metric: SeriesMetric; setMetric: (value: SeriesMetric) => void }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const plans = usePlans(brandId);
  const accounts = view.accounts ?? [];
  if (!accounts.length) return <div className="vsoc-stack">
    <AgentPrompt title={l(filtered ? t.noAccountsPlatform : t.noAccounts)} detail={l(t.noAccountsDetail)} prompt={l(t.importPrompt)} agentHref={`${base}/agent`} />
    <p><Link className="vs-btn ghost" to={`${base}/settings`}>{l(t.openSettings)}</Link></p>
  </div>;
  const names = accountNames(accounts, lang);
  const any = hasAnyData(view);
  const fans = followersTotal(accounts);
  const rate = engagementRate(accounts);
  const covered = (counted: number, total: number) => counted > 0 && counted < total ? fill(l(t.accountsCovered), { a: counted, b: total }) : null;
  const coverageOf = (name: 'views' | 'engagements') => { const coverage = view.totals?.[name]?.coverage; return coverage ? covered(coverage.observed, coverage.expected) : null; };
  const warnings = (view.warnings ?? []).map(code => warningText[code] ? l(warningText[code]) : code);
  const unranked = view.unranked_count ?? 0;
  return <div className="vsoc-stack">
    <p className="vsx-answer">{socialHeadline(view, lang, names)}</p>
    <div className="vs-kpi-grid">
      <MeasureTile label={l(t.views)} metric={view.totals?.views} note={coverageOf('views')} />
      <MeasureTile label={l(t.engagements)} metric={view.totals?.engagements} note={coverageOf('engagements')} />
      <MeasureTile label={l(t.followers)} metric={fans} delta={fans.delta} note={covered(fans.counted, fans.total) ?? (fans.delta !== null && fans.previous_value === null ? l(t.fansPartial) : null)} />
      <MeasureTile label={l(t.rate)} metric={rate} unit="ratio" note={covered(rate.counted, rate.total) ?? l(t.rateDefinition)} />
    </div>
    <Notices items={warnings} />
    {!any ? <>
      <AgentPrompt title={l(t.emptyTitle)} detail={`${l(t.emptyDetail)}${unranked > 0 ? ` ${fill(l(t.emptyPosts), { n: unranked })}` : ''}`} prompt={l(t.importPrompt)} agentHref={`${base}/agent`} />
      <AccountsSection view={view} accounts={accounts} names={names} />
    </> : <>
      <TrendSection view={view} names={names} metric={metric} setMetric={setMetric} />
      <AccountsSection view={view} accounts={accounts} names={names} />
      <TopPostsSection view={view} names={names} plans={plans} />
    </>}
  </div>;
}

function TrendSection({ view, names, metric, setMetric }: { view: SocialData; names: Map<string, string>; metric: SeriesMetric; setMetric: (value: SeriesMetric) => void }) {
  const { l } = useText();
  const [split, setSplit] = useParam('series');
  const byAccount = view.series?.by_account ?? [];
  const perAccount = split === 'accounts' && byAccount.length >= 2;
  const total = view.series?.total ?? [];
  const series: LineSeries[] = perAccount
    ? byAccount.map(item => ({ key: item.social_account_id, label: names.get(item.social_account_id) ?? item.label, points: item.points }))
    : [{ key: 'total', label: l(t.total), points: total }];
  const coverage = seriesCoverage(total);
  // Name what the drawn data is, which can lag the toggle for a moment while the new metric loads.
  const name = l(metricLabel[readSeriesMetric(view.series?.metric ?? metric)]);
  const note = coverage.known === 0 ? fill(l(t.coverageNone), { m: name }) : coverage.known === coverage.total ? l(t.coverageAll) : fill(l(t.coveragePart), { n: coverage.total, k: coverage.known });
  return <Section title={`${l(t.trend)} · ${name}`} action={<div className="vsx-tools">
    <Choice label={l(t.metric)} value={metric} onChange={setMetric} options={(['views', 'engagements'] as const).map(value => ({ value, label: l(metricLabel[value]) }))} />
    {byAccount.length >= 2 && <Choice label={l(t.split)} value={perAccount ? 'accounts' : 'total'} onChange={value => setSplit(value === 'accounts' ? value : null)}
      options={[{ value: 'total', label: l(t.total) }, { value: 'accounts', label: l(t.perAccount) }]} />}
  </div>}>
    <LineChart title={`${l(t.trend)} · ${name}`} series={series} />
    <p className="vsx-foot muted">{note}</p>
  </Section>;
}

function AccountsSection({ view, accounts, names }: { view: SocialData; accounts: SocialAccount[]; names: Map<string, string> }) {
  const { l, lang } = useText();
  const tz = view.period?.tz;
  const silent = silentAccounts(accounts);
  const days = view.period ? diffDays(view.period.from, view.period.to) + 1 : 30;
  const silentNames = silent.map(account => names.get(account.social_account_id) ?? account.social_account_id).join(lang === 'en' ? ', ' : '、');
  const ordered = sortAccounts(accounts);
  return <Section title={<>{l(t.accounts)} <span className="vs-count">{accounts.length}</span></>}>
    <div className="vsx-table-wrap"><table className="vsx-table">
      <caption className="vs-sr">{l(t.accounts)}</caption>
      <thead><tr>
        <th scope="col">{l(t.account)}</th><th scope="col" className="num">{l(t.followers)}</th><th scope="col" className="num">{l(t.views)}</th>
        <th scope="col" className="num">{l(t.engagements)}</th><th scope="col" className="num">{l(t.rate)}</th><th scope="col" className="num">{l(t.posts)}</th><th scope="col">{l(t.lastData)}</th>
      </tr></thead>
      <tbody>{ordered.map(account => {
        const views = account.metrics?.views;
        const partial = views?.coverage && isNum(views.value) && views.coverage.observed < views.coverage.expected ? fill(l(t.days), { a: views.coverage.observed, b: views.coverage.expected }) : null;
        const delta = account.followers?.delta;
        return <tr key={account.social_account_id}>
          <th scope="row" className="lead"><span className="vsx-platform">{platformLabel(account.platform, lang)}</span>
            <span className="vsx-name">{names.get(account.social_account_id)}</span>{account.handle && <small className="muted">@{account.handle.replace(/^@/, '')}</small>}</th>
          <td className="num" data-label={l(t.followers)}><MetricValue metric={account.followers} />
            {isNum(delta) && <small className={`vsx-change ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`}>{new Intl.NumberFormat(intlLocale(lang), { signDisplay: 'exceptZero' }).format(delta)}</small>}</td>
          <td className="num" data-label={l(t.views)}><MetricValue metric={views} />{partial && <small className="muted">{partial}</small>}</td>
          <td className="num" data-label={l(t.engagements)}><MetricValue metric={account.metrics?.engagements} /></td>
          <td className="num" data-label={l(t.rate)}><MetricValue metric={account.metrics?.engagement_rate} unit="ratio" /></td>
          <td className="num" data-label={l(t.posts)}>{isNum(account.posts_published) ? formatNumber(account.posts_published, lang) : '—'}</td>
          <td data-label={l(t.lastData)}>{account.last_observed_at
            ? <time dateTime={account.last_observed_at} title={formatDateTime(account.last_observed_at, lang, tz)}>{relativeTime(account.last_observed_at, lang)}</time>
            : <span className="muted">{l(t.neverCollected)}</span>}</td>
        </tr>;
      })}</tbody>
    </table></div>
    {silent.length > 0 && silent.length < accounts.length && <AskAgent title={fill(l(t.silent), { n: silent.length, names: silentNames })}
      prompt={fill(l(t.silentPrompt), { names: silentNames, d: days })} />}
  </Section>;
}

function TopPostsSection({ view, names, plans }: { view: SocialData; names: Map<string, string>; plans: Map<string, PlanInfo> }) {
  const { l } = useText();
  const ranking: SeriesMetric = view.series?.metric === 'engagements' ? 'engagements' : 'views';
  const posts = view.top_posts ?? [];
  const unranked = view.unranked_count ?? 0;
  const name = l(metricLabel[ranking]);
  return <Section title={<>{l(t.topPosts)} <small className="muted">{fill(l(t.rankedBy), { m: name })}</small></>}>
    {posts.length ? <ol className="vsoc-posts">{posts.map((post, index) => <PostRow key={post.platform_post_id} post={post} rank={index + 1} names={names} plans={plans} tz={view.period?.tz} />)}</ol>
      : unranked > 0 ? <AskAgent title={fill(l(t.noRankedTitle), { n: unranked, m: name })} prompt={l(t.noRankedPrompt)} />
      : <AskAgent title={l(t.noPosts)} prompt={l(t.importPrompt)} />}
    {posts.length > 0 && unranked > 0 && <p className="vsx-foot muted">{fill(l(t.unranked), { n: unranked, m: name })}</p>}
  </Section>;
}

function PostRow({ post, rank, names, plans, tz }: { post: TopPost; rank: number; names: Map<string, string>; plans: Map<string, PlanInfo>; tz?: string }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const plan = post.campaign_id ? plans.get(post.campaign_id) : undefined;
  const account = post.social_account_id ? names.get(post.social_account_id) : undefined;
  return <li>
    <span className="vsoc-rank"><span className="vs-sr">#</span>{rank}</span>
    <div className="vsoc-post-main">
      <span className="vsoc-post-title">{post.title?.trim() || (post.platform ? `${platformName(post.platform, lang)} ${l(['貼文', 'post', '帖子'])}` : l(t.untitled))}</span>
      <small className="muted">{platformLabel(post.platform, lang)}{account && <> · {account}</>}
        {post.published_at && <> · <time dateTime={post.published_at}>{formatDateTime(post.published_at, lang, tz)}</time></>}
        {post.campaign_id && <> · {l(t.plan)} <Link to={`${base}/plans/${encodeURIComponent(post.campaign_id)}`}>{plan?.name ?? l(t.viewPlan)}</Link></>}</small>
    </div>
    <dl className="vsoc-post-metrics">
      <div><dt>{l(t.views)}</dt><dd><MetricValue metric={post.metrics?.views} /></dd></div>
      <div><dt>{l(t.engagements)}</dt><dd><MetricValue metric={post.metrics?.engagements} /></dd></div>
    </dl>
    {post.permalink && <ViewLink to={post.permalink} className="vs-btn ghost vsoc-open">{l(t.openPost)} <span aria-hidden="true">↗</span></ViewLink>}
  </li>;
}
