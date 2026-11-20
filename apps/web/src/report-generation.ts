export interface ReportGenerationStatus {
  operation_id: string;
  status: string;
  version: number;
  result_ref?: { report_id: string; version_id: string; version_no: number };
}

export async function waitForReportVersion(read: () => Promise<ReportGenerationStatus>, onStatus?: (job: ReportGenerationStatus) => void) {
  const expires = Date.now() + 90_000;
  do {
    const job = await read();
    onStatus?.(job);
    if (job.result_ref) return job.result_ref;
    if (job.status === 'cancelled' || job.status === 'failed') throw new Error(`report_generation_${job.status}`);
    await new Promise(resolve => setTimeout(resolve, 600));
  } while (Date.now() < expires);
  throw new Error('report_generation_timeout');
}
