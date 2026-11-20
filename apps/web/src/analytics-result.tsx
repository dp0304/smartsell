import { Link, useParams } from 'react-router-dom';
import { useId, useState } from 'react';
import { ReadState, useRead } from './api';
import { EntityTable } from '@smartsell/ui';
import type { Payload } from './workbench-api';

const historyReasons: Record<string, readonly [string, string]> = {
  HISTORY_START_UNKNOWN: ['可讀訂單歷史起點未知，無法確認新客。', 'Order history start is unknown. New customers cannot be verified.'],
  INSUFFICIENT_ORDER_HISTORY: ['可讀訂單歷史不足，首購判定可信度低。', 'Available order history is too short to verify first purchases.'],
  FIRST_PURCHASE_UNVERIFIED: ['缺少可驗證的首購訂單序號。', 'A verified first-order index is missing.'],
  PROVIDER_IDENTITY_UNAVAILABLE: ['此平台無法可靠識別買家，已排除於首購群組。', 'This platform cannot reliably identify repeat buyers and is excluded from first-purchase cohorts.'],
};

const records = (value: unknown) => Array.isArray(value) ? value as Payload[] : [];
const record = (value: unknown): Payload => value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : {};
const text = (value: unknown) => typeof value === 'string' ? value : '—';
const bilingual = (locale: string, zh: string, en: string) => locale === 'en' ? en : zh;
const availabilityLabels: Record<string, readonly [string, string]> = {
  observed: ['已觀測', 'Observed'], estimated: ['估算', 'Estimated'], not_collected: ['未採集', 'Not collected'],
  no_permission: ['無權限', 'No permission'], source_not_provided: ['來源未提供', 'Source did not provide'],
  sync_failed: ['同步失敗', 'Sync failed'], not_applicable: ['不適用', 'Not applicable'],
};
function availability(locale: string, status: unknown) {
  const labels = availabilityLabels[String(status)];
  return labels ? bilingual(locale, ...labels) : text(status);
}

function MetricRows({ result, locale, chart = false, onTrace }: { result: Payload; locale: string; chart?: boolean; onTrace?: (refs: string[]) => void }) {
  const copy = (zh: string, en: string) => bilingual(locale, zh, en);
  const rows = records(result.rows).flatMap((row, index) => Object.entries(record(row.values)).map(([key, cell]) => {
    const { value, currency, availability, refs } = record(cell);
    return { id: `${index}:${key}`, group: Object.values(record(row.group)).join(' · '), key, value, currency, availability,
      refs: Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === 'string') : [] };
  }));
  if (!rows.length) return <p>{copy('沒有指標結果。', 'No metric results.')}</p>;
  const format = new Intl.NumberFormat(locale);
  const display = (row: typeof rows[number]) => typeof row.value === 'number'
    ? `${format.format(row.value)}${typeof row.currency === 'string' ? ` ${row.currency} ${copy('（最小單位）', '(minor units)')}` : ''}` : '—';
  const series = new Map<string, typeof rows>();
  if (chart) for (const row of rows) {
    const key = JSON.stringify([row.key, row.currency]);
    const group = series.get(key) ?? [];
    group.push(row);
    series.set(key, group);
  }
  return <>{[...series.values()].map(group => {
    const values = group.flatMap(row => typeof row.value === 'number' ? [row.value] : []);
    const min = values.reduce((min, value) => Math.min(min, value), 0);
    const max = values.reduce((max, value) => Math.max(max, value), 0);
    const position = (n: number) => max === min ? 0 : ((n - min) / (max - min)) * 100;
    const baseline = position(0);
    const title = `${copy('指標圖表', 'Metric chart')} · ${group[0].key}${group[0].currency ? ` · ${group[0].currency}` : ''}`;
    return <figure className="metric-chart" key={title} aria-label={title}>
      <figcaption>{title}</figcaption>
      <ul>{group.map(row => {
        const estimated = row.availability === 'estimated';
        const status = row.value === 0 && !estimated ? copy('實測零值', 'Observed zero') : availability(locale, row.availability);
        const label = `${row.group ? `${row.group} · ` : ''}${display(row)} · ${status}`;
        const end = typeof row.value === 'number' ? position(row.value) : undefined;
        return <li key={row.id} data-availability={String(row.availability)}>
          {onTrace && row.refs.length ? <button type="button" className="text-button" onClick={() => onTrace(row.refs)}>{label}</button> : <span>{label}</span>}
          <span className="metric-chart-track" title={label} aria-hidden="true">
            {end !== undefined && <span className={`metric-chart-mark${estimated ? ' estimated' : ''}${row.value === 0 ? ' zero' : ''}`}
              style={{ insetInlineStart: `${Math.min(baseline, end)}%`, inlineSize: `${Math.abs(end - baseline)}%` }} />}
          </span>
        </li>;
      })}</ul>
    </figure>;
  })}
  <EntityTable records={rows} rowKey={row => row.id} columns={[
    { label: copy('分組', 'Group'), cell: row => row.group || '—' },
    { label: copy('指標', 'Metric'), cell: row => row.key },
    { label: copy('數值', 'Value'), cell: display },
    { label: copy('可用性', 'Availability'), cell: row => availability(locale, row.availability) },
    ...(onTrace ? [{ label: copy('來源證據', 'Source evidence'), cell: (row: typeof rows[number]) => row.refs.length > 0 ?
      <button type="button" className="text-button" aria-label={`${copy('追溯數值', 'Trace value')} · ${row.key}${row.group ? ` · ${row.group}` : ''}`}
        onClick={() => onTrace(row.refs)}>{copy('追溯數值', 'Trace value')}</button> : '—' }] : []),
  ]} /></>;
}

