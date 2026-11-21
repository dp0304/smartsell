import { viewLanguage } from '../locale';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '@smartsell/sdk';
import { Busy, DecisionCard, Freshness, decisionKindText, pick, type DecisionItem, type ResourceRef } from '@smartsell/ui';
import { ProblemNotice } from '../api';
import { useCopy } from '../i18n';
import { copy, fill } from './copy';
import { readPeriod } from './data/period';
import { leavesList, useDecide, useUnfinishedDecisions, useViewContext, type DecisionOutcome, type ViewResult } from './data/use-view';

export function useText() {
  const { label, locale } = useCopy();
  return { l: label, lang: viewLanguage(locale) };
}

/** Brand and period filters live in the URL so links and reloads keep the same slice. */
export function useFilters(defaultDays = 7) {
  const [params] = useSearchParams();
  const period = readPeriod(params, defaultDays);
  return { brandId: params.get('brand') ?? undefined, from: period.from, to: period.to, period, params };
}

export function PageHeader({ title, subtitle, asOf, timeZone, children }: { title: string; subtitle?: string; asOf?: string | null; timeZone?: string; children?: ReactNode }) {
  return <header className="vs-page-head">
    <div><h1>{title}</h1>{subtitle && <p className="muted">{subtitle}</p>}</div>
    <div className="vs-page-tools">{asOf !== undefined && <Freshness asOf={asOf} timeZone={timeZone} />}{children}</div>
  </header>;
}

export function Section({ title, action, children, className = '' }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`vs-card ${className}`}><header className="vs-card-head"><h2>{title}</h2>{action}</header>{children}</section>;
}

/** Loading, error and refetch framing for one read; the previous render stays visible while refetching. */
export function Loaded<T>({ read, children }: { read: ViewResult<T>; children: (value: T) => ReactNode }) {
  const { l } = useText();
  const { t } = useCopy();
  if (read.isPending) return <Busy label={t('loading')} />;
  if (read.value === undefined) {
    if (read.error instanceof ApiError && read.error.status === 404) return <div className="vs-notice">{l(copy.common.notFound)}</div>;
    if (read.error instanceof ApiError && [405, 501].includes(read.error.status)) return <div className="vs-notice">{l(copy.common.notAvailable)}</div>;
    return <ProblemNotice error={read.error} retry={() => void read.refetch()} />;
  }
  return <div className={read.isPlaceholderData ? 'vs-refetching' : undefined} aria-busy={read.isFetching || undefined}>
    {read.isError && <div className="vs-notice">{l(copy.common.refreshFailed)}</div>}
    {children(read.value)}
  </div>;
}

/** A dashboard route for a resource reference, when the dashboard has a page for it. */
export function resourcePath(base: string, resource: ResourceRef | null | undefined): string | undefined {
  if (!resource?.id) return undefined;
  const id = encodeURIComponent(resource.id);
  switch (resource.type) {
    case 'product': return `${base}/products/${id}`;
    case 'campaign': case 'plan': return `${base}/plans/${id}`;
    case 'agent_job': return `${base}/agent`;
    case 'publish_target': case 'platform_post': return `${base}/calendar`;
    case 'ad_proposal': return `${base}/ads`;
    default: return undefined;
  }
}

export function DecisionEntry({ item, compact = false, timeZone }: { item: DecisionItem; compact?: boolean; timeZone?: string }) {
  const { base } = useViewContext();
  const { l } = useText();
  const decide = useDecide();
  // An outcome belongs to the version that was decided: a multi-step approval comes back as a new version with new actions.
  const signature = JSON.stringify([item.resource.version ?? null, item.actions.map(action => [action.key, action.version ?? null])]);
  const [decided, setDecided] = useState<{ outcome: DecisionOutcome; signature: string } | null>(null);
  const outcome = decided?.signature === signature ? decided.outcome : null;
  // A blocked decision leaves the actions open; anything carried out (or no longer decidable) locks the card.
  const done = outcome !== null && outcome.kind !== 'blocked';
  const code = decide.error instanceof ApiError ? String(decide.error.problem.code ?? '') : '';
  const conflict = decide.error instanceof ApiError && ([412, 428].includes(decide.error.status) || ['VERSION_CONFLICT', 'APPROVAL_STALE'].includes(code));
  return <DecisionCard item={item} compact={compact} timeZone={timeZone} href={resourcePath(base, item.resource)}
    busyKey={decide.isPending ? decide.variables?.action.key : done ? 'done' : null}
    onAction={(action, reason) => { setDecided(null); decide.mutate({ item, action, reason }, { onSuccess: next => setDecided({ outcome: next, signature }) }); }}
    error={outcome && !decide.isPending ? <OutcomeNotice outcome={outcome} /> : decide.isError ? <>
      {conflict && <p className="vs-notice" role="alert">{l(copy.decisions.conflict)}</p>}<ProblemNotice error={decide.error} />
    </> : undefined} />;
}

function OutcomeNotice({ outcome }: { outcome: DecisionOutcome }) {
  const { l } = useText();
  if (outcome.kind === 'done') return <p className="vs-notice good" role="status">{l(copy.decisions.done)}</p>;
  if (outcome.kind === 'blocked') return <div className="vs-notice" role="alert"><p>{l(copy.decisions.blocked)}</p>
    {outcome.blockers.length > 0 && <ul>{outcome.blockers.map((text, index) => <li key={index}>{text}</li>)}</ul>}</div>;
  return <p className="vs-notice" role="alert">{unfinishedText(outcome, l)}</p>;
}

function unfinishedText(outcome: Exclude<DecisionOutcome, { kind: 'done' | 'blocked' }>, l: ReturnType<typeof useText>['l']) {
  if (outcome.kind === 'partial') return fill(l(copy.decisions.partial), { n: outcome.skipped });
  return l(outcome.kind === 'expired' ? copy.decisions.expired : copy.decisions.stale);
}

/** Decisions the server answered without carrying out; their cards have left the list, so the notice stays here until dismissed. */
export function UnfinishedDecisions() {
  const { l, lang } = useText();
  const { list, dismiss } = useUnfinishedDecisions();
  if (!list.length) return null;
  return <section className="vs-unfinished" aria-label={l(copy.decisions.unfinished)}>
    {list.map(entry => <div key={entry.id} className="vs-notice" role="alert">
      <p><strong>{pick(decisionKindText[entry.kind] ?? [entry.kind, entry.kind], lang)}｜{entry.title}</strong></p>
      <p>{unfinishedText(entry.outcome, l)}</p>
      <button type="button" onClick={() => dismiss(entry.id)}>{l(copy.decisions.dismiss)}</button>
    </div>)}
  </section>;
}

export function RouterLink({ to, className, children, title }: { to: string; className?: string; children: ReactNode; title?: string }) {
  if (/^https?:\/\//i.test(to)) return <a href={to} className={className} title={title} target="_blank" rel="noreferrer noopener">{children}</a>;
  // Links built from read-model data never become script or other-scheme URLs.
  if (!to.startsWith('/') || to.startsWith('//')) return <span className={className} title={title}>{children}</span>;
  return <Link to={to} className={className} title={title}>{children}</Link>;
}
