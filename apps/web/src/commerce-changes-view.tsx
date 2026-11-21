import { Link } from 'react-router-dom';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { EntityTable } from '@smartsell/ui';
import { stringValue, useApi } from './api';
import { useCopy } from './i18n';
import { records, Status, Timestamp } from './workflow-view-ui';

function price(value: unknown, locale: string) {
  const { price_amount_minor: amount, currency } = asRecord(value);
  if (typeof amount !== 'number' || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return '—';
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code' });
  return formatter.format(amount / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 0));
}

export function CommerceChangesTable({ rows, onPick }: { rows: RecordData[]; onPick: (row: RecordData) => void }) {
  const { ws } = useApi();
  const { label, locale, t } = useCopy();
  return <EntityTable records={rows} rowKey={row => stringValue(row.id)} columns={[
    { label: label(['商品變更', 'Product change']), cell: row => <>
      <button className="text-button" onClick={() => onPick(row)}>{row.change_type === 'price_changed' ? label(['價格已變更', 'Price changed']) : <Status value={row.change_type} />}</button>
      <div>{[row.product_title, row.sku].map(stringValue).filter(Boolean).join(' · ')}</div>
    </> },
    { label: label(['價格變動', 'Price change']), cell: row => row.change_type === 'price_changed' ? `${price(row.before, locale)} → ${price(row.after, locale)}` : '—' },
    { label: label(['受影響的發布目標', 'Affected publish targets']), cell: row => {
      const targets = records(row.affected_targets);
      return targets.length ? <ul>{targets.map(target => {
        const id = stringValue(target.id);
        const params = new URLSearchParams({ id });
        const date = stringValue(target.scheduled_at ?? target.local_scheduled_at);
        if (date) params.set('date', date);
        return <li key={id}><Link to={`/w/${encodeURIComponent(ws)}/calendar?${params}`}>{stringValue(target.title) || id}</Link></li>;
      })}</ul> : '—';
    } },
    { label: t('status'), cell: row => <Status value={row.status} /> },
    { label: label(['偵測時間', 'Detected at']), cell: row => <Timestamp value={row.detected_at} /> },
  ]} />;
}
