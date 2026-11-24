import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, asRecord, request } from '@smartsell/sdk';
import { CopyButton } from '@smartsell/ui';
import { ProblemNotice } from '../../api';
import { fill } from '../copy';
import type { HubInfo } from '../data/hub-types';
import type { CreatedConnection } from '../data/types';
import { useViewContext } from '../data/use-view';
import { useText } from '../parts';
import { Badge, useHubWrite } from '../hub-parts';

/** Hub facts for the setup wizard and the Agent page (§2.9, §2.12, §6.2). */

type Label = readonly [string, string];
export const setupHubText = {
  hubAddress: ['中樞位址', 'Hub address'], copyAddress: ['複製中樞位址', 'Copy the hub address'],
  wrongOrigin: ['你目前不是從 Tailscale 網址開啟，別台機器會連不到。請改用上面的網址開啟這一頁。', 'You did not open this page from the Tailscale address, so other machines cannot reach it. Open it from the address above.'],
  devHub: ['開發模式：沒有中樞資訊，以目前的網址為準。正式使用請在中樞執行 pnpm hub:init。', 'Development mode: no hub information, so this page\'s address is used. For real use run pnpm hub:init on the hub.'],
  serveDown: ['Tailscale serve 沒有在提供這個網址，請在中樞執行 pnpm hub:doctor。', 'Tailscale serve is not serving this address; run pnpm hub:doctor on the hub.'],
  // E46 (SEC-3): Tailscale Funnel puts the hub on the public internet; the hub's own sentence (funnel_warning) carries the fix.
  funnelTitle: ['中樞被公開到網際網路', 'The hub is exposed to the internet'],
  funnelFallback: ['Tailscale Funnel 把中樞公開到網際網路，任何人都能連到登入頁與配對端點。請在中樞執行 pnpm hub:doctor 看關閉的指令。',
    'Tailscale Funnel exposes the hub to the internet, so anyone can reach its sign-in and pairing endpoints. Run pnpm hub:doctor on the hub for the command that turns it off.'],
  downloads: ['下載 SmartSell Worker', 'Download SmartSell Worker'],
  noPackage: ['尚未建置的安裝包：請在中樞執行 pnpm worker:release（Windows 安裝包要在 Windows 機器上建置，見 docs/hub-setup.md）。', 'For a package not built yet, run pnpm worker:release on the hub (the Windows package is built on a Windows machine, see docs/hub-setup.md).'],
  notBuilt: ['尚未建置', 'Not built yet'], download: ['下載', 'Download'],
  macArm: ['macOS（Apple 晶片）', 'macOS (Apple silicon)'], macX64: ['macOS（Intel）', 'macOS (Intel)'], win: ['Windows', 'Windows'],
  agentWays: ['連接 Codex 或 Claude Code 的兩種方式', 'Two ways to connect Codex or Claude Code'],
  wayApp: ['方式一（建議）：筆電上的 SmartSell App', 'Way 1 (recommended): the SmartSell App on your laptop'],
  wayAppSteps: ['在筆電安裝 SmartSell App，選「這台是我的筆電（只連 Codex，不發文）」，再按「連接 Codex」或「連接 Claude Code」。瀏覽器會開啟這個中樞的連線頁，登入後按「授權」，App 會自己寫好 Codex／Claude Code 的設定，不用複製任何東西。',
    'Install the SmartSell App on the laptop, choose "This is my laptop (Codex only, no posting)", then click "Connect Codex" or "Connect Claude Code". The browser opens this hub\'s connect page; sign in, click Authorize, and the App writes the Codex / Claude Code settings itself. Nothing to copy.'],
  wayRelay: ['方式二：Node relay（Windows 筆電或沒有 App 時）', 'Way 2: the Node relay (Windows laptop, or without the App)'],
  wayRelayHint: ['先建立一個連線，把權杖存成檔案，再在筆電的終端機執行下面兩行。權杖只顯示這一次。', 'Create a connection, save its token as a file, then run the two lines below in a terminal on the laptop. The token is shown only once.'],
  relayLabel: ['連線名稱', 'Connection name'], relayCreate: ['建立連線並下載權杖檔', 'Create a connection and download the token file'],
  relayCreated: ['已建立「{label}」。權杖檔已下載為 token；把它移到 ~/.smartsell/token 並設成只有你能讀（chmod 600）。', 'Created "{label}". The token file was downloaded as token; move it to ~/.smartsell/token and make it private (chmod 600).'],
  relayCommands: ['在筆電執行', 'Run on the laptop'], relayToken: ['權杖（只顯示這一次）', 'Token (shown once)'],
} as const satisfies Record<string, Label>;

/** GET /api/v1/hub/info; in development (pnpm dev) the route does not exist and answers 404. */
export function useHubInfo() {
  return useQuery({ queryKey: ['hub-info'], retry: false, staleTime: 60_000, queryFn: async ({ signal }) => {
    try {
      const { data } = await request<HubInfo>('/api/v1/hub/info', { signal });
      return { info: asRecord(data) as HubInfo, development: false };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { info: { public_origin: window.location.origin } as HubInfo, development: true };
      throw error;
    }
  } });
}

