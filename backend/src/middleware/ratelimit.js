// Deliberately in-process and approximate. One replica, one owner: a shared
// store would be more machinery than the threat justifies.
const buckets = new Map();

function rateLimit({ windowMs = 60000, max = 120, key } = {}) {
  return (req, res, next) => {
    const id = key ? key(req) : (req.actor && req.actor.keyId ? `k${req.actor.keyId}` : req.ip);
    const now = Date.now();
    let entry = buckets.get(id);
    if (!entry || entry.reset < now) entry = { count: 0, reset: now + windowMs };
    entry.count += 1;
    buckets.set(id, entry);
    res.set('x-ratelimit-remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      return next(Object.assign(new Error('rate limit exceeded'), { status: 429 }));
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
}, 60000).unref();

module.exports = { rateLimit };
