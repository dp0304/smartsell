import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { callOperation, findOperation, recordRows, stringValue, wsKey, type WorkspaceApi } from './api';
import { useCopy } from './i18n';

export function useBrandScope(api: WorkspaceApi) {
  const storageKey = `smartsell-brand:${api.session.user.id}:${api.ws}`;
  const [selection, setSelection] = useState<{ key: string; id: string }>();
  const option = selection?.key === storageKey ? selection.id : sessionStorage.getItem(storageKey) ?? '';
  const operation = findOperation(api, 'GET', '/brands', 'workspace');
  const read = useQuery({ queryKey: [...wsKey(api.ws), 'brand-options', api.session.user.id], enabled: Boolean(operation),
    queryFn: ({ signal }) => callOperation(api, operation!, [], { signal }) });
  const brands = (recordRows(read.data?.data) ?? []).filter(row => row.status === 'active');
  const brandId = brands.some(row => row.id === option) ? option : '';
  return { brands, brandId, select(id: string) {
    sessionStorage.setItem(storageKey, id);
    setSelection({ key: storageKey, id });
  } };
}

export function BrandScope({ scope }: { scope: ReturnType<typeof useBrandScope> }) {
  const { label } = useCopy();
  if (!scope.brands.length) return null;
  return <select aria-label={label(['品牌範圍', 'Brand scope', '品牌范围'])} value={scope.brandId}
    style={{ maxWidth: '11rem' }} onChange={event => scope.select(event.target.value)}>
    <option value="">{label(['全部品牌', 'All brands'])}</option>
    {scope.brands.map(row => <option key={stringValue(row.id)} value={stringValue(row.id)}>{stringValue(row.name)}</option>)}
  </select>;
}

export const brandScopedLists = new Set([
  '/brands', '/campaigns', '/content-items', '/ideas', '/content-pillars', '/assets', '/rights-grants',
  '/knowledge', '/templates', '/products', '/stores', '/publish-targets', '/social-accounts', '/work-items',
]);
