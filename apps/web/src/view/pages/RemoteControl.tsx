import { useState, type FormEvent } from 'react';
import { WriteError, useHubWrite } from '../hub-parts';
import { useText } from '../parts';

/** E50: what the owner allowed on one machine (packages/contracts RemoteControlSettings). */
export interface RemoteControlView {
  browser: { enabled: boolean; sites: string[] };
  phone: { enabled: boolean; apps: string[] };
  updated_at: string | null;
}

const copy = {
  title: ['遙控（Agent 一步一步操作）', 'Remote control (the Agent works step by step)'],
  intro: ['開啟後，你的 Agent 可以在這台機器上你自己的 Chrome，或插在這台機器的 Android 手機上看畫面、一步一步操作，做沒有專用工具的事（例如電商後台改庫存）。改東西之前它會先問你；遇到登入、驗證碼或付款畫面會停下來請你處理。',
    'When on, your Agent can look at and operate your own Chrome on this machine, or an Android phone plugged into it, one step at a time — for work no other tool covers (a store backend, say). It asks you before changing anything and stops for sign-in, captcha or payment screens.'],
  browser: ['允許操作這台機器的 Chrome', 'Allow this machine\'s Chrome'],
  browserNeeds: ['需要在這台機器的 SmartSell Worker 選「用我自己的 Chrome」。', 'Needs “use my own Chrome” in the SmartSell Worker on this machine.'],
  sites: ['允許的網站（每行一個網域，例如 seller.shopee.tw；也包含它的子網域）', 'Allowed sites (one domain per line, e.g. seller.shopee.tw; subdomains included)'],
  phone: ['允許操作插在這台機器的 Android 手機', 'Allow the Android phone plugged into this machine'],
  phoneNeeds: ['手機要用 USB 連到這台機器並允許 USB 偵錯；這台機器要裝 Android 的 adb。', 'Connect the phone by USB and allow USB debugging; this machine needs Android\'s adb.'],
  apps: ['允許的 App（每行一個套件名稱，例如 com.xingin.xhs）', 'Allowed apps (one package name per line, e.g. com.xingin.xhs)'],
  save: ['儲存', 'Save'],
  saved: ['已儲存。這台機器的 Worker 會在半分鐘內套用。', 'Saved. This machine\'s Worker applies it within half a minute.'],
  off: ['目前關閉。', 'Off.'],
} as const;

const lines = (value: string) => value.split(/[\n,，、\s]+/).map(item => item.trim()).filter(Boolean);

export function RemoteControlSection({ machineId, value }: { machineId: string; value: RemoteControlView | null | undefined }) {
  const { l } = useText();
  const write = useHubWrite();
  const current = value ?? { browser: { enabled: false, sites: [] }, phone: { enabled: false, apps: [] }, updated_at: null };
  const [browser, setBrowser] = useState(current.browser.enabled);
  const [sites, setSites] = useState(current.browser.sites.join('\n'));
  const [phone, setPhone] = useState(current.phone.enabled);
  const [apps, setApps] = useState(current.phone.apps.join('\n'));
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>();
  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true); setError(undefined); setSaved(false);
    try {
      await write('PUT', `/hub/machines/${encodeURIComponent(machineId)}/remote-control`,
        { browser: { enabled: browser, sites: lines(sites) }, phone: { enabled: phone, apps: lines(apps) } });
      setSaved(true);
    } catch (failure) { setError(failure); } finally { setPending(false); }
  }
  return <form className="hub-panel" onSubmit={event => void save(event)} aria-label={l(copy.title)}>
    <p className="muted">{l(copy.intro)}</p>
    <label className="hub-check"><input type="checkbox" checked={browser} onChange={event => setBrowser(event.target.checked)} /> {l(copy.browser)}</label>
    {browser && <>
      <small className="muted">{l(copy.browserNeeds)}</small>
      <label className="hub-field">{l(copy.sites)}<textarea rows={3} value={sites} onChange={event => setSites(event.target.value)} spellCheck={false} /></label>
    </>}
    <label className="hub-check"><input type="checkbox" checked={phone} onChange={event => setPhone(event.target.checked)} /> {l(copy.phone)}</label>
    {phone && <>
      <small className="muted">{l(copy.phoneNeeds)}</small>
      <label className="hub-field">{l(copy.apps)}<textarea rows={3} value={apps} onChange={event => setApps(event.target.value)} spellCheck={false} /></label>
    </>}
    <div className="vs-actions"><button className="vs-btn primary" type="submit" disabled={pending}>{l(copy.save)}</button></div>
    {saved && <p className="vs-notice good" role="status">{l(copy.saved)}</p>}
    {!browser && !phone && !saved && <p className="muted">{l(copy.off)}</p>}
    <WriteError error={error} />
  </form>;
}

export const remoteControlTitle = copy.title;
