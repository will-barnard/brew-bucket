const db = require('../db/pool');
const storage = require('./storage');

// Lifecycle sweeper. Without this, `backups` grows until the NAS fills and
// every other bucket starts failing writes with no obvious cause.
async function runOnce() {
  const { rows: buckets } = await db.query(
    'SELECT * FROM buckets WHERE max_versions IS NOT NULL OR max_age_days IS NOT NULL'
  );
  let trimmed = 0;

  for (const bucket of buckets) {
    if (bucket.max_age_days) {
      const { rows } = await db.query(
        `SELECT DISTINCT key FROM objects
          WHERE bucket_id = $1 AND is_current AND created_at < now() - ($2 || ' days')::interval`,
        [bucket.id, bucket.max_age_days]
      );
      for (const r of rows) {
        await storage.deleteObject(bucket.id, r.key, { allVersions: true });
        trimmed += 1;
      }
    }

    if (bucket.max_versions) {
      const { rows } = await db.query(
        `SELECT id, blob_hash FROM (
           SELECT id, blob_hash, row_number() OVER (PARTITION BY key ORDER BY version DESC) AS rn
             FROM objects WHERE bucket_id = $1
         ) t WHERE rn > $2`,
        [bucket.id, bucket.max_versions]
      );
      for (const row of rows) {
        await db.tx(async (client) => {
          await client.query('DELETE FROM objects WHERE id = $1', [row.id]);
          await client.query('UPDATE blobs SET refcount = refcount - 1 WHERE hash = $1', [row.blob_hash]);
        });
        trimmed += 1;
      }
    }
  }

  const freed = await storage.sweepOrphans();
  if (trimmed || freed) console.log(`[retention] trimmed ${trimmed} objects, freed ${freed} blobs`);
  return { trimmed, freed };
}

module.exports = { runOnce };
