import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { asRecord } from '@smartsell/sdk';
import { Drawer, EmptyState } from '@smartsell/ui';
import { findOperation, ReadState, recordRows, stringValue, useApi, useRead } from './api';
import { useCopy } from './i18n';
import { optionLabel } from './option-labels';

// Workspace page and tab for each searchable resource type returned by GET /search.
const destinations: Record<string, [string, string, string?]> = {
  brand: ['settings/brands', 'brands'], market: ['settings/brands', 'brands'], campaign: ['campaigns', 'campaigns'],
  content_item: ['content', 'content'], asset: ['assets', 'assets'], product: ['commerce', 'products'],
  conversation: ['inbox', 'conversations'], customer: ['lifecycle', 'customers'], creator: ['creators', 'creators'],
  work_item: ['settings/brands', 'work'], knowledge_entry: ['assets', 'knowledge'],
};
const typeNames: Record<string, readonly [string, string, string?]> = {
  brand: ['品牌', 'Brand'], market: ['市場', 'Market', '市场'], campaign: ['活動', 'Campaign', '活动'], content_item: ['內容', 'Content', '内容'],
  asset: ['素材', 'Asset'], product: ['商品', 'Product'], conversation: ['對話', 'Conversation', '对话'], customer: ['客戶', 'Customer', '客户'],
  creator: ['達人', 'Creator', '达人'], work_item: ['工作項目', 'Work item', '工作项目'], knowledge_entry: ['品牌知識', 'Brand knowledge', '品牌知识'],
};

function Results({ query, close }: { query: string; close: () => void }) {
  const { label, locale } = useCopy();
  const api = useApi();
  const read = useRead('/search', [], { q: query, limit: '30' }, 'workspace');
  const rows = recordRows(read.data?.data) ?? [];
  const total = asRecord(read.data?.data).total;
  return <>
    <ReadState read={read} />
    {read.data && (rows.length ? <>
      <p className="muted">{label([`找到 ${stringValue(total) || rows.length} 筆`, `${stringValue(total) || rows.length} results`, `找到 ${stringValue(total) || rows.length} 条`])}</p>
      <ul className="search-results">{rows.map(row => {
        const type = stringValue(row.resource_type);
        const target = destinations[type];
        const id = stringValue(row.resource_id);
        const title = stringValue(row.title) || id;
        return <li key={`${type}:${id}`}><small>{typeNames[type] ? label(typeNames[type]) : type}</small>
          {target ? <Link to={`/w/${encodeURIComponent(api.ws)}/${target[0]}?${new URLSearchParams({ tab: target[1], id })}`} onClick={close}>{title}</Link> : <strong>{title}</strong>}
          {typeof row.status === 'string' && <span className="muted">{optionLabel(row.status, locale)}</span>}</li>;
      })}</ul></> : <EmptyState title={label(['沒有符合的結果', 'No matching results', '没有符合的结果'])} detail={label(['試試品牌、商品、內容標題或 SKU。', 'Try a brand, product, content title, or SKU.', '试试品牌、商品、内容标题或 SKU。'])} />)}
  </>;
}

/** Searches the records operators create in this workbench. */
export function PrimarySearch() {
  const { t, label } = useCopy();
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  if (!findOperation(api, 'GET', '/search', 'workspace')) return null;
  const title = label(['搜尋工作區', 'Search workspace', '搜索工作区']);
  return <>
    <button type="button" onClick={() => setOpen(true)}><Search size={16} />{title}</button>
    {open && <Drawer title={title} closeLabel={t('close')} onClose={() => { setOpen(false); setQuery(''); }}>
      <form className="search-form" onSubmit={event => { event.preventDefault(); setQuery(String(new FormData(event.currentTarget).get('q') ?? '').trim()); }}>
        <input type="search" name="q" aria-label={title} placeholder={label(['品牌、商品、內容、對話…', 'Brands, products, content, conversations…', '品牌、商品、内容、对话…'])} required maxLength={200} autoFocus />
        <button className="primary" type="submit">{label(['搜尋', 'Search', '搜索'])}</button>
      </form>
      {query && <Results key={query} query={query} close={() => { setOpen(false); setQuery(''); }} />}
    </Drawer>}
  </>;
}
