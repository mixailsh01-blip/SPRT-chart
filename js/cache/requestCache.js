const inflight = new Map();
const cache = new Map();

function isCacheValid(entry, ttlMs) {
  if (!entry) return false;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  return Date.now() - entry.fetchedAt < ttlMs;
}

export async function cached(key, options, fetcher) {
  const opts = options || {};
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 0;
  const force = Boolean(opts.force);
  const shouldCacheValue = ttlMs > 0;

  if (!force && shouldCacheValue) {
    const cachedEntry = cache.get(key);
    if (isCacheValid(cachedEntry, ttlMs)) {
      return cachedEntry.value;
    }
  }

  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const promise = Promise.resolve().then(fetcher);
  inflight.set(key, promise);
  try {
    const value = await promise;
    if (shouldCacheValue && inflight.get(key) === promise) {
      cache.set(key, { value, fetchedAt: Date.now() });
    }
    return value;
  } finally {
    if (inflight.get(key) === promise) inflight.delete(key);
  }
}

export function clearCache(key) {
  if (key) {
    cache.delete(key);
    inflight.delete(key);
    return;
  }
  cache.clear();
  inflight.clear();
}

export function invalidateKey(key) {
  if (!key) return;
  cache.delete(key);
}

export function invalidateByPrefix(prefix) {
  if (!prefix) return;
  for (const key of cache.keys()) {
    if (String(key).startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

export function peekCache(key) {
  return cache.get(key) || null;
}
