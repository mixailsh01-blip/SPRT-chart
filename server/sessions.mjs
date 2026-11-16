import { createHmac } from 'node:crypto';

export function findSession(store, headers, now = Date.now()) {
  const token = String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !store.secret) return null;
  const key = createHmac('sha256', store.secret).update('s:' + token).digest('hex');
  const session = store.sessions?.[key];
  return session?.exp > now ? { ...session, key } : null;
}
