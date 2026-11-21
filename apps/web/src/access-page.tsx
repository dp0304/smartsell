import { useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EntityTable } from '@smartsell/ui';
import { ApiError, api, type Workspace } from './workbench-api';
import { Dialog, Empty, Failure, useFormat } from './workbench-ui';

interface Member { id: string; user_id: string; role: string; scopes: string[] }
const scopesLabel = ['資源範圍 ID（每行一筆）', 'Resource scope IDs (one per line)', '资源范围 ID（每行一笔）'] as const;
const roles = ['owner', 'admin', 'editor', 'reviewer', 'viewer'] as const;

export function AccessPage({ workspace, userId }: { workspace: Workspace; userId: string }) {
  const { t, label } = useFormat();
  const currentRoleHeading = useId();
  const client = useQueryClient();
  const [editing, setEditing] = useState<Member | 'invite'>();
  const catalog = useQuery({ queryKey: ['workspace', workspace.id, 'permission-operations'], queryFn: ({ signal }) => api.permissionOperations(workspace.id, signal) });
  const allowed = (name: string) => catalog.data?.some(op => op.name === name);
  const members = useQuery({ queryKey: ['workspace', workspace.id, 'members'], enabled: Boolean(allowed('team_members_list')), queryFn: ({ signal }) => api.members<Member>(workspace.id, signal) });
  const open = (member: Member) => member.user_id !== userId && (workspace.role === 'owner' || !['owner', 'admin'].includes(member.role));
  return <><header className="wb-pagehead"><div><p className="wb-kicker">{workspace.name}</p><h1>{t('nav.access')}</h1></div>
    {members.isSuccess && allowed('team_member_invite') && <button className="wb-primary" onClick={() => setEditing('invite')}>{t('ui.inviteMember')}</button>}</header>
    <section className="wb-card" aria-labelledby={currentRoleHeading}><header className="wb-cardhead"><h2 id={currentRoleHeading}>{t('ui.currentAccess')}</h2><strong>{label('state', workspace.role)}</strong></header></section>
    <section className="wb-card"><h2>{t('kind.member')}</h2>
      {catalog.isPending || (members.isPending && members.fetchStatus !== 'idle') ? <p className="wb-note" role="status">{t('ui.loading')}</p> : null}
      {catalog.isError && !(catalog.error instanceof ApiError && catalog.error.status === 404) && <Failure error={catalog.error} retry={() => void catalog.refetch()} />}
      {(catalog.isSuccess && !allowed('team_members_list') || catalog.error instanceof ApiError && catalog.error.status === 404) && <Empty>{t('ui.endpointUnavailable')}</Empty>}
      {members.isError && <><Failure error={members.error} retry={() => void members.refetch()} />
        {members.error instanceof ApiError && members.error.status === 503 && <p className="wb-note">{label('ui', 'memberServiceUnavailable', ['此部署的成員管理服務尚未啟用。', 'Membership management is not enabled in this deployment.', '此部署的成员管理服务尚未激活。'])}</p>}
      </>}
      {members.data && (members.data.length ? <EntityTable records={members.data} rowKey={row => row.id} columns={[
        { label: t('kind.member'), cell: row => row.user_id }, { label: t('field.role'), cell: row => label('state', row.role) },
        { label: label('field', 'scopes', scopesLabel), cell: row => row.scopes?.join(', ') || '—' },
        { label: t('ui.action'), cell: row => open(row) && allowed('team_member_roles_update') ? <button onClick={() => setEditing(row)}>{t('ui.editRole')}</button> : '—' },
      ]} /> : <Empty>{t('ui.empty')}</Empty>)}
    </section>{editing && <MemberForm workspace={workspace} editing={editing} close={() => setEditing(undefined)} onSave={() => void client.invalidateQueries({ queryKey: ['workspace', workspace.id, 'members'] })} />}</>;
}

function MemberForm({ workspace, editing, close, onSave }: { workspace: Workspace; editing: Member | 'invite'; close: () => void; onSave: () => void }) {
  const { t, label } = useFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<unknown>();
  const invite = editing === 'invite';
  const title = t(invite ? 'ui.inviteMember' : 'ui.editRole');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const scopes = [...new Set(String(data.get('scopes') ?? '').split(/\r?\n/).map(scope => scope.trim()).filter(Boolean))];
      setResult(await api.saveMember(workspace.id, invite ? undefined : editing.id, { role: data.get('role'), scopes, ...(invite && { email: data.get('email') }) }));
      onSave();
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  return <Dialog title={title} close={close}><form className="wb-form" onSubmit={submit}><fieldset disabled={busy || result !== undefined}>
    {invite && <label>{t('ui.email')}<input name="email" type="email" required /></label>}
    <label>{t('field.role')}<select name="role" defaultValue={invite ? 'viewer' : editing.role}>{roles.filter(role => role !== 'owner' && (workspace.role === 'owner' || role !== 'admin')).map(role => <option key={role} value={role}>{label('state', role)}</option>)}</select></label>
    <label>{label('field', 'scopes', scopesLabel)}<textarea name="scopes" rows={3} defaultValue={invite ? '' : editing.scopes?.join('\n')} /></label>
    <button className="wb-primary">{busy ? t('ui.loading') : title}</button>
  </fieldset></form>{error != null && <Failure error={error} />}{result != null && <div className="wb-result" role="status"><strong>{t('ui.succeeded')}</strong><pre>{JSON.stringify(result, null, 2)}</pre></div>}</Dialog>;
}
