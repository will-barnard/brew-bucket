const db = require('../db/pool');
const nodes = require('./nodes');

// Object lifecycle over content-addressed blobs. Blobs are shared by hash and
// refcounted; an object delete only reaches the NAS when the last reference to
// that content goes away.

async function bucketUsage(bucketId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(size),0)::bigint AS bytes, COUNT(*)::int AS objects
       FROM objects WHERE bucket_id = $1 AND is_current`,
    [bucketId]
  );
  return { bytes: Number(rows[0].bytes), objects: rows[0].objects };
}

async function assertQuota(bucket, incomingBytes) {
  if (!bucket.quota_bytes) return;
  const { bytes } = await bucketUsage(bucket.id);
  if (bytes + incomingBytes > Number(bucket.quota_bytes)) {
    const err = new Error(`bucket "${bucket.slug}" quota exceeded`);
    err.status = 507;
    throw err;
  }
}

// Registers an already-uploaded blob as the current version of a key.
async function commitObject({ bucket, key, hash, size, nodeId, contentType, metadata, actor }) {
  return db.tx(async (client) => {
    await client.query(
      `INSERT INTO blobs (hash, node_id, size, refcount) VALUES ($1,$2,$3,0)
       ON CONFLICT (hash) DO NOTHING`,
      [hash, nodeId, size]
    );

    const prev = await client.query(
      `SELECT id, version, blob_hash FROM objects
        WHERE bucket_id = $1 AND key = $2 AND is_current FOR UPDATE`,
      [bucket.id, key]
    );

    const nextVersion = prev.rows[0] ? prev.rows[0].version + 1 : 1;

    if (prev.rows[0]) {
      if (bucket.versioning) {
        await client.query('UPDATE objects SET is_current = FALSE WHERE id = $1', [prev.rows[0].id]);
      } else {
        await client.query('DELETE FROM objects WHERE id = $1', [prev.rows[0].id]);
        await client.query('UPDATE blobs SET refcount = refcount - 1 WHERE hash = $1', [prev.rows[0].blob_hash]);
      }
    }

    const { rows } = await client.query(
      `INSERT INTO objects (bucket_id, key, version, blob_hash, size, content_type, metadata,
                            is_current, actor_user_id, actor_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9) RETURNING *`,
      [bucket.id, key, nextVersion, hash, size, contentType || 'application/octet-stream',
       metadata || {}, actor.userId || null, actor.keyId || null]
    );
    await client.query('UPDATE blobs SET refcount = refcount + 1 WHERE hash = $1', [hash]);
    return rows[0];
  });
}

async function getCurrent(bucketId, key) {
  const { rows } = await db.query(
    `SELECT o.*, b.node_id FROM objects o JOIN blobs b ON b.hash = o.blob_hash
      WHERE o.bucket_id = $1 AND o.key = $2 AND o.is_current`,
    [bucketId, key]
  );
  return rows[0] || null;
}

async function getVersion(bucketId, key, version) {
  const { rows } = await db.query(
    `SELECT o.*, b.node_id FROM objects o JOIN blobs b ON b.hash = o.blob_hash
      WHERE o.bucket_id = $1 AND o.key = $2 AND o.version = $3`,
    [bucketId, key, version]
  );
  return rows[0] || null;
}

async function deleteObject(bucketId, key, { allVersions = false } = {}) {
  const removed = await db.tx(async (client) => {
    const sel = allVersions
      ? await client.query('SELECT id, blob_hash FROM objects WHERE bucket_id=$1 AND key=$2 FOR UPDATE', [bucketId, key])
      : await client.query('SELECT id, blob_hash FROM objects WHERE bucket_id=$1 AND key=$2 AND is_current FOR UPDATE', [bucketId, key]);
    if (!sel.rows.length) return [];
    const ids = sel.rows.map((r) => r.id);
    await client.query('DELETE FROM objects WHERE id = ANY($1::bigint[])', [ids]);
    for (const row of sel.rows) {
      await client.query('UPDATE blobs SET refcount = refcount - 1 WHERE hash = $1', [row.blob_hash]);
    }
    if (!allVersions) {
      await client.query(
        `UPDATE objects SET is_current = TRUE WHERE id = (
           SELECT id FROM objects WHERE bucket_id=$1 AND key=$2 ORDER BY version DESC LIMIT 1)`,
        [bucketId, key]
      );
    }
    return sel.rows.map((r) => r.blob_hash);
  });
  return removed;
}

// Orphan blobs are swept separately rather than deleted inline, so a delete
// request never waits on the NAS and a crashed sweep is simply retried.
async function sweepOrphans(limit = 200) {
  const { rows } = await db.query(
    'SELECT hash, node_id FROM blobs WHERE refcount <= 0 ORDER BY created_at LIMIT $1', [limit]
  );
  let freed = 0;
  for (const blob of rows) {
    try {
      const node = await nodes.get(blob.node_id);
      if (node) await nodes.deleteBlob(node, blob.hash);
      await db.query('DELETE FROM blobs WHERE hash = $1 AND refcount <= 0', [blob.hash]);
      freed += 1;
    } catch (err) {
      console.error('[sweep]', blob.hash, err.message);
    }
  }
  return freed;
}

module.exports = {
  bucketUsage, assertQuota, commitObject, getCurrent, getVersion, deleteObject, sweepOrphans,
};
