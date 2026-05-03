const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const store = new Map();

function makeKey(businessName, query) {
  return `${businessName.trim().toLowerCase()}::${query.trim().toLowerCase()}`;
}

export function get(businessName, query) {
  const key = makeKey(businessName, query);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function set(businessName, query, value, ttlMs = DEFAULT_TTL_MS) {
  const key = makeKey(businessName, query);
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function clear() {
  store.clear();
}

export function size() {
  return store.size;
}
