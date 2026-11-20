import { useSearchParams } from 'react-router-dom';
import { Glyph, decisionKindText, isNum, pick, type DecisionItem } from '@smartsell/ui';
import { copy } from '../copy';
import { useView } from '../data/use-view';
import { groupByKind } from '../data/logic';
import type { DecisionSummary } from '../data/types';
import { DecisionEntry, Loaded, PageHeader, UnfinishedDecisions, useFilters, useText } from '../parts';

export function DecisionsPage() {
  const { l, lang } = useText();
  const [params, setParams] = useSearchParams();
  const { brandId } = useFilters();
  const kind = params.get('kind') ?? '';
  // Plan pages link here with ?campaign= so only that plan's decisions show.
  const campaign = params.get('campaign') ?? '';
  // Chips count the same brand and plan scope as the list; kind is left out so every kind keeps its count.
  const scope = { brand_id: brandId, campaign_id: campaign };
  const summary = useView<DecisionSummary>('/views/decisions/summary', scope);
  const read = useView<DecisionItem[]>('/views/decisions', { ...scope, kind, limit: '100' });
  const clearCampaign = () => { const query = new URLSearchParams(params); query.delete('campaign'); setParams(query, { replace: true }); };
  const counts = summary.value?.counts ?? {};
  const total = summary.value?.total;
  const kinds = Object.keys(counts).filter(key => counts[key] > 0 || key === kind);
  if (kind && !kinds.includes(kind)) kinds.push(kind);
  const choose = (next: string) => { const query = new URLSearchParams(params); if (next) query.set('kind', next); else query.delete('kind'); setParams(query, { replace: true }); };
  const kindLabel = (key: string) => pick(decisionKindText[key] ?? [key, key], lang);
  return <>
    <PageHeader title={l(copy.decisions.title)} subtitle={l(copy.decisions.subtitle)} asOf={read.isPending ? undefined : read.asOf ?? summary.value?.as_of ?? null} />
    {kinds.length > 0 && <div className="vs-filter-row" role="group" aria-label={l(copy.decisions.kinds)}>
      <button type="button" aria-pressed={!kind} onClick={() => choose('')}>{l(copy.decisions.all)}{isNum(total) && <span className="vs-count"> {total}</span>}</button>
      {kinds.map(key => <button key={key} type="button" aria-pressed={kind === key} onClick={() => choose(key)}>{kindLabel(key)}{isNum(counts[key]) && <span className="vs-count"> {counts[key]}</span>}</button>)}
    </div>}
    {campaign && <div className="vs-filter-row"><button type="button" aria-pressed="true" onClick={clearCampaign}>
      {l(['只看這個推廣計劃', 'This promotion plan only'])} ×</button></div>}
    <UnfinishedDecisions />
    <Loaded read={read}>{items => {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return <div className="vs-empty"><span className="vs-empty-mark tone-good"><Glyph name="check" size={22} /></span><strong>{l(copy.decisions.empty)}</strong><p className="muted">{l(copy.decisions.emptyDetail)}</p></div>;
      return <>
        {groupByKind(list).map(([group, entries]) => <section key={group} className="vs-decision-group">
          {!kind && <h2>{kindLabel(group)} <span className="vs-count">{entries.length}</span></h2>}
          <div className="vs-decision-list">{entries.map(item => <DecisionEntry key={item.id} item={item} />)}</div>
        </section>)}
        {read.nextCursor && <p className="vs-notice">{l(copy.common.more)}</p>}
      </>;
    }}</Loaded>
  </>;
}
