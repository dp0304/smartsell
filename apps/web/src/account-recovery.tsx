import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ProblemNotice, wsKey } from './api';
import { accountSecurityApi, type MigrationImpact, type MigrationTarget, type RecoveryImpact } from './account-security-api';
import { useCopy } from './i18n';

type Api = ReturnType<typeof accountSecurityApi>;
type QueryKey = readonly string[];

export function AccountRecovery({ workspace, csrf }: { workspace: { id: string; name: string }; csrf: string }) {
  const { t } = useCopy();
  const api = accountSecurityApi(workspace.id, csrf);
  const key = [...wsKey(workspace.id), 'account-recovery'];
  const accounts = useQuery({ queryKey: [...key, 'accounts'], queryFn: ({ signal }) => api.accounts(signal) });
  const devices = useQuery({ queryKey: [...key, 'devices'], queryFn: ({ signal }) => api.devices(signal) });
  const phones = useQuery({ queryKey: [...key, 'phones'], queryFn: ({ signal }) => api.phones(signal) });
  const apps = useQuery({ queryKey: [...key, 'apps'], queryFn: ({ signal }) => api.appBindings(signal) });
  const [account, setAccount] = useState('');
  const deviceName = (id: string) => devices.data?.find(device => device.id === id)?.name || id;
  const phoneName = (id: string) => {
    const phone = phones.data?.find(phone => phone.id === id);
    return phone && (phone.model || phone.serial_suffix) ? [phone.model, phone.serial_suffix].filter(Boolean).join(' · ') : id;
  };

  return <section className="panel" aria-labelledby="account-recovery-title">
    <header className="panel-head"><div><h2 id="account-recovery-title">{t('recovery.title')}</h2><p>{workspace.name}</p></div></header>
    <section className="detail-block account-recovery-section" aria-labelledby="migration-title">
      <h3 id="migration-title">{t('recovery.migration')}</h3>
      <p>{t('recovery.migrationHint')}</p>
      {accounts.isPending && <p role="status">{t('loading')}</p>}
      {accounts.isError && <ProblemNotice error={accounts.error} retry={() => void accounts.refetch()} />}
      {accounts.isSuccess && <label className="field">{t('recovery.account')}
        <select value={account} onChange={event => setAccount(event.target.value)}>
          <option value="">{t('select')}</option>
          {accounts.data.map(row => <option key={row.id} value={row.id}>{row.display_name || row.id} · {row.provider}</option>)}
        </select>
      </label>}
      {accounts.data?.some(row => row.id === account) && <BindingMigration key={account} api={api} account={account} queryKey={key}
        devices={(devices.data ?? []).filter(device => device.status === 'active' && device.online).map(device => ({ id: device.id, label: device.name || device.id }))}
        mobileOptions={(apps.data ?? []).flatMap(app => {
          const phone = phones.data?.find(row => row.id === app.mobile_device_id && row.status === 'ready');
          return app.status !== 'revoked' && app.social_account_id === account && phone ? [{ id: app.id, device: phone.device_id, phone: phone.id, app: app.app, label: `${phoneName(phone.id)} · ${app.app}` }] : [];
        })}
        deviceName={deviceName} phoneName={phoneName} />}
    </section>
    <section className="detail-block account-recovery-section" aria-labelledby="device-revoke-title">
      <h3 id="device-revoke-title">{t('recovery.revoke')}</h3>
      <p>{t('recovery.revokeHint')}</p>
      {devices.isPending && <p role="status">{t('loading')}</p>}
      {devices.isError && <ProblemNotice error={devices.error} retry={() => void devices.refetch()} />}
      {devices.isSuccess && <RecoveryAction key="device" label="recovery.device" action="recovery.revoke" queryKey={key}
        options={devices.data.filter(device => device.status !== 'revoked').map(device => ({ id: device.id, label: deviceName(device.id) }))}
        preview={api.revokePreview} execute={api.revokeDevice} />}
    </section>
    <section className="detail-block account-recovery-section" aria-labelledby="mobile-unbind-title">
      <h3 id="mobile-unbind-title">{t('recovery.unbind')}</h3>
      <p>{t('recovery.unbindHint')}</p>
      {apps.isPending && <p role="status">{t('loading')}</p>}
      {apps.isError && <ProblemNotice error={apps.error} retry={() => void apps.refetch()} />}
      {phones.isError && <ProblemNotice error={phones.error} retry={() => void phones.refetch()} />}
      {apps.isSuccess && <RecoveryAction key="app" label="recovery.appBinding" action="recovery.unbind" queryKey={key}
        options={apps.data.filter(row => row.status !== 'revoked').map(row => ({ id: row.id, label: `${row.app} · ${phoneName(row.mobile_device_id)} · ${accounts.data?.find(account => account.id === row.social_account_id)?.display_name || row.social_account_id}` }))}
        preview={api.unbindPreview} execute={api.unbindApp} />}
    </section>
  </section>;
}

