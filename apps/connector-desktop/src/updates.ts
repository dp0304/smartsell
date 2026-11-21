import { defaultLanguage, translate, type DesktopLanguage } from '../ui/i18n.mjs';
import { autoUpdater } from 'electron';
import { NsisUpdater } from 'electron-updater';

export type UpdateConfig = { feed: string; publisher?: string };

export function desktopUpdates(platform: string, config: UpdateConfig | undefined) {
  let status = '签名更新未配置';
  let busy = false;
  let ready = false;
  let check = async () => {};
  let install = () => {};
  if (config && platform === 'darwin') {
    status = '可手动检查签名更新';
    // Squirrel.Mac enforces the running application's designated code-signing requirement.
    autoUpdater.setFeedURL({ url: config.feed, serverType: 'json' });
    autoUpdater.on('update-available', () => { status = '正在下载并验证签名'; });
    autoUpdater.on('update-not-available', () => { busy = false; status = '当前是最新版本'; });
    autoUpdater.on('error', () => { busy = false; ready = false; status = '下载或签名校验失败'; });
    autoUpdater.on('update-downloaded', () => { busy = false; ready = true; status = '签名已验证，可安装'; });
    check = async () => { autoUpdater.checkForUpdates(); };
    install = () => autoUpdater.quitAndInstall();
  } else if (config?.publisher && platform === 'win32') {
    const publisher = config.publisher;
    const updater = new NsisUpdater({ provider: 'generic', url: config.feed });
    const verify = updater.verifyUpdateCodeSignature;
    updater.verifyUpdateCodeSignature = (names, file) => names.length === 1 && names[0] === publisher
      ? verify([publisher], file) : Promise.resolve('Unexpected signer configuration');
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.logger = null;
    updater.on('error', () => {}); // check/download promise provides the user-facing outcome.
    status = '可手动检查签名更新';
    check = async () => {
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) { status = '当前是最新版本'; busy = false; return; }
      status = '正在下载并验证签名';
      const files = await updater.downloadUpdate();
      // Validate again even if the updater reused a cached installer.
      if (files.length !== 1 || !files[0].toLowerCase().endsWith('.exe') || await verify([publisher], files[0]) !== null) {
        throw new Error('Update signature invalid');
      }
      ready = true;
      busy = false;
      status = '签名已验证，可安装';
    };
    install = () => updater.quitAndInstall();
  }
  const enabled = status !== '签名更新未配置';
  return {
    snapshot: (language: DesktopLanguage = defaultLanguage) => ({ enabled, status: translate(language, status), busy, ready }),
    async check() {
      if (!enabled || busy || ready) return;
      busy = true;
      status = '正在检查更新';
      try { await check(); }
      catch { busy = false; ready = false; status = '下载或签名校验失败'; }
    },
    install() {
      if (ready) install();
    },
  };
}
