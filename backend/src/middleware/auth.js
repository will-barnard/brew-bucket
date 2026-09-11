const jwt = require('jsonwebtoken');
const db = require('../db/pool');
const config = require('../config');
const keys = require('../services/keys');

// Two credentials reach this app and they are deliberately separate:
//   - a signed session cookie, for humans in the web UI
//   - an API key in X-API-Key / Authorization: Bearer, for machines
// Neither is accepted in place of the other.

function issueSession(res, user) {
  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    config.sessionSecret,
    { expiresIn: `${config.sessionTtlHours}h` }
  );
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    domain: config.cookieDomain,
    maxAge: config.sessionTtlHours * 3600 * 1000,
  });
}

function clearSession(res) {
  res.clearCookie(config.cookieName, { domain: config.cookieDomain });
}

// Populates req.actor for everything downstream. Never rejects on its own.
async function identify(req, _res, next) {
  req.actor = { userId: null, keyId: null, role: null, scopes: [], key: null };

  const raw = req.get('x-api-key')
    || (/^Bearer\s+(.+)$/i.exec(req.get('authorization') || '') || [])[1];

  if (raw) {
    try {
      const key = await keys.lookup(raw.trim());
      if (key) {
        req.actor = {
          userId: key.owner_id, keyId: key.id, role: 'key',
          scopes: key.scopes || [], key,
        };
        keys.touch(key.id, req.ip);
        return next();
      }
    } catch (err) { return next(err); }
    // A malformed or revoked key is an explicit failure, not an anonymous request.
    return next(Object.assign(new Error('invalid API key'), { status: 401 }));
  }

  const cookie = req.cookies && req.cookies[config.cookieName];
  if (cookie && config.sessionSecret) {
    try {
      const claims = jwt.verify(cookie, config.sessionSecret);
      const { rows } = await db.query('SELECT id, username, role, disabled FROM users WHERE id = $1', [claims.sub]);
      if (rows[0] && !rows[0].disabled) {
        req.actor = {
          userId: rows[0].id, keyId: null, role: rows[0].role,
          scopes: ['read', 'write', 'delete'].concat(rows[0].role === 'admin' ? ['admin'] : []),
          user: rows[0],
        };
      }
    } catch { /* expired or forged cookie: stay anonymous */ }
  }
  next();
}

function requireUser(req, _res, next) {
  if (!req.actor.userId || req.actor.role === 'key') {
    return next(Object.assign(new Error('sign in required'), { status: 401 }));
  }
  next();
}

function requireAdmin(req, _res, next) {
  if (req.actor.role !== 'admin') {
    return next(Object.assign(new Error('admin required'), { status: 403 }));
  }
  next();
}

// Scope check used by the object routes; works for both credential kinds.
function requireScope(scope) {
  return (req, _res, next) => {
    const bucketId = req.bucket ? req.bucket.id : null;
    if (req.actor.key) {
      if (!keys.keyAllows(req.actor.key, scope, bucketId)) {
        return next(Object.assign(new Error(`API key lacks "${scope}" on this bucket`), { status: 403 }));
      }
      return next();
    }
    if (req.actor.userId) {
      if (req.actor.role === 'readonly' && scope !== 'read') {
        return next(Object.assign(new Error('read-only account'), { status: 403 }));
      }
      return next();
    }
    return next(Object.assign(new Error('authentication required'), { status: 401 }));
  };
}

module.exports = { issueSession, clearSession, identify, requireUser, requireAdmin, requireScope };
