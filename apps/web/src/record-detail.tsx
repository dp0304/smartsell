import { useState } from 'react';
import { EntityTable } from '@smartsell/ui';
import { actions } from './action-index';
import { asEntity, commandId, useCommandRead, values } from './workbench-data';
import { Detail, Empty, Failure, Status, recordName, statusOf, useFormat } from './workbench-ui';
import { ContentDetails } from './workbench-content';
import { AgentAssistant } from './agent-assistant';
import type { Command, Entity, Payload } from './workbench-api';
import { CreatorAccounts, CreatorAudience, CreatorDeliverables, CreatorEvaluations, CreatorLivePlans, CreatorProfileRelations, CreatorTermsComparison } from './creator-detail';

const readers: Record<string, [string, string, string?]> = {
  'campaign.campaign': ['get_context', 'campaign_id'],
  'content.content_item': ['content_get', 'content_item_id'],
  'content.content_variant': ['content_get_variant', 'variant_id'],
  'planning.publish_target': ['get_target', 'target_id'],
  'execution.execution_task': ['get_task', 'task_id'],
  'analytics.report': ['reports_get', 'report_id'],
  'analytics.report_version': ['reports_get', 'version_id'],
  'commerce.product': ['catalog_get_product', 'product_id'],
  'creator.creator': ['creators_get', 'creator_id'],
  'creator.collaboration': ['collaborations_get', 'collaboration_id'],
};
const relations: Record<string, [string, string, string?]> = {
  revisions: ['content', 'variant_revision'],
  versions: ['analytics', 'report_version'], publish_targets: ['planning', 'publish_target'],
  platform_posts: ['execution', 'platform_post'], prechecks: ['planning', 'precheck'],
  attempts: ['execution', 'attempt'], stage_history: ['content', 'stage_history'],
  tasks: ['workspace', 'work_item'], approved_facts: ['commerce', 'product_fact', 'fact'],
};

export function RecordDetail({ wid, role, initial, commands, open }: { wid: string; role: string; initial: Entity; commands: Command[]; open: (command: Command, record?: Entity) => void }) {
  const { t, label } = useFormat();
  const [related, setRelated] = useState<Entity>();
  const row = related ?? initial;
  const approval = initial.kind === 'approval_request';
  const [action = '', field = ''] = approval ? ['get_target', 'target_id'] : readers[`${row.module}.${row.kind}`] ?? [];
  const id = approval ? initial.data.target_id : row.id;
  const read = useCommandRead<Payload>(wid, commands, row.module, action, { [field]: id }, Boolean(action && id));
  const rich = read.data;
  const entity = rich && asEntity(rich[row.kind === 'content_item' ? 'item' : row.kind === 'content_variant' ? 'variant' : row.kind] ?? rich, row.module, row.kind);
  const shown = entity && !approval ? entity : row;
  const binding = approval && rich ? asEntity(rich, 'planning', 'publish_target') : undefined;
  const reviewTarget = binding ?? (row.module === 'planning' && row.kind === 'publish_target' ? entity : undefined);
  const pendingReview = reviewTarget?.data.status === 'awaiting_approval';
  const eligible = useCommandRead<Entity[]>(wid, commands, 'planning', 'list_approvals', {}, pendingReview);
  const canReview = pendingReview && eligible.data?.some(request =>
    request.id === reviewTarget.data.approval_id && request.data.frozen_hash === reviewTarget.data.frozen_hash &&
    (!approval || request.id === initial.id));
  const shownActions = commands.filter(command => {
    const spec = actions[commandId(command)];
    if (!spec || command.module !== row.module || command.action === action) return false;
    if (command.module === 'planning' && ['approve', 'reject', 'request_changes'].includes(command.action)) return canReview;
    return spec.target === row.kind;
  });
  const contentRecord = shown.module === 'content' && shown.kind === 'content_variant' ? { ...shown, data: {
    ...shown.data, base_revision_id: JSON.stringify(shown.data.current_revision_id ?? null), source_revision_id: shown.data.current_revision_id,
  } } : shown;
  return <>
    {related && <button className="wb-text" onClick={() => setRelated(undefined)}>{t('ui.backToRecord', { name: recordName(initial) })}</button>}
    {row.module === 'creator' && row.kind === 'creator' && <>
      <CreatorAudience profile={shown} />
      {rich && <CreatorAccounts accounts={rich.accounts} commands={commands} open={open} />}
      <CreatorProfileRelations wid={wid} profile={shown} commands={commands} open={open} />
    </>}
    {row.module === 'campaign' && row.kind === 'campaign' && <CreatorEvaluations wid={wid} campaignId={row.id} commands={commands} open={open} />}
    {row.module === 'creator' && row.kind === 'collaboration' && rich && <>
      <CreatorDeliverables wid={wid} deliverables={rich.deliverable} commands={commands} open={open} />
      <CreatorLivePlans wid={wid} collaborationId={row.id} plans={rich.live_session} commands={commands} open={open} />
      <CreatorTermsComparison revisions={rich.collaboration_terms} />
    </>}
    {shown.module !== 'content' && <Detail record={shown} />}
    {read.permitted && read.isPending && id && <p role="status">{t('ui.loading')}</p>}
    {read.isError && <Failure error={read.error} retry={() => void read.refetch()} />}
    {binding && <p>{t('ui.approvalBinding', { version: binding.version })}</p>}
    {shown.module === 'content' && rich && <ContentDetails row={shown} detail={rich} commands={commands} open={open} select={setRelated} />}
    <div className="wb-inline-actions">{shownActions.map(command => <button key={commandId(command)} onClick={() => open(command, binding ?? contentRecord)}>{label('command', commandId(command), actions[commandId(command)].label)}</button>)}</div>
    {rich && Object.entries(relations).map(([key, [module, kind, nested]]) => {
      if (!rich[key]) return null;
      const records = values(rich[key]).flatMap(value => asEntity(nested ? (value as Payload)?.[nested] : value, module, kind) ?? []);
      return <section key={key}><h3>{label('relation', key)}</h3>{records.length ? <EntityTable records={records} rowKey={record => record.id} columns={[
        { label: t('ui.record'), cell: record => <button className="wb-text" onClick={() => setRelated(record)}>{record.data.revision_no || record.data.version_no ? `${t('field.version')} ${record.data.revision_no ?? record.data.version_no}` : recordName(record)}</button> },
        { label: t('ui.status'), cell: record => <Status value={statusOf(record)} /> },
      ]} /> : <Empty>{t('ui.empty')}</Empty>}</section>;
    })}
    {shown.module === 'content' && <Detail record={shown} />}
    <AgentAssistant key={shown.id} wid={wid} page={shown.module} row={shown} role={role} />
    {rich && <details><summary>{t('ui.serverDetails')}</summary><pre>{JSON.stringify(rich, null, 2)}</pre></details>}
  </>;
}