function EvidenceSnapshot({ id }: { id: string }) {
  const read = useRead('/raw-records/:id', [id], {}, 'ingest');
  return <><ReadState read={read} />{read.isSuccess && !read.isFetching && <pre>{JSON.stringify(record(read.data.data).payload, null, 2)}</pre>}</>;
}

function TradeTrace({ versionId, sectionKey, traceKey, locale }: { versionId: string; sectionKey: string; traceKey: string; locale: string }) {
  const { wid } = useParams();
  const copy = (zh: string, en: string) => locale === 'en' ? en : zh;
  const read = useRead('/report-versions/:id/commerce-provenance', [versionId], { section_key: sectionKey, trace_key: traceKey }, 'analytics');
  const result = record(read.data?.data);
  return <>
    <ReadState read={read} />
    {result.status === 'not_captured' && <p>{copy('此版本未保存電商來源。', 'Commerce sources were not captured for this version.')}</p>}
    {records(result.rows).map(row => <div key={String(row.key)}>
      {records(row.sources).length === 0 && <p>{copy('此數值沒有交易來源。', 'No transaction sources for this value.')}</p>}
      <ul>{records(row.sources).map(source => <li key={String(source.fact_id)}>
        {String(source.kind)} · {String(source.fact_id)}
        {typeof source.import_batch_id === 'string' && <> · <Link to={`/w/${wid}/data?related=import&rid=${encodeURIComponent(source.import_batch_id)}`}>
          {copy('匯入批次', 'Import batch')} {source.import_batch_id}</Link> · {copy('原始列', 'Source row')} {String(source.source_row ?? '—')} · {copy('映射版本', 'Mapping revision')} {String(source.mapping_version ?? '—')}</>}
        {typeof source.sync_run_id === 'string' && <> · <Link to={`/w/${wid}/data/sync-runs/${encodeURIComponent(source.sync_run_id)}`}>{copy('採集執行', 'Sync run')} {source.sync_run_id}</Link></>}
        {(source.status === 'deleted' || source.status === 'expired') && <> · {source.status === 'deleted'
          ? copy('已依保留政策刪除', 'Deleted by retention policy') : copy('已超出保留期', 'Retention expired')}</>}
        {source.status === 'restricted' && <> · {copy('來源受限', 'Source restricted')}</>}
        {source.status === 'not_retained' && <> · {copy('未保留原始紀錄', 'Raw record not retained')}</>}
        {source.status === 'available' && source.payload != null && <details><summary>{copy('查看原始列', 'View source row')}</summary><pre>{JSON.stringify(source.payload, null, 2)}</pre></details>}
      </li>)}</ul>
    </div>)}
  </>;
}

