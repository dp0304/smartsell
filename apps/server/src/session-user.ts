import type { PoolClient } from 'pg';

export type SessionUser = { id: string; email: string; name: string; username?: string };
type SessionUserRow = Omit<SessionUser, 'username'> & { username?: string | null };

export function publicUser({ id, email, name, username }: SessionUserRow): SessionUser {
  return { id, email: email === `username:${id}` ? '' : email, name, ...(username ? { username } : {}) };
}

export async function postgresSessionUser(client: PoolClient, tokenHash: string) {
  const { rows: [user] } = await client.query<SessionUserRow>('SELECT * FROM ss.session_user_profile($1)', [tokenHash]);
  return user && publicUser(user);
}
