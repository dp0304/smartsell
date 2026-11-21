import type { Data } from '@smartsell/contracts';
import type { queryMetrics } from './metrics.js';

export function reportObservationIds(data: Data): string[] {
  const ids = (result: Data) => (result.evidence as { observations?: { id: string }[] }[] | undefined)
    ?.flatMap(point => (point.observations ?? []).map(observation => observation.id)) ?? [];
  return [...ids(data), ...(data.comparison ? ids(data.comparison as Data) : [])];
}

type MetricResult = Awaited<ReturnType<typeof queryMetrics>>;
type MetricReportResult = MetricResult & { comparison?: MetricResult | null };

export function metricReportResult(type: string | undefined, result: MetricReportResult): MetricReportResult {
  if (type !== 'narrative') return result;
  const withoutTrace = (data: MetricResult): MetricResult => ({ ...data,
    rows: data.rows.map(row => ({ ...row, values: Object.fromEntries(Object.entries(row.values).map(([key, cell]) => [key, { ...cell, refs: [] }])) })),
    evidence: data.evidence.map(point => ({ ...point, observations: [] })),
  });
  return { ...withoutTrace(result), ...(result.comparison && { comparison: withoutTrace(result.comparison) }) };
}