function TradeTraceDisclosure(props: Parameters<typeof TradeTrace>[0]) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{props.locale === 'en' ? 'Trace transaction sources' : '追溯交易來源'}</summary>
    {open && <TradeTrace {...props} />}
  </details>;
}

function IngestTrace({ versionId, observationId, locale }: { versionId: string; observationId: string; locale: string }) {
  const read = useRead('/report-versions/:id/provenance', [versionId], { observation_id: observationId }, 'analytics');
  const copy = (zh: string, en: string) => bilingual(locale, zh, en);
  const trace = record(read.data?.data);
  const raw = record(trace.raw_evidence);
  return <><ReadState read={read} />{read.data && <>
    {typeof trace.data_source_id === 'string' && <p>{copy('資料來源', 'Data source')} · {text(trace.source_name)} · {trace.data_source_id}</p>}
    {typeof trace.sync_run_id === 'string' && <p>{copy('同步批次', 'Sync run')} · {trace.sync_run_id} · {text(trace.run_status)}</p>}
    {typeof trace.import_batch_id === 'string' && <p>{copy('匯入批次', 'Import batch')} · {trace.import_batch_id} · {copy('來源列', 'Source row')} {String(trace.source_row)}</p>}
    {trace.mapping_version != null && <p>{copy('映射版本', 'Mapping version')} · {String(trace.mapping_version)}</p>}
    {raw.status === 'deleted' ? <p>{copy('已依保留政策刪除', 'Deleted under the retention policy')}</p>
      : raw.status === 'expired' ? <p>{copy('已超過保留期限', 'Retention period expired')}</p>
      : raw.status === 'restricted' ? <p>{copy('無權限檢視原始證據', 'No permission to view raw evidence')}</p>
      : raw.status === 'available' ? <>
        {typeof raw.raw_record_id === 'string' && <><p>{copy('原始紀錄', 'Raw record')} · {raw.raw_record_id}</p><EvidenceSnapshot id={raw.raw_record_id} /></>}
        {raw.payload != null && <pre>{JSON.stringify(raw.payload, null, 2)}</pre>}
        <p>{copy('保留至', 'Retained until')} · {text(raw.retention_until)}</p>
      </> : <p>{copy('未保留原始證據', 'Raw evidence was not retained')}</p>}
  </>}</>;
}

