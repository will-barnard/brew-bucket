const crypto = require('crypto');
const db = require('../db/pool');

// Fire-and-forget notifications, signed like GitHub's: X-Brew-Signature is
// sha256=<hmac of the raw body>. Used by dry-dock to pick up build artifacts
// the moment they land rather than polling.
async function emit(event, bucket, payload) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM webhooks WHERE enabled AND $1 = ANY(events)
         AND (bucket_id IS NULL OR bucket_id = $2)`,
      [event, bucket.id]
    );
    if (!rows.length) return;
    const body = JSON.stringify({ event, bucket: bucket.slug, at: new Date().toISOString(), ...payload });

    for (const hook of rows) {
      const headers = { 'content-type': 'application/json', 'x-brew-event': event };
      if (hook.secret) {
        headers['x-brew-signature'] = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
      }
      fetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) })
        .then((r) => {
          if (!r.ok) return db.query('UPDATE webhooks SET last_error = $2 WHERE id = $1', [hook.id, `HTTP ${r.status}`]);
          return db.query('UPDATE webhooks SET last_error = NULL WHERE id = $1', [hook.id]);
        })
        .catch((e) => db.query('UPDATE webhooks SET last_error = $2 WHERE id = $1', [hook.id, e.message]).catch(() => {}));
    }
  } catch (err) {
    console.error('[webhook]', err.message);
  }
}

module.exports = { emit };
