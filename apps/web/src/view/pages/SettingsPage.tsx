import { languages } from '../../locale';
import { Link } from 'react-router-dom';
import { AgentPrompt, Glyph, StatusChip, formatDateTime, intlLocale, relativeTime, type Lang } from '@smartsell/ui';
import { useCopy } from '../../i18n';
import { optionLabel } from '../../option-labels';
import { copy, fill } from '../copy';
import { agentState, connectionState } from '../data/logic';
import type { AgentConnection } from '../data/types';
import { useView, useViewContext, type ViewResult } from '../data/use-view';
import { Loaded, PageHeader, Section, useFilters, useText } from '../parts';
import { AccountsSection } from './settings-accounts';
import { roleText, scopeNames, setupTones, splitPauses, type CheckTone, type PauseSwitch, type Row } from './settings-logic';
import { PauseSection } from './settings-pause';
import { text } from './settings-text';
import { setupText } from './setup-copy';
import { canSetUp } from './setup-data';
import './settings.css';

interface ContextView { role?: string; timezone?: string | null; brands?: Row[]; markets?: Row[] }
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((row): row is Row => !!row && typeof row === 'object') : [];
const toneGlyph: Record<CheckTone, string> = { good: 'check', warning: 'warning', critical: 'critical', neutral: 'neutral' };

function region(code: unknown, lang: Lang) {
  if (typeof code !== 'string' || !code) return undefined;
  try { return new Intl.DisplayNames([intlLocale(lang)], { type: 'region' }).of(code.toUpperCase()) ?? code; } catch { return code; }
}

function Summary({ context, accounts, pauses, connections }: {
  context: ViewResult<ContextView>; accounts: ViewResult<Row[]>; pauses: ViewResult<PauseSwitch[]>; connections: ViewResult<AgentConnection[]>;
}) {
  const { l } = useText();
  const known = <T,>(read: ViewResult<T>) => read.value !== undefined;
  const active = known(pauses) ? splitPauses(pauses.value).active.length : undefined;
  const brands = known(context) ? rows(context.value?.brands).length : undefined;
  const markets = known(context) ? rows(context.value?.markets).length : undefined;
  const accountList = known(accounts) ? rows(accounts.value) : undefined;
  const activeAccounts = accountList?.filter(row => row.status === 'active').length;
  const agent = known(connections) ? agentState(rows(connections.value) as unknown as AgentConnection[]) : undefined;
  const tones = setupTones({ pauses: active, brands, markets, accounts: accountList?.length, activeAccounts, agent });
  const unknown = l(text.unknown);
  const items: [string, string, CheckTone, string][] = [
    ['st-pause', l(text.pauseTitle), tones.publishing, active === undefined ? unknown : active ? fill(l(text.publishingPaused), { n: active }) : l(text.publishingOk)],
    ['st-brands', l(copy.pages.brands), tones.brands, brands === undefined ? unknown : brands === 0 ? l(copy.pages.noBrands) : markets === 0 ? `${fill(l(text.brandsOnly), { b: brands })} · ${l(text.noMarkets)}` : fill(l(text.brandsCount), { b: brands, m: markets ?? '—' })],
    ['st-accounts', l(text.accountsTitle), tones.accounts, !accountList ? unknown : !accountList.length ? l(text.accountsNone) : activeAccounts === 0 ? fill(l(text.accountsNoneActive), { n: accountList.length }) : fill(l(text.accountsCount), { n: accountList.length })],
    ['st-agent', l(copy.nav.agent), tones.agent, agent === undefined || agent === 'unknown' ? unknown : agent === 'none' ? l(text.agentNone) : l(text.agentConnected)],
  ];
  return <section className="vs-span-2 st-summary" aria-label={l(text.summary)}>
    <ul>{items.map(([anchor, label, tone, value]) => <li key={anchor} className={`st-check tone-${tone}`}>
      <a href={`#${anchor}`}><Glyph name={toneGlyph[tone]} size={16} /><span><small>{label}</small><strong>{value}</strong></span></a>
    </li>)}</ul>
  </section>;
}

function BrandMarkets({ brand }: { brand: Row }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const id = String(brand.id);
  const read = useView<Row[]>(`/brands/${encodeURIComponent(id)}/markets`);
  const brandName = String(brand.name ?? brand.id);
  return <Loaded read={read}>{items => {
    const markets = rows(items).sort((a, b) => Number(b.id === brand.default_market_id) - Number(a.id === brand.default_market_id) || Number(a.status !== 'active') - Number(b.status !== 'active'));
    if (!markets.length) return brand.status === 'archived' ? <p className="muted"><small>—</small></p>
      : <AgentPrompt title={fill(l(text.marketsEmpty), { brand: brandName })} prompt={fill(l(text.marketsPrompt), { brand: brandName })} agentHref={`${base}/agent`} />;
    return <ul className="vs-list st-markets">{markets.map(market => <li key={String(market.id)}>
      <span className="vs-grow"><span className="st-market-name">{String(market.name ?? market.country_code ?? market.id)}</span>
        {market.id === brand.default_market_id && <span className="vs-tag">{l(text.defaultMarket)}</span>}<br />
        <small className="muted">{[market.name ? (typeof market.country_code === 'string' ? market.country_code.toUpperCase() : undefined) : region(market.country_code, lang), typeof market.primary_language === 'string' ? optionLabel(market.primary_language, lang) : undefined,
          market.currency, market.timezone].filter(Boolean).map(String).join(' · ')}</small></span>
      {market.status !== 'active' && <StatusChip status={String(market.status ?? 'unknown')} />}
    </li>)}</ul>;
  }}</Loaded>;
}

