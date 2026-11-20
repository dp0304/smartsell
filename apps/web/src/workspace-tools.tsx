import { useEffect, useState, type ReactNode } from 'react';
import { Bell, Search, Shield, Wrench } from 'lucide-react';
import { I18nextProvider } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CommandPanel, useCommands } from './command-panel';
import { SearchPanel } from './search-panel';
import { has } from './workbench-data';
import i18n from './workbench-i18n';
import { Dialog, Failure, useFormat } from './workbench-ui';
import { useCopy } from './i18n';
import './workbench.css';

export function CommandLanguage({ children }: { children: ReactNode }) {
  const { locale } = useCopy();
  useEffect(() => {
    if (i18n.resolvedLanguage !== locale) void i18n.changeLanguage(locale);
  }, [locale]);
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

export function WorkspaceTools({ ws }: { ws: string }) {
  const { t } = useFormat();
  const commands = useCommands(ws);
  const items = commands.data?.items ?? [];
  const [drawer, setDrawer] = useState<'commands' | 'search'>();
  const close = () => setDrawer(undefined);
  return <>
    {has(items, 'workspace', 'search') && <button type="button" onClick={() => setDrawer('search')}><Search size={16} />{t('ui.globalSearch')}</button>}
    {has(items, 'workspace', 'list_notifications') && <Link className="button icon-button" aria-label={t('ui.notifications')} title={t('ui.notifications')} to={`/w/${encodeURIComponent(ws)}/settings/brands?tab=notifications`}><Bell size={16} /></Link>}
    <Link className="button icon-button" aria-label={t('nav.access')} title={t('nav.access')} to={`/w/${encodeURIComponent(ws)}/access`}><Shield size={16} /></Link>
    <button type="button" onClick={() => setDrawer('commands')}><Wrench size={16} />{t('ui.tools')}</button>
    {drawer === 'search' && <SearchPanel wid={ws} commands={items} close={close} primary />}
    {drawer === 'commands' && (commands.isPending || commands.isError
      ? <Dialog title={t('ui.tools')} close={close}>{commands.isError ? <Failure error={commands.error} retry={() => void commands.refetch()} /> : <p role="status">{t('ui.loading')}</p>}</Dialog>
      : <CommandPanel wid={ws} commands={items} close={close} />)}
  </>;
}

export { Failure as CommandFailure };
