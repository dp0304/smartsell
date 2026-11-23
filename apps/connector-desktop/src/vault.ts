import { createPrivateKey, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fields, opaqueId } from '../../../packages/connector-tasks/src/tasks.ts';

export type Pairing = { origin: string; workspace: string; device: string; name: string; key: KeyObject };
export interface Vault {
  load(): Pairing | undefined;
  save(pairing: Pairing): void;
  clear(): void;
  available(): boolean;
  check?(): void;
}

type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export function deviceVault(path: string, safe: SafeStorage, platform: string): Vault {
  const available = () => (platform === 'darwin' || platform === 'win32') && safe.isEncryptionAvailable();
  function requireEncryption() {
    if (!available()) throw new Error('系统安全存储不可用。');
  }
  return {
    available,
    check() {
      requireEncryption();
      const probe = randomBytes(24).toString('hex');
      const encrypted = safe.encryptString(probe);
      if (!encrypted.length || encrypted.includes(probe) || safe.decryptString(encrypted) !== probe) {
        throw new Error('系统安全存储验证失败。');
      }
    },
    load() {
      let ciphertext: Buffer;
      try { ciphertext = readFileSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      requireEncryption();
      if (ciphertext.length > 16_384) throw new Error('配对记录无效。');
      const row = fields(JSON.parse(safe.decryptString(ciphertext)), ['origin', 'workspace', 'device', 'name', 'privateKey']);
      if (typeof row.origin !== 'string' || typeof row.name !== 'string' || typeof row.privateKey !== 'string') throw new Error('配对记录无效。');
      const key = createPrivateKey(row.privateKey);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('配对密钥无效。');
      return { origin: row.origin, workspace: opaqueId(row.workspace, 'workspace'), device: opaqueId(row.device, 'device'), name: row.name, key };
    },
    save({ key, ...pairing }) {
      requireEncryption();
      const encrypted = safe.encryptString(JSON.stringify({ ...pairing, privateKey: key.export({ format: 'pem', type: 'pkcs8' }) }));
      const temp = `${path}.part`;
      writeFileSync(temp, encrypted, { mode: 0o600, flag: 'wx' });
      try { renameSync(temp, path); }
      finally { rmSync(temp, { force: true }); }
    },
    clear() {
      rmSync(path, { force: true });
      rmSync(`${path}.part`, { force: true });
    },
  };
}
