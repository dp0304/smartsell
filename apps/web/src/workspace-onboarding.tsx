import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { Panel, Pill } from '@smartsell/ui';
import { callOperation, findOperation, ProblemNotice, ReadState, recordRows, stringValue, useApi, useRead, wsKey } from './api';
import { useCopy } from './i18n';

export const setupLabel = ['首次設定', 'Initial setup', '首次设置'] as const;
const flow = 'initial_setup_v1';
const steps: Record<string, { name: readonly [string, string, string?]; impact: readonly [string, string, string?] }> = {
  brand: { name: ['品牌', 'Brand'], impact: ['品牌作業需要有效的品牌', 'Brand-scoped operations require an active brand', '品牌作业需要有效的品牌'] },
  market: { name: ['市場', 'Market', '市场'], impact: ['本地化內容需要已設定的市場', 'Localized content requires a configured market', '本地化内容需要已设置的市场'] },
  social_account: { name: ['社群帳號', 'Social account', '社交媒体账号'], impact: ['發布需要具備可用能力的帳號', 'Social publishing requires an account with an available capability', '发布需要具备可用能力的账号'] },
  connector_pairing: { name: ['連接器與手機配對', 'Connector and phone pairing', '连接器与手机配对'], impact: ['需要相容且在線的連接器，使用手機時也要確認 App 登入身分', 'An online compatible connector is required, with verified App identity when using a phone', '需要兼容且在线的连接器，使用手机时也要确认 App 登录身分'] },
  product_source: { name: ['商品來源', 'Product source', '商品来源'], impact: ['商品作業需要已連接的店鋪或有效的商品資料來源', 'Product-assisted work requires a connected store or active product data source', '商品作业需要已连接的店铺或有效的商品数据源'] },
  history_sync: { name: ['歷史資料同步', 'History sync', '历史数据同步'], impact: ['歷史指標及比較可能不完整', 'Historical metrics and comparisons may be incomplete', '历史指标及比较可能不完整'] },
  test_draft: { name: ['測試草稿', 'Test draft', '测试草稿'], impact: ['團隊尚未建立草稿', 'The team has yet to create a draft', '团队尚未创建草稿'] },
  invite_team: { name: ['邀請團隊', 'Invite team', '邀请团队'], impact: ['其他成員可能無法接續設定', 'Other members may lack access to continue setup', '其他成员可能无法接续设置'] },
};
/** Where each setup step is completed in the workspace. */
export const setupStepRoutes: Record<string, string> = {
  brand: 'settings/brands', market: 'settings/brands', social_account: 'settings/accounts', connector_pairing: 'settings/devices',
  product_source: 'commerce/stores', history_sync: 'data/sources', test_draft: 'content', invite_team: 'access',
};
export const setupStepNames = Object.fromEntries(Object.entries(steps).map(([key, step]) => [key, step.name]));
const statuses: Record<string, readonly [string, string, string?]> = {
  // A failed check only means the prerequisite is missing, so it reads as unfinished rather than blocked.
  not_started: ['尚未開始', 'Not started', '尚未开始'], blocked: ['未完成', 'Not done yet'],
  done: ['已完成', 'Done'], skipped: ['已略過', 'Skipped', '已略过'],
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
  const impact = result.impact && status !== 'done' ? locale !== 'en' && step ? label(step.impact) : stringValue(result.impact) : '';
  function submitSkip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    if (reason) mutation.mutate({ reason });
  }
  return <section className="detail-block" aria-labelledby={`setup-${key}`}>
    <div className="panel-head"><h2 id={`setup-${key}`}>{step ? label(step.name) : key}</h2>
      <Pill tone={status === 'blocked' ? 'warning' : status === 'done' ? 'good' : 'neutral'}>{statuses[status] ? label(statuses[status]) : status}</Pill></div>
    {impact && <p>{impact}</p>}
    {result.reason === 'app_identity_mismatch' && <p>{label(['手機 App 的登入身分與綁定帳號不符', 'The phone App is signed in to a different account', '手机 App 的登录身分与绑定账号不符'])}</p>}
    {typeof row.skip_reason === 'string' && <p>{row.skip_reason}</p>}
    {mutation.isError && <ProblemNotice error={mutation.error} />}
    <div className="action-row">
      {setupStepRoutes[key] && status !== 'done' && <Link className="button primary" to={`/w/${encodeURIComponent(api.ws)}/${setupStepRoutes[key]}`}>{label(['前往處理', 'Go to step', '前往处理'])}</Link>}
      {check && <button disabled={mutation.isPending} onClick={() => mutation.mutate({})}>{label(['檢查步驟', 'Check step', '检查步骤'])}</button>}
      {skip && status !== 'done' && status !== 'skipped' && !skipping && <button disabled={mutation.isPending} onClick={() => setSkipping(true)}>{label(['略過步驟', 'Skip step', '略过步骤'])}</button>}
    </div>
    {skipping && <form className="action-row" onSubmit={submitSkip}>
      <label>{label(['略過原因', 'Reason for skipping', '略过原因'])} <input name="reason" required maxLength={1000} pattern=".*\S.*" /></label>
      <button type="submit" disabled={mutation.isPending}>{label(['確認略過', 'Confirm skip', '确认略过'])}</button>
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
      {resume && <p><a href={`#setup-${stringValue(resume.step_key)}`}>{label(['繼續設定', 'Resume setup', '继续设置'])}</a></p>}
      {rows.map(row => <SetupStep key={stringValue(row.step_key)} row={row} />)}
    </Panel>
  </>;
}
