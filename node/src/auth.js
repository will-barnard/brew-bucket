const crypto = require('crypto');
const config = require('./config');

// Internal requests from the control plane carry the shared secret.
function requireSecret(req, res, next) {
  const given = req.get('x-node-secret') || '';
  const expected = config.secret;
  if (!expected) return res.status(503).json({ error: 'node has no NODE_SHARED_SECRET configured' });
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'bad node secret' });
  }
  next();
}

// Direct transfers from LAN clients carry a token the control plane signed.
// The node never calls back to verify it — that is the whole point of the
// hybrid path — so the signature and the expiry are all there is.
function verifyToken(token) {
  if (!token || !config.directSecret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = crypto.createHmac('sha256', config.directSecret).update(parts[1]).digest('base64url');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function requireGrant(op) {
  return (req, res, next) => {
    if (!config.directEnabled) return res.status(403).json({ error: 'direct transfers are disabled on this node' });
    const payload = verifyToken(req.query.token);
    if (!payload) return res.status(401).json({ error: 'invalid or expired token' });
    if (payload.op !== op) return res.status(403).json({ error: `token is not valid for ${op}` });
    // The grant names one specific piece of content. A token for blob A can
    // never be replayed against blob B.
    if (payload.hash !== req.params.hash) return res.status(403).json({ error: 'token does not match this blob' });
    req.grant = payload;
    next();
  };
}

module.exports = { requireSecret, requireGrant, verifyToken };
