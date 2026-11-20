import { useEffect, useId, useRef, type ReactNode } from 'react';

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-mark" aria-hidden="true">◇</span><strong>{title}</strong>{detail && <p>{detail}</p>}{action}</div>;
}

export function Busy({ label }: { label: string }) {
  return <div className="busy" role="status"><span className="spinner" />{label}</div>;
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warning' | 'critical' }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function EntityTable<T>({ columns, records, rowKey }: {
  columns: { label: string; cell: (record: T) => ReactNode }[];
  records: T[];
  rowKey: (record: T) => string;
}) {
  return <div className="table-scroll"><table className="entity-table"><thead><tr>{columns.map(column => <th scope="col" key={column.label}>{column.label}</th>)}</tr></thead><tbody>
    {records.map(record => <tr key={rowKey(record)}>{columns.map(column => <td key={column.label}>{column.cell(record)}</td>)}</tr>)}
  </tbody></table></div>;
}

export function Drawer({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="drawer" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id={titleId}>{title}</h2><button className="icon-button" type="button" aria-label={closeLabel} onClick={onClose}>×</button></header>
    <div className="drawer-body">{children}</div>
  </dialog>;
}

export * from './view';
