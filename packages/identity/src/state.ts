import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const opaque = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export class IdentityError extends Error {
  constructor(readonly statusCode = 401, message = 'Identity verification failed') { super(message); }
}

export interface IdentityState {
  read<T>(key: string): Promise<{ version: string; value: T } | null>;
  compareAndSwap<T>(key: string, version: string | null, value: T): Promise<boolean>;
  putFlow<T>(key: string, binding: string, expiresAt: number, value: T): Promise<void>;
  takeFlow<T>(key: string, binding: string): Promise<T | null>;
}

export interface IdentitySql {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export class PostgresIdentityState implements IdentityState {
  constructor(private readonly db: IdentitySql) {}

  async read<T>(key: string) {
    const { rows } = await this.db.query<{ version: string; value: T }>(
      'SELECT version, value FROM ss_identity.state WHERE key = $1', [key],
    );
    return rows[0] ?? null;
  }

  async compareAndSwap<T>(key: string, version: string | null, value: T) {
    const params = [key, opaque(), JSON.stringify(value)];
    const { rows } = version === null
      ? await this.db.query('INSERT INTO ss_identity.state (key, version, value) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING key', params)
      : await this.db.query('UPDATE ss_identity.state SET version=$2, value=$3::jsonb WHERE key=$1 AND version=$4 RETURNING key', [...params, version]);
    return rows.length === 1;
  }

  async putFlow<T>(key: string, binding: string, expiresAt: number, value: T) {
    await this.db.query('INSERT INTO ss_identity.flow (key, binding, expires_at, value) VALUES ($1,$2,$3,$4::jsonb)',
      [key, binding, new Date(expiresAt), JSON.stringify(value)]);
  }

  async takeFlow<T>(key: string, binding: string) {
    const { rows } = await this.db.query<{ value: T }>(
      'DELETE FROM ss_identity.flow WHERE key=$1 AND binding=$2 AND expires_at > clock_timestamp() RETURNING value', [key, binding],
    );
    return rows[0]?.value ?? null;
  }

  async purgeExpiredFlows() {
    await this.db.query('DELETE FROM ss_identity.flow WHERE expires_at <= clock_timestamp()');
  }
}

export class IdentitySecrets {
  private readonly key: Buffer;
  constructor(secret: Uint8Array) {
    if (secret.length !== 32) throw new Error('Identity encryption requires a 32-byte key');
    this.key = Buffer.from(hkdfSync('sha256', secret, '', 'smartsell/identity/aes-gcm/v1', 32));
  }

  seal(value: string, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }

  open(value: string, context: string) {
    const data = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8');
  }
}
