import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { callOperation, findOperation, ProblemNotice, ReadState, stringValue, useApi, useRead, wsKey } from './api';
import { useCopy } from './i18n';

const policy = '/connector-auto-policy';
const enable = '/social-accounts/:id/execution-binding/auto-mode';

export function TermsRenewal({ renewal, title }: { renewal: RecordData; title: string }) {
  const { label, t } = useCopy();
  const api = useApi();
  const [open, show] = useState(false);
  const operation = findOperation(api, 'POST', enable, 'account');
  const account = stringValue(renewal.social_account_id);
  return <div>{title}{operation && account && <>
    <button type="button" aria-expanded={open} onClick={() => show(!open)}>{open ? t('cancel') : label(['檢視新條款', 'Review updated terms'])}</button>
    {open && <RenewalForm account={account} limits={asRecord(renewal.limits)} />}
  </>}</div>;
}

function RenewalForm({ account, limits }: { account: string; limits: RecordData }) {
  const { label } = useCopy();
  const api = useApi();
  const client = useQueryClient();
  const read = useRead(policy, [], {}, 'account');
  const terms = asRecord(asRecord(read.data?.data).terms);
  const version = stringValue(terms.version);
  const text = stringValue(terms.text);
  const operation = findOperation(api, 'POST', enable, 'account');
  const mutation = useMutation({ mutationFn: () => callOperation(api, operation!, [account], {
    body: { ...limits, terms_version: version, risk_acknowledged: true },
  }), onSuccess: () => client.invalidateQueries({ queryKey: wsKey(api.ws) }) });
  if (!version || !text || !operation) return <><ReadState read={read} />{read.data && <p>{label(['目前無法取得可確認的條款', 'There are no terms available to confirm'])}</p>}</>;
  const configured = [limits.max_per_hour, limits.min_interval_seconds, limits.daily_cap].every(Number.isInteger) && Array.isArray(limits.allowed_windows) && limits.allowed_windows.length > 0;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (configured && new FormData(event.currentTarget).has('acknowledge')) mutation.mutate();
  }
  return <form key={version} className="fields" onSubmit={submit}>
    <p>{version} · {text}</p>
    {configured ? <><label><input name="acknowledge" type="checkbox" required /> {label(['我已閱讀條款並確認自動模式風險', 'I have read the terms and acknowledge the risks of automatic mode'])}</label>
      <button type="submit" disabled={mutation.isPending}>{label(['確認條款並重新開啟', 'Confirm terms and re-enable'])}</button></> :
      <p>{label(['重新開啟前須先設定自動模式的時段與限額', 'Configure automatic mode limits and time windows before re-enabling'])}</p>}
    {mutation.isError && <ProblemNotice error={mutation.error} />}
  </form>;
}
