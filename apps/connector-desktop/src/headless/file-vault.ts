// Test-only vault (§8.14): the device key in a plaintext 0600 file. Refused
// unless SMARTSELL_TEST_MODE=1 in an unpackaged build; the App uses vault.ts
// (safeStorage) instead.
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testModeEnabled } from '../chrome.ts';
import { writeAtomic } from '../runtime/job-store.ts';

export interface FilePairing {
  origin: string; workspace_id: string; device_id: string; private_key_pem: string; machine_name: string; paired_at: string;
}

export class FileVault {
  readonly path: string;
  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    if (!testModeEnabled(env)) throw new Error('FileVault is test-only: set SMARTSELL_TEST_MODE=1 (never available in packaged builds).');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, 'test-vault.json');
  }
  load(): FilePairing | null {
    if (!existsSync(this.path)) return null;
    return JSON.parse(readFileSync(this.path, 'utf8')) as FilePairing;
  }
  save(pairing: FilePairing) {
    writeAtomic(this.path, JSON.stringify(pairing), 0o600);
    try { chmodSync(this.path, 0o600); } catch { /* Windows */ }
  }
}