function BrandsSection({ brandId }: { brandId?: string }) {
  const { l } = useText();
  const { base } = useViewContext();
  const read = useView<Row[]>('/brands');
  return <Section title={<span id="st-brands">{l(copy.pages.brands)}</span>}>
    <p className="muted"><small>{l(text.brandsHint)}</small></p>
    <Loaded read={read}>{items => {
      const all = rows(items).sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived'));
      const brands = brandId ? all.filter(row => row.id === brandId) : all;
      if (!brands.length) return <AgentPrompt title={l(copy.pages.noBrands)} prompt={l(copy.pages.brandsPrompt)} agentHref={`${base}/agent`} />;
      return <>
        <ul className="st-brands">{brands.map(brand => <li key={String(brand.id)}>
          <div className="vs-row-head"><h3>{String(brand.name ?? brand.id)}</h3>{brand.status === 'archived' ? <StatusChip status="archived" label={text.archived} /> : brand.status && brand.status !== 'active' ? <StatusChip status={String(brand.status)} /> : null}</div>
          <BrandMarkets brand={brand} />
        </li>)}</ul>
        {read.nextCursor && <p className="muted"><small>{l(copy.common.more)}</small></p>}
        <details className="st-more"><summary>{l(text.addMoreTitle)}</summary><AgentPrompt title={l(text.addMoreDetail)} prompt={l(text.brandsMore)} agentHref={`${base}/agent`} /></details>
      </>;
    }}</Loaded>
  </Section>;
}

function MembersSection({ brandNames, role }: { brandNames: ReadonlyMap<string, string>; role?: string }) {
  const { l } = useText();
  const { ws, session } = useViewContext();
  const read = useView<Row[]>('/members', { limit: '200' });
  const roleLabel = (value: unknown) => typeof value === 'string' && roleText[value] ? l(roleText[value]) : String(value ?? '—');
  return <Section title={<span id="st-members">{l(copy.pages.members)}</span>}
    action={<Link className="vs-btn" to={`/w/${encodeURIComponent(ws)}/access`}>{l(text.manageMembers)}</Link>}>
    <p className="muted"><small>{l(text.membersHint)}{role && <> · {l(text.role)}：{roleLabel(role)}</>}</small></p>
    <Loaded read={read}>{items => {
      const members = rows(items).sort((a, b) => Number(b.user_id === session.user.id) - Number(a.user_id === session.user.id));
      if (!members.length) return <p className="muted">{l(text.membersEmpty)}</p>;
      let unnamed = false;
      const list = <ul className="vs-list st-members">{members.map(member => {
        const self = member.user_id === session.user.id;
        const given = [member.name, member.display_name, member.email].find(value => typeof value === 'string' && value) as string | undefined;
        const display = self ? `${session.user.name || session.user.email || l(text.member)}${l(text.you)}` : given ?? `${l(text.member)} ${String(member.user_id ?? member.id ?? '').slice(0, 8)}`;
        if (!self && !given) unnamed = true;
        const scopes = scopeNames(member.scopes, brandNames);
        return <li key={String(member.id ?? member.user_id)}>
          <span className="vs-avatar" aria-hidden="true">{self || given ? display.slice(0, 1).toUpperCase() : <Glyph name="user" />}</span>
          <span className="vs-grow"><span className={!self && !given ? 'muted' : undefined}>{display}</span><br />
            <small className="muted">{scopes.length ? `${l(text.limitedScopes)}${scopes.join('、')}` : l(text.allScopes)}</small></span>
          <StatusChip status={String(member.role ?? 'unknown')} label={roleText[String(member.role)]} tone={member.role === 'owner' || member.role === 'admin' ? 'info' : 'neutral'} />
        </li>;
      })}</ul>;
      return <>{list}{unnamed && <p className="muted"><small>{l(text.membersUnnamed)}</small></p>}</>;
    }}</Loaded>
  </Section>;
}

