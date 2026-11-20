import { useState } from 'react';
import { Link } from 'react-router-dom';
import { sections } from './catalog';
import { useCommandRead } from './workbench-data';
import { Dialog, Empty, Failure, Status, useFormat } from './workbench-ui';
import type { Command } from './workbench-api';

interface Hit { module: string; kind: string; id: string; title: string; status: string | null }

export function SearchPanel({ wid, commands, close, primary = false }: { wid: string; commands: Command[]; close: () => void; primary?: boolean }) {
  const { t, label, number } = useFormat();
  const [query, setQuery] = useState('');
  const read = useCommandRead<{ items: Hit[]; total: number }>(wid, commands, 'workspace', 'search', { q: query }, !!query);
  return <Dialog title={t('ui.globalSearch')} close={close}>
    <form className="wb-filter" onSubmit={event => { event.preventDefault(); setQuery(String(new FormData(event.currentTarget).get('q') ?? '').trim()); }}>
      <input aria-label={t('ui.globalSearch')} name="q" type="search" required maxLength={200} autoFocus /><button>{t('ui.searchSubmit')}</button>
    </form>
    {query && read.isPending && <p role="status">{t('ui.loading')}</p>}
    {read.isError && <Failure error={read.error} retry={() => void read.refetch()} />}
    {read.data && <><p>{t('ui.loaded', { loaded: number(read.data.items.length), total: number(read.data.total) })}</p>
      {read.data.items.length ? <ul className="wb-search-results">{read.data.items.map(hit => {
        const section = sections.find(item => 'module' in item && item.module === hit.module && item.views.some(kind => kind === hit.kind));
        const path = section && `/w/${encodeURIComponent(wid)}/${section.path}?${new URLSearchParams({ ...(primary && { source: 'commands' }), view: hit.kind, record: hit.id })}`;
        return <li key={`${hit.module}:${hit.kind}:${hit.id}`}><small>{label('kind', hit.kind)}</small>{path ? <Link to={path} onClick={close}>{hit.title}</Link> : <strong>{hit.title}</strong>}<Status value={hit.status ?? ''} /></li>;
      })}</ul> : <Empty>{t('ui.emptySearch')}</Empty>}</>}
  </Dialog>;
}
