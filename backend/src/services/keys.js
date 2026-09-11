const crypto = require('crypto');
const db = require('../db/pool');

// Key format: bb_<prefix>_<secret>. Only sha256(full key) is stored, so a
// leaked database does not yield working credentials. The plaintext is
// returned exactly once, at creation.
function generate() {
  const prefix = crypto.randomBytes(4).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const plaintext = `bb_${prefix}_${secret}`;
  return { plaintext, prefix, hash: hashKey(plaintext) };
}

function hashKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

async function lookup(plaintext) {
  if (!plaintext || !plaintext.startsWith('bb_')) return null;
  const { rows } = await db.query(
    `SELECT * FROM api_keys WHERE secret_hash = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [hashKey(plaintext)]
  );
  return rows[0] || null;
}

function touch(id, ip) {
  db.query('UPDATE api_keys SET last_used_at = now(), last_used_ip = $2 WHERE id = $1', [id, ip])
    .catch(() => {});
}

function keyAllows(key, scope, bucketId) {
  if (!key) return false;
  const scopes = key.scopes || [];
  if (!scopes.includes(scope) && !scopes.includes('admin')) return false;
  if (key.bucket_ids && key.bucket_ids.length && bucketId && !key.bucket_ids.includes(bucketId)) return false;
  return true;
}

module.exports = { generate, hashKey, lookup, touch, keyAllows };
