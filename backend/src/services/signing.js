const crypto = require('crypto');
const config = require('../config');

// Presigned direct-to-NAS tokens. The control plane signs; the storage node
// verifies with the same secret and never calls back here to check.
// Payload is intentionally tiny and opaque: v1.<b64url(json)>.<b64url(sig)>
function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload, secret = config.directSecret) {
  if (!secret) throw new Error('DIRECT_URL_SECRET is not configured');
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `v1.${body}.${sig}`;
}

function verify(token, secret = config.directSecret) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[1]).digest('base64url');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

// op: 'get' | 'put'; hash: sha256 the node will read or must produce
function grant({ op, hash, size, ttl = config.directTtlSeconds }) {
  return sign({ op, hash, size, exp: Math.floor(Date.now() / 1000) + ttl });
}

module.exports = { sign, verify, grant };
