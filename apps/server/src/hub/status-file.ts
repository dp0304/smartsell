import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFile } from './hub-env.js';

/**
 * `<hubDir>/status.json` (§2.5). A configuration error is written here and the process exits with code 0, so neither
 * launchd `KeepAlive{SuccessfulExit:false}` nor Task Scheduler `RestartOnFailure` restarts it every few seconds;
 * `hub:service status` and `hub:doctor` read the reason from this file.
 */
export type HubState = 'config_error' | 'start_failed' | 'running' | 'stopped';
export interface HubStatus { state: HubState; message?: string; code?: string; at: string; pid?: number; version?: string; public_origin?: string }

export const HUB_STATUS_FILE = 'status.json';
export const hubStatusPath = (hubDir: string) => join(hubDir, HUB_STATUS_FILE);
const states = new Set<HubState>(['config_error', 'start_failed', 'running', 'stopped']);

export function writeHubStatus(hubDir: string, status: Omit<HubStatus, 'at'> & { at?: string }, now = new Date()) {
  if (!existsSync(hubDir)) return false;
  const value: HubStatus = { ...status, at: status.at ?? now.toISOString() };
  writePrivateFile(hubStatusPath(hubDir), `${JSON.stringify(value)}\n`);
  return true;
}

export type HubStatusRead = { status: 'missing' } | { status: 'invalid'; reason: string } | { status: 'ok'; value: HubStatus };

export function readHubStatus(hubDir: string): HubStatusRead {
  const path = hubStatusPath(hubDir);
  if (!existsSync(path)) return { status: 'missing' };
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { return { status: 'invalid', reason: 'status.json 不是有效的 JSON' }; }
  if (!value || typeof value !== 'object' || !states.has((value as HubStatus).state)) return { status: 'invalid', reason: 'status.json 的 state 不正確' };
  return { status: 'ok', value: value as HubStatus };
}

/** One owner-facing line describing the recorded state. */
export function describeHubStatus(read: HubStatusRead) {
  if (read.status === 'missing') return '尚未有啟動紀錄（status.json 不存在）：中樞還沒啟動過，或資料夾不對。';
  if (read.status === 'invalid') return read.reason;
  const { value } = read;
  switch (value.state) {
    case 'running': return `執行中（自 ${value.at} 起${value.pid ? `，pid ${value.pid}` : ''}）`;
    case 'stopped': return `已正常停止（${value.at}）`;
    case 'config_error': return `設定錯誤，未啟動（${value.at}）：${value.message ?? '未知原因'}`;
    case 'start_failed': return `啟動失敗，服務會自動重試（${value.at}）：${value.message ?? '未知原因'}`;
  }
}