function AgentSection({ connections }: { connections: ViewResult<AgentConnection[]> }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  return <Section title={<span id="st-agent">{l(copy.nav.agent)}</span>}>
    <p className="muted"><small>{l(text.agentHint)}</small></p>
    <Loaded read={connections}>{items => {
      const list = rows(items) as unknown as AgentConnection[];
      const state = agentState(list);
      const live = list.filter(item => connectionState(item) === 'active');
      const last = live.map(item => item.last_used_at).filter((value): value is string => !!value).sort().at(-1);
      return <div className="st-agent">
        <div className="vs-row-head"><StatusChip status={state === 'none' ? 'pending' : state === 'unknown' ? 'unknown' : 'connected'} label={copy.agentStatus[state]} />
          {live.length > 0 && <small className="muted">{fill(l(text.agentCount), { n: live.length })}</small>}</div>
        {live.length > 0 && <small className="muted">{l(text.agentLastUsed)}{last ? <time dateTime={last} title={formatDateTime(last, lang)}>{relativeTime(last, lang)}</time> : l(text.agentNever)}</small>}
        {state === 'none' && <p className="muted"><small>{l(copy.overview.connectAgentDetail)}</small></p>}
      </div>;
    }}</Loaded>
    <div className="vs-actions"><Link className="vs-btn primary-soft" to={`${base}/agent`}>{l(text.openAgent)}</Link></div>
  </Section>;
}

function LanguageSection() {
  const { l } = useText();
  const { locale, setLanguage } = useCopy();
  return <Section title={<span id="st-language">{l(copy.shell.language)}</span>}>
    <div className="vs-filter-row" role="group" aria-label={l(copy.shell.language)}>
      {languages.map(({ code, name }) => <button key={code} type="button" lang={code} aria-pressed={locale === code} onClick={() => setLanguage(code)}>{name}</button>)}
    </div>
    <p className="muted"><small>{l(text.languageHint)}</small></p>
  </Section>;
}

function AdvancedSection() {
  const { l } = useText();
  const { ws } = useViewContext();
  const advanced = `/w/${encodeURIComponent(ws)}`;
  return <Section title={<span id="st-advanced">{l(copy.nav.advanced)}</span>}>
    <p>{l(text.advancedHint)}</p>
    <div className="vs-actions"><Link className="vs-btn" to={`${advanced}/home`}>{l(text.openAdvanced)}</Link></div>
    <ul className="vs-list st-links">
      <li><Link to={`${advanced}/settings/accounts`}>{l(text.authorize)}</Link></li>
      <li><Link to={`${advanced}/access`}>{l(copy.pages.members)}</Link></li>
      <li><Link to={`${advanced}/settings/security`}>{l(copy.pages.security)}</Link></li>
    </ul>
  </Section>;
}

/** Settings: the few things only a person does (register owned accounts, pause and release publishing) plus read-only setup facts. */
export function SettingsPage() {
  const { l } = useText();
  const { workspace, base } = useViewContext();
  const { brandId } = useFilters();
  const context = useView<ContextView>('/context', { brand_id: brandId });
  const brands = useView<Row[]>('/brands');
  const accounts = useView<Row[]>('/social-accounts', { brand_id: brandId, limit: '200' });
  // Pauses are never hidden by the brand filter, so their scope names come from the unfiltered account list.
  const everyAccount = useView<Row[]>('/social-accounts', { limit: '200' }, { enabled: Boolean(brandId) });
  const pauses = useView<PauseSwitch[]>('/pause-switches', { limit: '200' });
  const connections = useView<AgentConnection[]>('/agent-connections');
  const role = workspace.role ?? context.value?.role;
  const timeZone = typeof context.value?.timezone === 'string' ? context.value.timezone : undefined;
  const brandRows = rows(brands.value);
  const accountRows = rows((brandId ? everyAccount : accounts).value);
  const brandNames = new Map(brandRows.map(row => [String(row.id), String(row.name ?? row.id)]));
  const paused = new Set(splitPauses(pauses.value).active.filter(row => row.scope_type === 'social_account').map(row => String(row.scope_id)));
  return <>
    <PageHeader title={l(copy.pages.settingsTitle)} subtitle={l(text.subtitle)}>
      {canSetUp(workspace.role) && <Link className="vs-btn" to={`${base}/get-started`}>{l(setupText.title)}</Link>}
      {role && <span className="vs-tag st-role">{l(text.role)}：{roleText[role] ? l(roleText[role]) : role}</span>}
    </PageHeader>
    <div className="vs-columns st-page">
      <Summary context={context} accounts={accounts} pauses={pauses} connections={connections} />
      <PauseSection pauses={pauses} brands={brandRows} accounts={accountRows} role={role} timeZone={timeZone} />
      <BrandsSection brandId={brandId} />
      <AccountsSection accounts={accounts} brands={brandRows} brandsLoaded={Array.isArray(brands.value)} markets={rows(context.value?.markets)} role={role} brandId={brandId}
        workspaceZone={context.value?.timezone} pausedAccounts={paused} />
      <MembersSection brandNames={brandNames} role={role} />
      <AgentSection connections={connections} />
      <LanguageSection />
      <AdvancedSection />
    </div>
  </>;
}
