import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { ApiError, readSetupStatus, setupWorkspace, signIn } from '@smartsell/sdk';
import { FactorFields, finishLogin, readLoginChallenge } from './account-security';
import { ProblemNotice } from './api';
import { useCopy } from './i18n';

const setupStatusKey = ['setup-status'];

/** `#setup-token=<token>` (the only fragment key the setup link carries). */
export function readSetupToken(hash: string): string | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('setup-token')?.trim();
  return token && token.length <= 512 && /^[\x21-\x7e]+$/.test(token) ? token : undefined;
}
type AuthMode = 'login' | 'register' | 'setup';

export function AuthenticationForm<T>({ setupPath, compatibility = false, showCompatibility = false, locale, readSession, onSession }: {
  setupPath: boolean;
  compatibility?: boolean;
  showCompatibility?: boolean;
  locale?: string;
  readSession: () => Promise<T | null>;
  onSession: (session: T, mode: AuthMode) => Promise<void>;
}) {
  const { t: translate } = useCopy();
  const t = (key: string) => translate(key, { lng: locale });
  const { search, hash } = useLocation();
  // §2.9 step 1: hub:init prints https://<hub>/setup#setup-token=…; the token is read from the fragment (never sent in a URL to the
  // server), kept in memory, removed from the address bar and its field is hidden.
  const [fragmentToken] = useState(() => readSetupToken(hash));
  useEffect(() => {
    if (fragmentToken && typeof window !== 'undefined' && window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, [fragmentToken]);
  const status = useQuery({ queryKey: setupStatusKey, queryFn: ({ signal }) => readSetupStatus(signal), staleTime: 0, retry: false });
  const form = useRef<HTMLFormElement>(null);
  const previousStep = useRef<AuthMode | 'challenge'>(undefined);
  const flight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [challenge, setChallenge] = useState<string>();
  const [setupClosed, setSetupClosed] = useState(false);
  const [identifier, setIdentifier] = useState('');
  const registrationOpen = !status.isError && !setupClosed && status.data?.initialized === false && status.data.registration_enabled;
  const needsToken = registrationOpen && status.data?.token_required;
  const passwordMinimum = status.data?.password_min_length ?? 12;
  const mode: AuthMode = challenge || !registrationOpen ? 'login' : setupPath ? 'setup' : 'register';
  const title = t(mode === 'setup' && compatibility ? 'auth.compatSetup' : mode);
  const Heading = compatibility ? 'h1' : 'h2';
  const step = challenge ? 'challenge' : mode;
  const credentialsInvalid = error instanceof ApiError && String(error.problem.code).toLowerCase() === 'invalid_credentials';
  const authorizationFailed = needsToken && mode !== 'login' && error instanceof ApiError && error.status === 403;

  useEffect(() => {
    if (pending || !form.current) return;
    if (authorizationFailed) form.current.querySelector<HTMLInputElement>('input[name=setupToken]')?.focus();
    else if (credentialsInvalid) form.current.querySelector<HTMLInputElement>('input[name=password]')?.focus();
    else if (previousStep.current && previousStep.current !== step) form.current.querySelector('input')?.focus();
    previousStep.current = step;
  }, [step, pending, credentialsInvalid, authorizationFailed, status.isPending]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (flight.current) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const login = identifier.trim();
    const password = String(fields.password ?? '');
    const credentials = mode === 'setup' ? { email: String(fields.email).trim(), password } :
      mode === 'login' && login.includes('@') ? { email: login, password } : { username: login, password };
    flight.current = true;
    setPending(true);
    setError(undefined);
    try {
      if (challenge) await finishLogin(challenge, fields);
      else if (mode !== 'login') {
        const body = mode === 'setup' ? { ...credentials, name: fields.name, workspaceName: fields.workspaceName } : credentials;
        await setupWorkspace(body, needsToken ? fragmentToken ?? String(fields.setupToken ?? '') : undefined);
      }

      // Some setup clients create the account without establishing a browser session.
      let session = challenge || mode !== 'login' ? await readSession() : null;
      if (!session && !challenge) {
        const gate = readLoginChallenge(await signIn(credentials));
        if (gate) { setChallenge(gate); return; }
        session = await readSession();
      }
      if (!session) throw new ApiError(401, { code: 'SESSION_NOT_ESTABLISHED' });
      await onSession(session, mode);
    } catch (failure) {
      if (mode !== 'login' && failure instanceof ApiError && failure.status === 409 &&
          String(failure.problem.code).toLowerCase() === 'already_configured') {
        const session = await readSession().catch(() => null);
        if (session) {
          await onSession(session, mode);
        } else {
          if (mode === 'setup') setIdentifier(String(fields.email).trim());
          setSetupClosed(true);
          void status.refetch();
        }
      } else {
        setChallenge(undefined);
        setError(failure);
      }
    } finally {
      flight.current = false;
      setPending(false);
    }
  }

  if (status.isPending) return <p role="status">{t('auth.checkingSetup')}</p>;
  return <><Heading>{title}</Heading>
    <p>{t(mode === 'register' ? 'auth.registerHelp' : mode === 'setup' ? 'authSetup' : 'authLogin')}</p>
    {needsToken && mode !== 'login' && !fragmentToken && <p className="notice" role="note">{t('auth.firstRunHint')}</p>}
    {status.isError && <div className="problem auth-notice" role="alert"><p>{t('auth.setupStatusError')}</p>
      <button type="button" disabled={status.isFetching} onClick={() => void status.refetch()}>{t('retry')}</button></div>}
    {setupClosed && <p className="notice" role="status">{t('auth.setupCompleted')}</p>}
    {!status.isError && !setupClosed && status.data?.initialized === false && !status.data.registration_enabled &&
      <p className="notice" role="status">{t('auth.setupUnavailable')}</p>}
    {error !== undefined && (credentialsInvalid || authorizationFailed ?
      <div className="problem auth-notice" role="alert">{t(authorizationFailed ? 'auth.authorizationFailed' : 'auth.invalidCredentials')}</div> :
      <ProblemNotice error={error} />)}
    <form ref={form} className={compatibility ? 'wb-form' : 'fields'} onSubmit={submit}>
      <fieldset key={challenge ? 'challenge' : mode} disabled={pending}>
        {challenge ? <FactorFields locale={locale} /> : <>
          {mode === 'setup' ? <label className="field">{t('email')}<input name="email" type="email" required autoComplete="email" /></label> :
            <label className="field">{t(mode === 'register' ? 'auth.username' : 'auth.identifier')}
              <input name={mode === 'register' ? 'username' : 'identifier'} value={identifier} onChange={event => setIdentifier(event.target.value)}
                required pattern=".*\S.*" autoComplete="username" autoCapitalize="none" spellCheck={false} />
            </label>}
          <div className="auth-password">
            <label className="field">{t('password')}
              <input name="password" type="password" required minLength={mode === 'login' ? undefined : passwordMinimum}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} aria-describedby={mode === 'login' ? undefined : 'auth-password-hint'} />
            </label>
            {mode !== 'login' && <small id="auth-password-hint">{translate('auth.passwordHint', { lng: locale, minimum: passwordMinimum })}</small>}
          </div>
          {mode === 'setup' && <>
            <label className="field">{t('workspace_name')}<input name="workspaceName" required maxLength={120} pattern=".*\S.*" autoComplete="organization" /></label>
            <label className="field">{t(compatibility ? 'auth.compatName' : 'displayName')}<input name="name" maxLength={120} autoComplete="name" /></label>
          </>}
          {needsToken && mode !== 'login' && !fragmentToken && <div className="auth-password"><label className="field">{t('auth.deploymentToken')}
            <input name="setupToken" type="password" required autoComplete="off" aria-invalid={authorizationFailed || undefined} aria-describedby="auth-token-hint" />
          </label><small id="auth-token-hint">{t('auth.tokenHint')}</small></div>}
        </>}
        <button className={compatibility ? 'wb-primary' : 'primary'} type="submit">{pending ? t('saving') : challenge ? t('security.verify') : title}</button>
        {challenge && <button type="button" onClick={() => { setChallenge(undefined); setError(undefined); }}>{t('security.restart')}</button>}
      </fieldset>
    </form>
    {((mode !== 'login' && !fragmentToken) || showCompatibility || compatibility) && <div className="auth-links">
      {/* Opened from the hub:init link (token in the fragment): that is the first-run path; no second form to switch to (O7). */}
      {mode !== 'login' && !fragmentToken && <Link to={{ pathname: mode === 'setup' ? '/login' : '/setup', search }}>
        {t(mode === 'setup' ? 'auth.backToRegistration' : 'auth.advancedSetup')}
      </Link>}
      {showCompatibility && <a href={`/compat/workbench/${mode === 'setup' ? 'setup' : 'login'}`}>{t('compatibilityWorkbench')}</a>}
      {compatibility && <a href={mode === 'setup' ? '/setup' : '/login'}>{t('auth.mainWorkspace')}</a>}
    </div>}
  </>;
}
