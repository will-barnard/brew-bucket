const db = require('../db/pool');

function log({ action, bucketId = null, objectKey = null, actor = {}, ip = null, bytes = null, ok = true, detail = null }) {
  // Fire-and-forget: an audit write must never fail a transfer.
  db.query(
    `INSERT INTO activity_log (action, bucket_id, object_key, user_id, key_id, ip, bytes, ok, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [action, bucketId, objectKey, actor.userId || null, actor.keyId || null, ip, bytes, ok, detail]
  ).catch((e) => console.error('[audit]', e.message));
}

function rollup({ bucketId, bytesIn = 0, bytesOut = 0, puts = 0, gets = 0 }) {
  if (!bucketId) return;
  db.query(
    `INSERT INTO usage_daily (day, bucket_id, bytes_in, bytes_out, puts, gets)
     VALUES (CURRENT_DATE, $1, $2, $3, $4, $5)
     ON CONFLICT (day, bucket_id) DO UPDATE SET
       bytes_in = usage_daily.bytes_in + EXCLUDED.bytes_in,
       bytes_out = usage_daily.bytes_out + EXCLUDED.bytes_out,
       puts = usage_daily.puts + EXCLUDED.puts,
       gets = usage_daily.gets + EXCLUDED.gets`,
    [bucketId, bytesIn, bytesOut, puts, gets]
  ).catch((e) => console.error('[usage]', e.message));
}

module.exports = { log, rollup };
