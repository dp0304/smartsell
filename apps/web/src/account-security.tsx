import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, asRecord, request } from '@smartsell/sdk';
import { ProblemNotice } from './api';
import { useCopy } from './i18n';

const path = '/api/v1/auth/totp';
type Enrollment = { enrollmentId: string; uri: string };
type Status = { enabled: boolean; canManage: boolean; passwordRecheck?: boolean };
export function readLoginChallenge(response: unknown) {
  const envelope = asRecord(response);
  const data = asRecord(envelope.data ?? response);
  if (data.required !== true) return undefined;
  if (typeof data.challenge !== 'string' || !data.challenge) throw new ApiError(502, { code: 'INVALID_RESPONSE' });
  return data.challenge;
}

export async function readTotpStatus(signal?: AbortSignal) {
  return (await request<Status>(path, { signal })).data;
}

export function FactorFields({ totpOnly = false, locale }: { totpOnly?: boolean; locale?: string }) {
  const { t: translate } = useCopy();
  const t = (key: string) => translate(key, { lng: locale });
  const [recovery, setRecovery] = useState(false);
  return <>
    {recovery ? <label className="field">{t('security.recoveryCode')}<input key="recovery" name="recoveryCode" type="password" autoComplete="off" required pattern="[0-9a-fA-F]{32}" maxLength={32} /></label> :
      <label className="field">{t('security.totp')}<input key="totp" name="totp" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} /></label>}
    {!totpOnly && <button type="button" onClick={() => setRecovery(!recovery)}>{t(recovery ? 'security.useTotp' : 'security.useRecovery')}</button>}
  </>;
}

export function finishLogin(challenge: string, fields: Record<string, FormDataEntryValue>) {
  const answer = typeof fields.recoveryCode === 'string' ? { recoveryCode: fields.recoveryCode.toLowerCase() } : { totp: fields.totp };
  return request(`${path}/challenge`, { method: 'POST', body: { challenge, ...answer } });
}

export function AccountSecurity({ csrf, userId }: { csrf: string; userId: string }) {
  const { t, label } = useCopy();
  const status = useQuery({ queryKey: ['account-security', userId], queryFn: ({ signal }) => readTotpStatus(signal) });
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [codes, setCodes] = useState<string[]>();
  const [recoveryRevoked, setRecoveryRevoked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const flight = useRef(false);
  const enabled = status.data?.enabled;
  const step = enabled ? 'revoke' : enrollment ? 'confirm' : 'enroll';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (flight.current) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const revokeRecovery = step === 'revoke' && status.data?.passwordRecheck === true &&
      submitter instanceof HTMLButtonElement && submitter.value === 'revoke-recovery';
    const body = Object.fromEntries(new FormData(form));
    if (typeof body.recoveryCode === 'string') body.recoveryCode = body.recoveryCode.toLowerCase();
    if (enrollment && step === 'confirm') body.enrollmentId = enrollment.enrollmentId;
    form.reset();
    flight.current = true;
    setPending(true);
    setError(undefined);
    try {
      if (step === 'enroll') {
        setEnrollment((await request<Enrollment>(`${path}/enroll`, { method: 'POST', csrf, body })).data);
      } else if (step === 'confirm') {
        const { data } = await request<{ recoveryCodes: string[] }>(`${path}/confirm`, { method: 'POST', csrf, body });
        setEnrollment(undefined);
        setCodes(data.recoveryCodes);
        await status.refetch();
      } else {
        await request(`${path}/${revokeRecovery ? 'recovery/revoke' : 'revoke'}`, { method: 'POST', csrf, body });
        setRecoveryRevoked(revokeRecovery);
        setCodes(undefined);
        await status.refetch();
      }
    } catch (failure) { setError(failure); }
    finally { flight.current = false; setPending(false); }
  }

  return <section className="auth-card" aria-labelledby="account-security-title">
    <h2 id="account-security-title">{t('security.title')}</h2>
    {status.isPending && <p role="status">{t('loading')}</p>}
    {status.isError && <ProblemNotice error={status.error} retry={() => void status.refetch()} />}
    {status.data && <p role="status">{t(enabled ? 'security.enabled' : 'security.disabled')}</p>}
    {status.data && !status.data.canManage && <p>{t('security.federated')}</p>}
    {recoveryRevoked && enabled && <p role="status">{label(['復原碼已撤銷。', 'Recovery codes revoked.', '复原码已撤销。'])}</p>}
    {codes && <div><p>{t('security.saveCodes')}</p><ul aria-label={t('security.recoveryCodes')}>{codes.map(code => <li key={code}><code>{code}</code></li>)}</ul><button type="button" onClick={() => setCodes(undefined)}>{t('close')}</button></div>}
    {status.data?.canManage && !codes && <>
      {enrollment && <label className="field">{t('security.setupKey')}<input readOnly value={new URL(enrollment.uri).searchParams.get('secret') ?? ''} onFocus={event => event.currentTarget.select()} /></label>}
      <form className="fields" onSubmit={submit}><fieldset key={step} disabled={pending}>
        <label className="field">{t('password')}<input name="password" type="password" required autoComplete="current-password" /></label>
        {step !== 'enroll' && <FactorFields totpOnly={step === 'confirm'} />}
        <button type="submit" className="primary">{t(pending ? 'saving' : `security.${step}`)}</button>
        {step === 'revoke' && status.data.passwordRecheck === true && <button type="submit" value="revoke-recovery">{label(['撤銷復原碼', 'Revoke recovery codes', '撤销复原码'])}</button>}
        {enrollment && <button type="button" onClick={() => { setEnrollment(undefined); setError(undefined); }}>{t('cancel')}</button>}
      </fieldset></form>
    </>}
    {error !== undefined && <ProblemNotice error={error} />}
  </section>;
}