function ReportTrace({ version, locale }: { version: Payload; locale: string }) {
  const id = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const versionId = typeof version.id === 'string' ? version.id : undefined;
  const copy = (zh: string, en: string) => bilingual(locale, zh, en);
  const sections = records(version.query_snapshot);
  const results = Array.isArray(version.results) ? records(version.results).map(row => [String(row.section_key), record(row.data)] as const)
    : Object.entries(record(version.results)).map(([key, data]) => [key, record(data)] as const);
  const anchors = new Map(sections.map(section => [String(section.key), `${id}-section-${encodeURIComponent(String(section.key))}`]));
  const byId = new Map<string, Payload>();
  for (const [, result] of results) for (const dataset of [result, record(result.comparison)]) for (const point of records(dataset.evidence)) {
    for (const observation of records(point.observations)) byId.set(String(observation.id), { ...observation, metric_key: point.metric_key, platform: point.platform });
    for (const ref of records(point.records)) if (!byId.has(String(ref.id))) byId.set(String(ref.id), { id: ref.id });
  }
  for (const refs of Object.values(record(version.evidence))) for (const ref of records(refs)) {
    if (!byId.has(String(ref.id))) byId.set(String(ref.id), { id: ref.id });
  }
  const observationTarget = (ref: string) => `${id}-observation-${encodeURIComponent(ref)}`;
  return <section aria-label={copy('報告追溯', 'Report traceability')}>
    <h3>{copy('凍結報告版本', 'Frozen report version')} {String(version.version_no)} · {text(version.status)}</h3>
    <p>{copy('資料截止時間', 'Data cutoff')} · {text(version.data_cutoff_at)}</p>
    {records(version.narrative).map((section, index) => <section key={index}>
      <h4>{copy('結論', 'Conclusions')} · {text(section.section_key)}</h4>
      {records(section.blocks).map((block, blockIndex) => <div key={blockIndex}>
        <p><strong>{text(block.kind)}</strong> · {text(block.text)}</p>
        <ul>{(Array.isArray(block.refs) ? block.refs.filter((ref): ref is string => typeof ref === 'string') : []).map((ref, index) => {
          const sectionKey = ref.startsWith('section:') ? ref.slice(8) : ref;
          const observationId = byId.has(ref) ? ref : ref.split('/').at(-1) ?? '';
          const target = anchors.get(sectionKey) ?? (byId.has(observationId) ? observationTarget(observationId) : undefined);
          return <li key={index}>{target ? <a href={`#${encodeURIComponent(target)}`}>{anchors.has(sectionKey) ? copy('查看凍結區段', 'View frozen section') : copy('查看來源觀測', 'View source observation')} · {anchors.has(sectionKey) ? sectionKey : observationId}</a> : ref}</li>;
        })}</ul>
      </div>)}
    </section>)}
    {sections.map(section => {
      const key = String(section.key);
      const data = results.find(([name]) => name === key)?.[1];
      return <section key={key} id={anchors.get(key)} tabIndex={-1} aria-label={`${copy('凍結區段', 'Frozen section')} · ${key}`}>
        <h4>{key}</h4>
        {data && <>{section.source === 'revenue' || section.source === 'attribution'
          ? <AnalyticsResult action={section.source === 'revenue' ? 'revenue_query' : 'attribution_query'} result={data} locale={locale}
            trace={versionId ? traceKey => <TradeTraceDisclosure versionId={versionId} sectionKey={key} traceKey={traceKey} locale={locale} /> : undefined} />
          : <><MetricRows result={data} locale={locale} chart={section.type === 'chart'} onTrace={versionId ? setSelected : undefined} />
            {data.comparison && <><h5>{copy('比較期間', 'Comparison period')}</h5><MetricRows result={record(data.comparison)} locale={locale} chart={section.type === 'chart'} onTrace={versionId ? setSelected : undefined} /></>}</>}</>}
      </section>;
    })}
    {versionId && selected.length > 0 && <section aria-label={copy('採集來源追溯', 'Ingest provenance')} tabIndex={-1} ref={node => node?.focus()}>
      <h4>{copy('採集來源追溯', 'Ingest provenance')}</h4>
      <button type="button" onClick={() => setSelected([])}>{copy('關閉來源追溯', 'Close provenance')}</button>
      {selected.map(ref => <section key={ref} aria-label={ref}>
        <h5>{ref}</h5><IngestTrace versionId={versionId} observationId={ref} locale={locale} />
      </section>)}
    </section>}
    {byId.size > 0 && <section aria-label={copy('凍結來源觀測', 'Frozen source observations')}>
      <h4>{copy('凍結來源觀測', 'Frozen source observations')}</h4>
      <ul>{[...byId].map(([ref, observation]) => <li id={observationTarget(ref)} key={ref} tabIndex={-1}>
        <strong>{ref}</strong>{observation.observed_at ? <> · {text(observation.metric_key)} · {text(observation.platform)} · {text(observation.observed_at)} · {availability(locale, observation.availability)} · {typeof observation.value === 'number' ? observation.value : '—'} · {copy('定義版本', 'Definition revision')} {String(observation.definition_revision)} · {text(record(observation.source).method)}
          {versionId && <button type="button" className="text-button" onClick={() => setSelected([ref])}>{copy('追溯來源觀測', 'Trace source observation')}</button>}
        </> : ` · ${copy('來源參照', 'Source reference')}`}
      </li>)}</ul>
    </section>}
  </section>;
}