export function HubAddress() {
  const { l, lang } = useText();
  const read = useHubInfo();
  if (read.isPending) return null;
  if (read.isError) return <ProblemNotice error={read.error} retry={() => void read.refetch()} />;
  const { info, development } = read.data;
  const origin = info.public_origin ?? window.location.origin;
  return <div className="hub-address">
    <span className="muted">{l(setupHubText.hubAddress)}</span>
    <strong className="hub-address-value">{origin}</strong>
    <CopyButton text={origin} label={setupHubText.copyAddress} />
    {development && <p className="muted hub-small">{l(setupHubText.devHub)}</p>}
    {!development && info.request_origin_ok === false && <p className="hub-callout warn">{l(setupHubText.wrongOrigin)}</p>}
    {!development && info.tailscale?.serve_ok === false && <p className="hub-callout warn">{l(setupHubText.serveDown)}</p>}
    {!development && info.tailscale?.funnel_on === true && <div className="hub-callout critical" role="alert"><strong>{l(setupHubText.funnelTitle)}</strong>
      <p>{lang === 'zh' && info.tailscale.funnel_warning ? info.tailscale.funnel_warning : l(setupHubText.funnelFallback)}</p></div>}
  </div>;
}

const PLATFORMS: [string, Label][] = [['mac-arm64', setupHubText.macArm], ['mac-x64', setupHubText.macX64], ['win-x64', setupHubText.win]];
export function WorkerDownloads() {
  const { l } = useText();
  const read = useHubInfo();
  const fallback = useQuery({ queryKey: ['worker-downloads'], enabled: read.data?.development === true, retry: false, queryFn: async ({ signal }) => {
    try { const { data } = await request<HubInfo['worker_downloads']>('/api/v1/worker-downloads', { signal }); return Array.isArray(data) ? data : []; }
    catch { return []; }
  } });
  const items = (read.data?.development ? fallback.data : read.data?.info.worker_downloads) ?? [];
  return <div className="hub-downloads"><h3 className="vs-subhead">{l(setupHubText.downloads)}</h3>
    <ul className="hub-rows">{PLATFORMS.map(([platform, label]) => {
      const item = items.find(entry => entry.platform === platform);
      return <li key={platform} className="hub-row static two">
        <span className="hub-row-main"><strong>{l(label)}</strong></span>
        <span className="hub-row-tags">{item ? <><a className="vs-btn primary-soft" href={item.url} download>{l(setupHubText.download)}</a>{item.version && <Badge tone="neutral">{item.version}</Badge>}</> : <Badge tone="warning">{l(setupHubText.notBuilt)}</Badge>}</span>
      </li>;
    })}</ul>
    {PLATFORMS.some(([platform]) => !items.some(entry => entry.platform === platform)) && <p className="muted hub-small">{l(setupHubText.noPackage)}</p>}
  </div>;
}

/** §6.2: the App button (no copying) or the Node relay one-liner with a token file. */
export function AgentConnectWays() {
  const { l } = useText();
  const { workspace } = useViewContext();
  const info = useHubInfo();
  const write = useHubWrite();
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<CreatedConnection>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const origin = info.data?.info.public_origin ?? window.location.origin;
  const commands = [
    `mkdir -p ~/.smartsell && curl -fsSL ${origin}/agent/relay.mjs -o ~/.smartsell/relay.mjs`,
    `codex mcp add smartsell -- node ~/.smartsell/relay.mjs --hub ${origin} --token-file ~/.smartsell/token`,
  ].join('\n');
  async function create() {
    setPending(true); setError(undefined);
    try {
      const name = label.trim() || `${workspace.name} · Codex`;
      const { data } = await write<CreatedConnection>('POST', '/agent-connections', { label: name.slice(0, 80), client: 'codex', expires_days: 365 });
      setCreated(data);
      // octet-stream, not text/plain: Chrome appends ".txt" to a text/plain download, and the text and the relay command name ~/.smartsell/token.
      const blob = new Blob([`${data.token}\n`], { type: 'application/octet-stream' });
      const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'token' });
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (failure) { setError(failure); }
    finally { setPending(false); }
  }
  return <div className="hub-agent-ways">
    <section className="hub-way"><h3>{l(setupHubText.wayApp)}</h3><p>{l(setupHubText.wayAppSteps)}</p></section>
    <section className="hub-way"><h3>{l(setupHubText.wayRelay)}</h3><p>{l(setupHubText.wayRelayHint)}</p>
      {!created ? <div className="hub-form-grid">
        <label className="hub-field">{l(setupHubText.relayLabel)}<input value={label} maxLength={80} placeholder={`${workspace.name} · Codex`} onChange={event => setLabel(event.target.value)} /></label>
        <div><button type="button" className="vs-btn primary-soft" disabled={pending} onClick={() => void create()}>{l(setupHubText.relayCreate)}</button></div>
      </div> : <>
        <p className="vs-notice good" role="status">{fill(l(setupHubText.relayCreated), { label: created.label })}</p>
        <details><summary>{l(setupHubText.relayToken)}</summary><code className="hub-code">{created.token}</code></details>
      </>}
      <p className="muted hub-small">{l(setupHubText.relayCommands)}</p>
      <pre className="hub-code">{commands}</pre>
      <CopyButton text={commands} />
      {error !== undefined && <ProblemNotice error={error} />}
    </section>
  </div>;
}