type Option = { id: string; label: string };
type MobileOption = Option & { device: string; phone: string; app: string };

function BindingMigration({ api, account, queryKey, devices, mobileOptions, deviceName, phoneName }: {
  api: Api; account: string; queryKey: QueryKey; devices: Option[]; mobileOptions: MobileOption[];
  deviceName: (id: string) => string; phoneName: (id: string) => string;
}) {
  const { t } = useCopy();
  const client = useQueryClient();
  const key = [...queryKey, 'migration', account];
  const state = useQuery({ queryKey: key, queryFn: ({ signal }) => api.migrationState(account, signal),
    refetchInterval: query => query.state.data?.migration?.status === 'draining' ? 5_000 : false });
  const [previewOpen, setPreviewOpen] = useState(false);
  const preview = useQuery({ queryKey: [...key, 'preview'], queryFn: ({ signal }) => api.migrationPreview(account, signal), enabled: previewOpen });
  const [channel, setChannel] = useState<'browser' | 'mobile'>('browser');
  const [deviceId, setDeviceId] = useState('');
  const [mobileId, setMobileId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const mobile = mobileOptions.find(option => option.id === mobileId && devices.some(device => device.id === option.device));
  const target: MigrationTarget | undefined = channel === 'mobile'
    ? mobile && { connector_channel: channel, device_id: mobile.device, mobile_device_id: mobile.phone, mobile_app: mobile.app, owned_account_confirmed: true }
    : devices.some(device => device.id === deviceId) ? { connector_channel: channel, device_id: deviceId, owned_account_confirmed: true } : undefined;
  const update = useMutation({
    mutationFn: (target: MigrationTarget | null) => target ? api.startMigration(account, target) : api.completeMigration(account),
    onSuccess: async data => {
      client.setQueryData(key, data);
      setConfirmed(false);
      setPreviewOpen(false);
      await client.invalidateQueries({ queryKey });
    },
  });

  if (state.isPending) return <p role="status">{t('loading')}</p>;
  if (state.isError) return <ProblemNotice error={state.error} retry={() => void state.refetch()} />;
  if (!state.data.impact) return <p>{t('recovery.noBinding')}</p>;
  const { migration, impact } = state.data;
  const draining = migration?.status === 'draining';
  const describe = (channel: 'browser' | 'mobile', device: string, phone?: string | null) =>
    [t(`recovery.${channel}`), deviceName(device), phone && phoneName(phone)].filter(Boolean).join(' · ');

  return <div className="account-recovery-flow">
    {migration && <>
      <p role="status"><strong>{t(draining ? 'recovery.drainingStatus' : 'state.completed')}</strong></p>
      <p>{t('recovery.source')} · {describe(migration.source_connector_channel, migration.source_device_id, migration.source_mobile_device_id)}</p>
      <p>{t('recovery.destination')} · {describe(migration.target_connector_channel, migration.target_device_id, migration.target_mobile_device_id)}</p>
      {draining && <p>{t('recovery.verifyTarget')}</p>}
      {draining && migration.target_session_id && <p>{t('recovery.targetSession')} · <code>{migration.target_session_id}</code></p>}
      <MigrationTasks impact={impact} />
      <div className="toolbar">
        <button type="button" disabled={state.isFetching || update.isPending} onClick={() => void state.refetch()}>{t('refresh')}</button>
        {draining && <button type="button" className="primary" disabled={state.isFetching || update.isPending} onClick={() => update.mutate(null)}>{t(update.isPending ? 'saving' : 'recovery.complete')}</button>}
      </div>
    </>}
    {!draining && <>
      <div><button type="button" disabled={preview.isFetching || update.isPending} onClick={() => previewOpen ? void preview.refetch() : setPreviewOpen(true)}>{t('recovery.preview')}</button></div>
      {previewOpen && preview.isPending && <p role="status">{t('loading')}</p>}
      {previewOpen && preview.isError && <ProblemNotice error={preview.error} retry={() => void preview.refetch()} />}
      {previewOpen && preview.isSuccess && <>
        <MigrationTasks impact={preview.data} />
        <form className="fields" onSubmit={event => { event.preventDefault(); if (target && confirmed && !preview.isFetching && !update.isPending) update.mutate(target); }}>
          <fieldset disabled={update.isPending || preview.isFetching}>
            <label className="field">{t('recovery.channel')}
              <select value={channel} onChange={event => { setChannel(event.target.value === 'mobile' ? 'mobile' : 'browser'); setConfirmed(false); }}>
                <option value="browser">{t('recovery.browser')}</option><option value="mobile">{t('recovery.mobile')}</option>
              </select>
            </label>
            {channel === 'browser' ? <OptionSelect label="recovery.device" options={devices} value={deviceId} change={id => { setDeviceId(id); setConfirmed(false); }} /> :
              <OptionSelect label="recovery.appBinding" options={mobileOptions.filter(option => devices.some(device => device.id === option.device))} value={mobileId} change={id => { setMobileId(id); setConfirmed(false); }} />}
            <label><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> {t('recovery.confirmMigration')}</label>
            <div><button type="submit" className="primary" disabled={!target || !confirmed}>{t(update.isPending ? 'saving' : 'recovery.start')}</button></div>
          </fieldset>
        </form>
      </>}
    </>}
    {update.isError && <ProblemNotice error={update.error} />}
  </div>;
}

function MigrationTasks({ impact }: { impact: MigrationImpact }) {
  const { t } = useCopy();
  return <div className="account-recovery-impact" aria-label={t('recovery.impact')}>
    {(['queued', 'draining', 'retained'] as const).map(group => <div key={group}>
      <h4>{t(`recovery.${group}`)} ({impact[group].length})</h4>
      {impact[group].length > 0 && <ul>{impact[group].map(task => <li key={task.id}><code>{task.id}</code> · {t(`state.${task.status}`, { defaultValue: task.status })}</li>)}</ul>}
    </div>)}
  </div>;
}

function OptionSelect({ label, options, value, change }: { label: string; options: Option[]; value: string; change: (id: string) => void }) {
  const { t } = useCopy();
  return <label className="field">{t(label)}
    <select value={value} onChange={event => change(event.target.value)} disabled={!options.length}>
      <option value="">{t(options.length ? 'select' : 'recovery.noOptions')}</option>
      {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  </label>;
}

function RecoveryAction({ label, action, options, queryKey, preview, execute }: {
  label: string; action: 'recovery.revoke' | 'recovery.unbind'; options: Option[]; queryKey: QueryKey;
  preview: (id: string) => Promise<RecoveryImpact & { can_unbind?: boolean }>; execute: (id: string) => Promise<RecoveryImpact>;
}) {
  const { t } = useCopy();
  const client = useQueryClient();
  const [id, setId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const review = useMutation({ mutationFn: preview });
  const update = useMutation({ mutationFn: execute, onSuccess: async () => {
    setId('');
    setConfirmed(false);
    review.reset();
    await client.invalidateQueries({ queryKey });
  } });
  const selected = options.some(option => option.id === id);
  const busy = review.isPending || update.isPending;
  const impact = selected && review.variables === id ? review.data : undefined;
  return <div className="account-recovery-flow">
    <fieldset disabled={busy} className="account-recovery-flow">
      <OptionSelect label={label} value={id} options={options} change={next => { setId(next); setConfirmed(false); review.reset(); update.reset(); }} />
      <div><button type="button" disabled={!selected} onClick={() => { setConfirmed(false); update.reset(); review.mutate(id); }}>{t(review.isPending ? 'loading' : 'recovery.preview')}</button></div>
      {impact && <>
        <RecoveryTasks impact={impact} />
        {impact.can_unbind === false ? <p role="status">{t('recovery.moveFirst')}</p> : <>
          <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> {t('confirmAction')}</label>
          <div><button type="button" className="primary" disabled={!confirmed} onClick={() => update.mutate(id)}>{t(update.isPending ? 'saving' : action)}</button></div>
        </>}
      </>}
    </fieldset>
    {review.isError && <ProblemNotice error={review.error} />}
    {update.isError && <ProblemNotice error={update.error} />}
    {update.isSuccess && <p role="status">{t(action === 'recovery.unbind' ? 'recovery.unbound' : 'recovery.revoked')}</p>}
    {update.isSuccess && action === 'recovery.unbind' && <p>{t('recovery.debugGuidance')}</p>}
  </div>;
}

function RecoveryTasks({ impact }: { impact: RecoveryImpact }) {
  const { t } = useCopy();
  return <div className="account-recovery-impact" aria-label={t('recovery.impact')}>
    {(['social_account_ids', 'execution_task_ids', 'connector_task_ids'] as const).map(group => <div key={group}>
      <h4>{t(`recovery.${group}`)} ({impact[group].length})</h4>
      {impact[group].length > 0 && <ul>{impact[group].map((id, index) => <li key={`${id}-${index}`}><code>{id}</code></li>)}</ul>}
    </div>)}
  </div>;
}