export function AnalyticsResult({ action, result, locale, onPick, trace }: { action: string; result: Payload; locale: string; onPick?: (id: string) => void; trace?: (key: string) => React.ReactNode }) {
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  const label = (key: string) => key.replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
  const copy = (zh: string, en: string) => locale === 'en' ? en : zh;
  const value = (n: unknown) => typeof n === 'number' ? number(n) : '—';
  if (action === 'reports_get') {
    const version = record(result.data ?? result);
    return version.version_no == null ? null : <ReportTrace version={version} locale={locale} />;
  }
  if (action === 'links_performance_get') {
    const rows = records(result.items);
    if (!rows.length) return <p>{copy('沒有符合條件的短連結。', 'No matching short links.')}</p>;
    return <section aria-label={copy('短連結成效結果', 'Link performance results')}>
      <EntityTable records={rows} rowKey={row => String(row.short_link_id)} columns={[
        { label: copy('短連結 ID', 'Short link ID'), cell: row => text(row.short_link_id) },
        { label: copy('跳轉數', 'Redirects'), cell: row => value(row.redirects) },
        { label: copy('過濾後點擊', 'Filtered clicks'), cell: row => value(row.clicks_filtered) },
      ]} />
    </section>;
  }
  if (action === 'contribution_query') {
    const missing = Array.isArray(result.missing_items) ? result.missing_items.map(item => label(String(item))) : [];
    return <section aria-label={copy('估算貢獻結果', 'Estimated contribution result')}>
      <p><strong>{copy('估算貢獻，非財務利潤。', 'Estimated contribution, not financial profit.')}</strong></p>
      <p>{copy('公式', 'Formula')} v{value(result.formula_version)} · {copy('淨銷售額減下列成本', 'Net sales minus the costs below')}</p>
      <p><strong>{copy('估算貢獻', 'Estimated contribution')}</strong> · {text(result.currency)} · {typeof result.value_minor === 'number' ? value(result.value_minor) : copy('無法估算', 'Unavailable')}</p>
      {missing.length > 0 && <p>{copy('缺失項目', 'Missing inputs')} · {missing.join(', ')}</p>}
      <EntityTable records={records(result.items)} rowKey={row => String(row.item)} columns={[
        { label: copy('項目', 'Input'), cell: row => label(String(row.item)) },
        { label: copy('金額（最小貨幣單位）', 'Amount (minor currency units)'), cell: row => value(row.value ?? row.amount_minor) },
        { label: copy('狀態', 'Status'), cell: row => typeof (row.value ?? row.amount_minor) === 'number' ? copy('完整', 'Complete') : copy('缺失', 'Missing') },
        { label: copy('來源參照', 'Source references'), cell: row => Array.isArray(row.sources) && row.sources.length ? row.sources.join(', ') : '—' },
      ]} />
    </section>;
  }
  if (action === 'revenue_query') {
    const rows = records(result.rows);
    if (!rows.length) return <p>{copy('期間內沒有訂單觀測。', 'No order observations in this period.')}</p>;
    const refundValue = (total: unknown, observed: unknown) => typeof total === 'number' ? value(total)
      : typeof observed === 'number' && observed > 0 ? `${value(observed)} ${copy('（僅已觀測）', '(observed only)')}` : '—';
    return <section aria-label={copy('收入對帳結果', 'Revenue reconciliation result')}>
      <p>{copy('按訂單日期對帳；取消的訂單淨額為零，退款不再扣減。金額以最小貨幣單位顯示。', 'Grouped by order date. Cancelled orders contribute zero net sales and their refunds are not deducted again. Amounts are in minor currency units.')}</p>
      <EntityTable records={rows} rowKey={row => JSON.stringify([row.day, row.store_id, row.currency])} columns={[
        { label: copy('日期', 'Order date'), cell: row => text(row.day) },
        { label: copy('店鋪', 'Store'), cell: row => text(row.store_id) },
        { label: copy('貨幣', 'Currency'), cell: row => text(row.currency) },
        { label: copy('訂單總額', 'Order total'), cell: row => value(row.order_total_minor ?? row.observed_order_total_minor) },
        { label: copy('申請中退款', 'Requested refunds'), cell: row => refundValue(row.refunds_requested_minor, row.observed_refunds_requested_minor) },
        { label: copy('成功退款', 'Successful refunds'), cell: row => refundValue(row.refunds_succeeded_minor, row.observed_refunds_succeeded_minor) },
        { label: copy('取消金額', 'Cancelled amount'), cell: row => value(row.cancellations_minor) },
        { label: copy('淨銷售額', 'Net sales'), cell: row => value(row.net_sales_minor) },
        ...(trace ? [{ label: copy('來源證據', 'Source evidence'), cell: (row: Payload) => trace(`${row.day} · ${row.store_id} · ${row.currency}`) }] : []),
        { label: copy('覆蓋狀態', 'Coverage'), cell: row => {
          const warnings = Array.isArray(row.warnings) ? row.warnings : result.warnings;
          const flags = Array.isArray(warnings) ? warnings : [];
          return <>{flags.includes('ORDER_COVERAGE_INCOMPLETE') && <div>{copy('訂單資料未完整', 'Order data incomplete')}</div>}
            {flags.includes('REFUND_COVERAGE_INCOMPLETE') ? <div>{copy('退款資料未完整', 'Refund data incomplete')}</div> : typeof row.refunds_succeeded_minor === 'number' ? copy('退款已對帳', 'Refund coverage complete') : '—'}</>;
        } },
      ]} />
    </section>;
  }
  if (action === 'metric_definitions_get') {
    const definitions = records(result.items ?? result.definitions);
    return <section aria-label={copy('指標字典', 'Metric dictionary')}>
      <EntityTable records={definitions} rowKey={row => `${row.key}:${row.revision}`} columns={[
        { label: copy('指標', 'Metric'), cell: row => onPick && typeof row.key === 'string' ? <button className="text-button" onClick={() => onPick(String(row.key))}>{row.key}</button> : text(row.key) },
        { label: copy('原始名稱', 'Original name'), cell: row => text(row.native_name) },
        { label: copy('版本', 'Revision'), cell: row => value(row.revision) },
        { label: copy('口徑', 'Definition'), cell: row => text(row.text) },
        { label: copy('可加總性', 'Additivity'), cell: row => text(row.additivity) },
      ]} />
    </section>;
  }
  if (action === 'metrics_query' || action === 'posts_performance_get' || action === 'accounts_performance_get') {
    const subjects = Array.isArray(result.items) ? records(result.items) : [result];
    const coverage = record(result.coverage);
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const points = subjects.flatMap(subject => records(subject.evidence));
    const ageEvidence = points.filter(point => typeof point.method === 'string' && ['exact', 'nearest_before', 'interpolated', 'none'].includes(point.method));
    return <section aria-label={copy('指標查詢結果', 'Metric query results')}>
      {warnings.includes('NON_ADDITIVE_ACROSS_PLATFORMS') && <p>{copy('這些指標不能跨平台加總，結果按平台分開。', 'These metrics cannot be summed across platforms. Results are kept separate.')}</p>}
      <p>{copy('已觀測對象', 'Observed subjects')} · {value(coverage.subjects_observed)} / {value(coverage.subjects_total)}</p>
      {Object.keys(record(coverage.by_availability)).length > 0 && <ul>{Object.entries(record(coverage.by_availability)).map(([status, count]) => <li key={status}>{availability(locale, status)} · {value(count)}</li>)}</ul>}
      {!subjects.length && <p>{copy('沒有指標結果。', 'No metric results.')}</p>}
      {subjects.map((subject, index) => <div key={String(subject.subject_id ?? index)}>
        {typeof subject.subject_id === 'string' && <h3>{subject.subject_id}</h3>}
        <MetricRows result={subject} locale={locale} />
      </div>)}
      {ageEvidence.length > 0 && <section aria-label={copy('同齡觀測偏差', 'Same-age observation deviation')}>
        <h3>{copy('同齡觀測偏差', 'Same-age observation deviation')}</h3>
        <p>{copy('較早觀測可能低估同齡成效，內插為估算。', 'Earlier observations may understate same-age performance. Interpolated values are estimates.')}</p>
        <EntityTable records={ageEvidence} rowKey={row => String(ageEvidence.indexOf(row))} columns={[
          { label: copy('作品', 'Post'), cell: row => onPick && typeof row.subject_id === 'string'
            ? <button className="text-button" onClick={() => onPick(String(row.subject_id))}>{row.subject_id}</button> : text(row.subject_id) },
          { label: copy('平台', 'Platform'), cell: row => text(row.platform) },
          { label: copy('方法', 'Method'), cell: row => ({ exact: copy('同齡實測', 'Exact'), nearest_before: copy('最近的較早觀測', 'Nearest earlier observation'), interpolated: copy('內插', 'Interpolated'), none: copy('無適用觀測', 'No eligible observation') }[String(row.method)] ?? '—') },
          { label: copy('偏差（秒）', 'Deviation (seconds)'), cell: row => row.method === 'interpolated' ? '—' : value(row.deviation_seconds) },
          { label: copy('來源觀測年齡（秒）', 'Source observation ages (seconds)'), cell: row => records(row.observations).map(observation => value(observation.age_seconds)).join(' / ') || '—' },
        ]} />
      </section>}
    </section>;
  }
  if (action === 'cohorts_list') {
    const stores = records(result.items);
    return <section aria-label={copy('首購與復購客群', 'First-purchase and repeat cohorts')}>
      <p>{(result.observation_months === undefined ? copy('復購觀察日數', 'Repeat observation days') : copy('復購觀察月數', 'Repeat observation months'))} · {value(result.observation_days ?? result.observation_months)} {' · '}{copy('最低歷史月數', 'Minimum history months')} · {value(result.history_months)}</p>
      {!stores.length && <p>{copy('沒有符合條件的店鋪。', 'No matching stores.')}</p>}
      {stores.map(store => <section key={String(store.store_id)}>
        <h3>{String(store.store_name ?? store.store_id)} · {label(String(store.provider ?? 'unknown'))}</h3>
        <p>{copy('可讀歷史起點', 'Order history start')} · {typeof store.history_coverage_from === 'string' ? store.history_coverage_from : '—'} {' · '}{copy('未識別訂單', 'Unidentified orders')} · {value(store.unidentified_orders)}</p>
        {Array.isArray(store.limitations) && store.limitations.map(reason => <p key={String(reason)}>{historyReasons[String(reason)]?.[locale === 'en' ? 1 : 0] ?? String(reason)}</p>)}
        {!store.excluded && (records(store.rows).length ? <EntityTable records={records(store.rows)} rowKey={row => String(row.month)} columns={[
          { label: copy('首見月份', 'First-seen month'), cell: row => String(row.month) },
          { label: copy('首見買家', 'First-seen buyers'), cell: row => value(row.count ?? row.first_seen) },
          { label: copy('已確認新客', 'Verified new buyers'), cell: row => value(row.confirmed ?? row.confirmed_new) },
          { label: copy('新客判定可信度', 'New-customer reliability'), cell: row => row.new_customer_reliability === 'high' ? copy('高', 'High') : copy('低', 'Low') },
          { label: copy('首見買家復購率', 'First-seen buyer repeat rate'), cell: row => typeof row.repeat_rate === 'number'
            ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(row.repeat_rate)
            : copy('觀察期未滿', 'Observation window still open') },
        ]} /> : <p>{copy('期間內沒有可分析的客群。', 'No cohorts in this period.')}</p>)}
      </section>)}
    </section>;
  }
  if (action === 'attribution_query' || action === 'attribution_explain') {
    const totals = records(result.transaction_totals);
    const columns = records(result.columns);
    if (!totals.length) return <p>{copy('期間內沒有訂單。', 'No orders in this period.')}</p>;
    const summaries = records(result.rows);
    return <section aria-label={copy('歸因比較', 'Attribution comparison')}>
      <h3>{copy('交易總額（最小貨幣單位）', 'Transaction totals (minor currency units)')}</h3>
      <ul>{totals.map(total => <li key={String(total.currency)}>{String(total.currency)} · {value(total.net_order_minor)} · {value(total.orders)} {copy('筆訂單', 'orders')}{trace?.(`transaction_totals · ${total.currency}`)}</li>)}</ul>
      <p>{copy('各歸因模型獨立計算。平台自報可能重複計功。金額以最小貨幣單位顯示。', 'Model credits are independent. Platform-reported credit can overlap. Amounts are in minor currency units.')}</p>
      {!columns.length && <EntityTable records={totals} rowKey={row => String(row.currency)} columns={[
        { label: copy('貨幣', 'Currency'), cell: row => String(row.currency) },
        ...[...new Set(summaries.map(row => String(row.model_key)))].map(model => ({ label: label(model), cell: (row: Payload) => {
          const summary = summaries.find(entry => entry.model_key === model && entry.currency === row.currency);
          return <>{copy('歸因點數', 'Credited')} · {value(summary?.credited_minor)} <br />
            {copy('未歸因', 'Unattributed')} · {value(summary?.uncredited_minor)}{trace?.(`${model} · ${row.currency}`)}</>;
        } })),
      ]} />}
      {columns.length > 0 && <EntityTable records={records(columns[0]?.rows)} rowKey={row => String(row.order_id)} columns={[
        { label: copy('訂單', 'Order'), cell: row => String(row.order_id) },
        { label: copy('貨幣', 'Currency'), cell: row => String(row.currency) },
        ...columns.map(column => {
          const byOrder = new Map(records(column.rows).map(row => [row.order_id, row]));
          return { label: label(String(column.model_key)), cell: (row: Payload) => {
            const model = byOrder.get(row.order_id);
            const credits = records(model?.credits);
            const unattributed = model?.unallocated_minor;
            if (!credits.length && typeof unattributed === 'number' && unattributed > 0) return `${copy('未歸因', 'Unattributed')} · ${value(unattributed)}`;
            if (!credits.length) return '—';
            return <ul>{credits.map(credit => <li key={JSON.stringify([credit.credited_subject_type, credit.credited_subject_id])}>
              {String(credit.credited_subject_id)} · {value(model?.reconcilable ? credit.net_of_refunds_minor : credit.credited_amount_minor)}
            </li>)}</ul>;
          } };
        }),
      ]} />}
    </section>;
  }
  if (action === 'posting_time_suggest') {
    const data = (result.data ?? result) as Payload;
    if (data.reason === 'INSUFFICIENT_COMPARABLE_OBSERVATIONS') return <p>{copy('可比較作品不足，請繼續使用人工排程。', 'Too few comparable posts. Continue using manual scheduling.')} {value(data.sample_size)} / {value(data.minimum_sample_size)}</p>;
    if (data.reason === 'INSUFFICIENT_SLOT_SAMPLE') return <p>{copy('沒有時段達到最低樣本數，請繼續使用人工排程。', 'No time slot has enough observations. Continue using manual scheduling.')} {copy('每時段最少', 'Minimum per slot')} · {value(data.minimum_slot_sample_size)}</p>;
    const slots = records(data.slots);
    if (slots.length) return <EntityTable records={slots} rowKey={row => `${row.weekday}:${row.hour}`} columns={[
      { label: copy('星期', 'Weekday'), cell: row => String(row.weekday) },
      { label: copy('小時', 'Hour'), cell: row => value(row.hour) },
      { label: copy('樣本數', 'Sample size'), cell: row => value(row.sample_size) },
      { label: copy('平均分數', 'Average score'), cell: row => value(row.score) },
    ]} />;
  }
  if (action === 'experiments_transition' || action === 'experiments_list') {
    const experiments = action === 'experiments_list' ? records(result.items) : [result];
    const conclusions = experiments.flatMap(row => {
      const data = (row.data ?? row) as Payload;
      return data.status === 'concluded' && typeof data.limitations === 'string' ? [{ id: String(row.id), hypothesis: String(data.hypothesis), limitations: data.limitations }] : [];
    });
    if (conclusions.length) return <dl>{conclusions.map(row => <div key={row.id}><dt>{copy('結論限制', 'Conclusion limitations')} · {row.hypothesis}</dt><dd>{row.limitations}</dd></div>)}</dl>;
  }
  return null;
}
