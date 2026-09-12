// Thin fetch wrapper. Session auth rides on an HttpOnly cookie, so every call
// needs credentials:'include' and there is no token to hold in JS.
async function call(method, path, body, opts = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    ...opts,
  });
  const text = await res.text();
  let data = null;
  let isJson = true;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; isJson = false; }
  if (!res.ok) {
    // A non-JSON body means the app never answered — a proxy or gateway did.
    // Collapsing that to "HTTP 502" hides the one fact worth knowing.
    const message = (data && data.error)
      || (!isJson && res.status >= 500
            ? `HTTP ${res.status} from the proxy — the backend did not respond (check its container logs)`
            : `HTTP ${res.status}`);
    const err = new Error(message);
    err.status = res.status;
    err.isJson = isJson;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => call('GET', p),
  post: (p, b) => call('POST', p, b),
  patch: (p, b) => call('PATCH', p, b),
  del: (p) => call('DELETE', p),
};

export function bytes(n) {
  const v = Number(n || 0);
  if (v === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(v) / Math.log(1024)), units.length - 1);
  const scaled = v / Math.pow(1024, i);
  return `${scaled >= 100 || i === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[i]}`;
}

export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
