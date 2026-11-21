import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { Panel, Pill } from '@smartsell/ui';
import { callOperation, findOperation, ProblemNotice, ReadState, recordRows, stringValue, useApi, useRead, wsKey } from './api';
import { useCopy } from './i18n';

export const setupLabel = ['首次設定', 'Initial setup'] as const;
const flow = 'initial_setup_v1';
const steps: Record<string, { name: readonly [string, string]; impact: readonly [string, string] }> = {
  brand: { name: ['品牌', 'Brand'], impact: ['品牌作業需要有效的品牌', 'Brand-scoped operations require an active brand'] },
  market: { name: ['市場', 'Market'], impact: ['本地化內容需要已設定的市場', 'Localized content requires a configured market'] },
  social_account: { name: ['社群帳號', 'Social account'], impact: ['發布需要具備可用能力的帳號', 'Social publishing requires an account with an available capability'] },
  connector_pairing: { name: ['連接器與手機配對', 'Connector and phone pairing'], impact: ['需要相容且在線的連接器，使用手機時也要確認 App 登入身分', 'An online compatible connector is required, with verified App identity when using a phone'] },
  product_source: { name: ['商品來源', 'Product source'], impact: ['商品作業需要已連接的店鋪或有效的商品資料來源', 'Product-assisted work requires a connected store or active product data source'] },
  history_sync: { name: ['歷史資料同步', 'History sync'], impact: ['歷史指標及比較可能不完整', 'Historical metrics and comparisons may be incomplete'] },
  test_draft: { name: ['測試草稿', 'Test draft'], impact: ['團隊尚未建立草稿', 'The team has yet to create a draft'] },
  invite_team: { name: ['邀請團隊', 'Invite team'], impact: ['其他成員可能無法接續設定', 'Other members may lack access to continue setup'] },
};
/** Where each setup step is completed in the workspace. */
export const setupStepRoutes: Record<string, string> = {
  brand: 'settings/brands', market: 'settings/brands', social_account: 'settings/accounts', connector_pairing: 'settings/devices',
  product_source: 'commerce/stores', history_sync: 'data/sources', test_draft: 'content', invite_team: 'access',
};
export const setupStepNames = Object.fromEntries(Object.entries(steps).map(([key, step]) => [key, step.name]));
const statuses: Record<string, readonly [string, string]> = {
  // A failed check only means the prerequisite is missing, so it reads as unfinished rather than blocked.
  not_started: ['尚未開始', 'Not started'], blocked: ['未完成', 'Not done yet'],
  done: ['已完成', 'Done'], skipped: ['已略過', 'Skipped'],
};

function SetupStep({ row }: { row: RecordData }) {
  const { label, locale, t } = useCopy();
  const api = useApi();
  const client = useQueryClient();
  const [skipping, setSkipping] = useState(false);
  const key = stringValue(row.step_key);
  const status = stringValue(row.status);
  const step = steps[key];
  const check = findOperation(api, 'POST', '/onboarding/:flow/steps/:step/check', 'workspace');
  const skip = findOperation(api, 'POST', '/onboarding/:flow/steps/:step/skip', 'workspace');
  const mutation = useMutation({
    mutationFn: ({ reason }: { reason?: string }) => callOperation(api, (reason ? skip : check)!, [flow, key], { body: reason ? { reason } : {} }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: wsKey(api.ws) });
      setSkipping(false);
    },
  });
  const result = asRecord(row.check_result);
  const impact = result.impact && status !== 'done' ? locale === 'zh-Hant' && step ? label(step.impact) : stringValue(result.impact) : '';
  function submitSkip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    if (reason) mutation.mutate({ reason });
  }
  return <section className="detail-block" aria-labelledby={`setup-${key}`}>
    <div className="panel-head"><h2 id={`setup-${key}`}>{step ? label(step.name) : key}</h2>
      <Pill tone={status === 'blocked' ? 'warning' : status === 'done' ? 'good' : 'neutral'}>{statuses[status] ? label(statuses[status]) : status}</Pill></div>
    {impact && <p>{impact}</p>}
    {result.reason === 'app_identity_mismatch' && <p>{label(['手機 App 的登入身分與綁定帳號不符', 'The phone App is signed in to a different account'])}</p>}
    {typeof row.skip_reason === 'string' && <p>{row.skip_reason}</p>}
    {mutation.isError && <ProblemNotice error={mutation.error} />}
    <div className="action-row">
      {setupStepRoutes[key] && status !== 'done' && <Link className="button primary" to={`/w/${encodeURIComponent(api.ws)}/${setupStepRoutes[key]}`}>{label(['前往處理', 'Go to step'])}</Link>}
      {check && <button disabled={mutation.isPending} onClick={() => mutation.mutate({})}>{label(['檢查步驟', 'Check step'])}</button>}
      {skip && status !== 'done' && status !== 'skipped' && !skipping && <button disabled={mutation.isPending} onClick={() => setSkipping(true)}>{label(['略過步驟', 'Skip step'])}</button>}
    </div>
    {skipping && <form className="action-row" onSubmit={submitSkip}>
      <label>{label(['略過原因', 'Reason for skipping'])} <input name="reason" required maxLength={1000} pattern=".*\S.*" /></label>
      <button type="submit" disabled={mutation.isPending}>{label(['確認略過', 'Confirm skip'])}</button>
      <button type="button" disabled={mutation.isPending} onClick={() => setSkipping(false)}>{t('cancel')}</button>
    </form>}
  </section>;
}

export function WorkspaceOnboarding() {
  const { label } = useCopy();
  const read = useRead('/onboarding/:flow', [flow], {}, 'workspace');
  const rows = recordRows(read.data?.data) ?? [];
  const resume = rows.find(row => row.status === 'blocked') ?? rows.find(row => row.status === 'not_started');
  return <>
    <header className="page-head"><h1>{label(setupLabel)}</h1></header>
    <Panel><ReadState read={read} />
      {resume && <p><a href={`#setup-${stringValue(resume.step_key)}`}>{label(['繼續設定', 'Resume setup'])}</a></p>}
      {rows.map(row => <SetupStep key={stringValue(row.step_key)} row={row} />)}
    </Panel>
  </>;
}
