// Tray model (§8.2, §8.17, §8.18): a pure function of the shell state so the
// menu, tooltip and colour are tested without Electron. Red means the owner
// must act on this machine (vault locked, device revoked); a badge means a
// newer Worker is available.

export type TrayTone = 'ok' | 'warn' | 'error';
export interface TrayItem { id: string; label: string; enabled: boolean; separator?: boolean }
export interface TrayModel { tooltip: string; tone: TrayTone; badge: boolean; items: TrayItem[] }

export interface TrayInput {
  role: 'worker' | 'agent' | null;
  machineName: string | null;
  connection: 'unpaired' | 'starting' | 'online' | 'reconnecting' | 'device_revoked' | 'stopped' | 'vault_locked' | 'agent_open' | 'agent_offline' | 'agent_unauthorized' | 'agent_unconnected';
  nextRetryAt?: string | null;
  jobs: number;
  needsOwner: number;
  emergencyStop: boolean;
  updateVersion: string | null;
  uploads?: number;
  now?: number;
}

function statusLine(input: TrayInput): { text: string; tone: TrayTone } {
  const name = input.machineName ?? '這台機器';
  switch (input.connection) {
    case 'vault_locked': return { text: `${name}：需要允許鑰匙圈存取才能連線`, tone: 'error' };
    case 'device_revoked': return { text: `${name}：已在中樞撤銷或停用`, tone: 'error' };
    case 'unpaired': return { text: '尚未配對：打開視窗貼上中樞位址', tone: 'warn' };
    case 'starting': return { text: `${name}：正在連線`, tone: 'warn' };
    case 'reconnecting': {
      const seconds = input.nextRetryAt && input.now ? Math.max(0, Math.round((Date.parse(input.nextRetryAt) - input.now) / 1000)) : null;
      return { text: `${name}：中樞連不上${seconds !== null ? `，${seconds} 秒後重試` : '，正在重試'}`, tone: 'warn' };
    }
    case 'stopped': return { text: `${name}：已停止`, tone: 'warn' };
    case 'online': return { text: `${name}：在線`, tone: input.needsOwner > 0 ? 'warn' : 'ok' };
    case 'agent_open': return { text: '筆電模式：已連上中樞通知', tone: 'ok' };
    case 'agent_offline': return { text: '筆電模式：中樞通知連不上，正在重試', tone: 'warn' };
    case 'agent_unauthorized': return { text: '筆電模式：連線已撤銷，請重新連接', tone: 'error' };
    case 'agent_unconnected': return { text: '筆電模式：尚未連接 Codex／Claude Code', tone: 'warn' };
  }
}

export function trayModel(input: TrayInput): TrayModel {
  const status = statusLine(input);
  const items: TrayItem[] = [{ id: 'status', label: status.text, enabled: false }];
  if (input.role === 'worker') {
    if (input.jobs > 0) items.push({ id: 'jobs', label: `本機任務 ${input.jobs} 則${input.needsOwner ? `（${input.needsOwner} 則要你處理）` : ''}`, enabled: false });
    if (input.emergencyStop) items.push({ id: 'resume', label: '解除緊急停止', enabled: true });
    else items.push({ id: 'stop', label: '緊急停止', enabled: input.connection !== 'unpaired' && input.connection !== 'vault_locked' });
  }
  if (input.role === 'agent' && input.uploads) items.push({ id: 'uploads', label: `背景上傳 ${input.uploads} 個`, enabled: false });
  if (input.updateVersion) items.push({ id: 'update', label: `SmartSell Worker ${input.updateVersion} 可更新…`, enabled: true });
  items.push({ id: 'sep', label: '', enabled: false, separator: true });
  items.push({ id: 'show', label: input.role === 'agent' ? '打開 SmartSell' : '打開 SmartSell Worker', enabled: true });
  items.push({ id: 'quit', label: '結束', enabled: true });
  const tone: TrayTone = input.emergencyStop && status.tone === 'ok' ? 'warn' : status.tone;
  return { tooltip: `SmartSell Worker — ${status.text}`, tone, badge: !!input.updateVersion, items };
}

/** 18×18 RGBA tray glyph: a rounded square with an "S" stroke; red/amber dot for error/warn, blue dot for an update. */
export function trayPixels(tone: TrayTone, badge: boolean): { pixels: Buffer; template: boolean } {
  const size = 18;
  const pixels = Buffer.alloc(size * size * 4);
  const paint = (x: number, y: number, [r, g, b, a]: number[]) => { const at = (y * size + x) * 4; pixels[at] = r; pixels[at + 1] = g; pixels[at + 2] = b; pixels[at + 3] = a; };
  const ink = [0, 0, 0, 255];
  for (let y = 1; y < 17; y++) for (let x = 1; x < 17; x++) {
    const border = x === 1 || x === 16 || y === 1 || y === 16;
    const mark = (x >= 5 && x <= 12 && [5, 8, 12].includes(y)) || (x === 5 && y === 6) || (x === 5 && y === 7) || (x === 12 && y >= 9 && y <= 11);
    if (border || mark) paint(x, y, ink);
  }
  const dot = tone === 'error' ? [220, 38, 38, 255] : tone === 'warn' ? [217, 119, 6, 255] : badge ? [37, 99, 235, 255] : null;
  if (dot) for (let y = 11; y < 18; y++) for (let x = 11; x < 18; x++) if ((x - 14) ** 2 + (y - 14) ** 2 <= 10) paint(x, y, dot);
  // A template image is recoloured by macOS; coloured status dots need a normal image.
  return { pixels, template: !dot };
}
